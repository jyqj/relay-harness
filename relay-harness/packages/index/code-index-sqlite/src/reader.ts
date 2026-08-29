/**
 * Read-side retrieval face of the derived SQLite store: an implementation of
 * the search package's {@link https://github.com/jyqj/relay-harness/blob/master/packages/index/code-index-search/src/port.ts | RetrievalPort}
 * over raw SQL.
 *
 * Ported from the reference implementation's retrieval read model
 * (`cc-db/src/index_db_retrieval.rs`): bm25-ordered FTS matching, scope
 * filters rendered as SQL instead of post-filters, recency-ordered grep scans
 * (`rowid DESC`) whose budget stays entirely on the caller side, and lazy
 * decoding so only visited rows pay for it — every decoded text flows through
 * the {@link ./cache.ts!ChunkTextCache | ChunkTextCache}, so repeated greps
 * never re-decode a live chunk.
 *
 * Two deliberate adaptations to this schema: language lives on the `files`
 * row, so chunk-level queries join it rather than reading a `chunks.language`
 * column; and the graph face lives in {@link createGraphReadFacet}, which
 * reads the v2 graph tables directly — `symbols_fts` seeds symbol candidates
 * through trigram LIKE, per-seed edge caps run as window functions, and every
 * id list is batched and deduplicated before it reaches SQL.
 *
 * @module @relay-harness/rlh-code-index-sqlite/reader
 */

import type { DatabaseSync } from 'node:sqlite'
import type { ParserTier } from '@relay-harness/rlh-code-index'
import type {
  AnalysisSymbolRow,
  CalleeEdgeRow,
  CallerEdgeRow,
  CatalogSymbolRow,
  ChunkDetailRow,
  ChunkScope,
  ChunkScanVisitor,
  ChunkSpanRow,
  ExportFingerprintRow,
  FileSummaryHit,
  GraphReadFacet,
  ImpactedTestRow,
  ImportRow,
  InternalImportEdgeRow,
  LexicalCandidateRow,
  LiteralCandidateRow,
  LiteralRow,
  RetrievalPort,
  StoredCallEdgeRow,
  StoredSymbolRefRow,
  SymbolDegreeRow,
  SymbolRowLite,
  SymbolSeedHit,
  SymbolTokenHit,
  VectorCoverage,
  VectorRow,
  VectorRecallRequest,
  VectorRecallResult,
} from '@relay-harness/rlh-code-index-search'
import { compareStrings, cosineQuantized } from '@relay-harness/rlh-code-index-search'
import { readEpochs } from './epoch.ts'
import { ChunkTextCache, chunkCacheKey, chunkTextCacheCapacityForTier } from './cache.ts'
import { CODE_INDEX_METADATA_EXPORT_FINGERPRINT_PREFIX } from './ddl.ts'
import { decodeChunkText } from './codec.ts'

/** Batch size for `IN (...)` id lists, matching the writer's variable budget. */
const SQL_IN_BATCH_SIZE = 200

/** Options accepted by {@link createRetrievalPort}. */
export interface CreateRetrievalPortOptions {
  /**
   * Decoded-text cache shared by every read method. Defaults to a
   * package-private instance sized by {@link chunkTextCacheCapacityForTier}
   * at the largest tier until the provider wires a tier-resolved one (PR 1.5).
   */
  readonly cache?: ChunkTextCache
}

/** WHERE fragments plus their positional bind values accumulated for one query. */
interface ScopeFilter {
  readonly clauses: readonly string[]
  readonly params: ReadonlyArray<string | number>
}

/** Escape SQL LIKE metacharacters so user-derived tokens match literally. */
function escapeLike(text: string): string {
  let escaped = ''
  for (const character of text) {
    if (character === '\\' || character === '%' || character === '_') escaped += '\\'
    escaped += character
  }
  return escaped
}

/** Render `?` placeholders matching a batch length for positional binding. */
function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ')
}

/** Iterate an id list in SQL-variable-sized batches for `IN (...)` statements. */
function* inBatches(values: readonly string[]): Generator<readonly string[]> {
  for (let start = 0; start < values.length; start += SQL_IN_BATCH_SIZE) {
    yield values.slice(start, start + SQL_IN_BATCH_SIZE)
  }
}

/** Deduplicate and sort an id list so batches stay minimal and deterministic. */
function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

/**
 * Informational seed-match quality: `1` for a case-insensitive exact match,
 * decaying toward `0` with the extra characters the name carries beyond the
 * token. Ordering is already decided in SQL; this only annotates rows.
 */
function seedHitScore(name: string, token: string): number {
  if (name.toLowerCase() === token.toLowerCase()) return 1
  return 1 / (1 + Math.max(0, name.length - token.length))
}

/** True when the scope dimension carries an actual restriction, not its null-ish "off" marker. */
function isActive(values: readonly string[] | null | undefined): boolean {
  return values != null && values.length > 0
}

/** Whether the scope pins an explicit file set, which bounds scan cardinality. */
function hasFileScope(scope: ChunkScope): boolean {
  return isActive(scope.filePaths)
}

/**
 * Translate the structured scope into SQL: `pathPrefix` becomes a trailing
 * `%` LIKE and `filePaths` an IN list, metacharacters escaped throughout;
 * `''` / `[]` mean "unrestricted" exactly like their `null` markers.
 * @param scope - the structured scope to compile.
 * @param filePathColumn - qualified column the path clauses test; chunk-level
 *   queries default to the `chunks` join, literal queries pass their
 *   `literal_index` alias.
 */
function scopeFilter(scope: ChunkScope, filePathColumn = 'chunks.file_path'): ScopeFilter {
  const clauses: string[] = []
  const params: Array<string | number> = []
  if (typeof scope.pathPrefix === 'string' && scope.pathPrefix.length > 0) {
    clauses.push(`${filePathColumn} LIKE ? ESCAPE '\\'`)
    params.push(`${escapeLike(scope.pathPrefix)}%`)
  }
  if (scope.languages !== null && scope.languages.length > 0) {
    clauses.push(`files.language IN (${scope.languages.map(() => '?').join(', ')})`)
    params.push(...scope.languages)
  }
  if (scope.filePaths !== null && scope.filePaths.length > 0) {
    clauses.push(`${filePathColumn} IN (${scope.filePaths.map(() => '?').join(', ')})`)
    params.push(...scope.filePaths)
  }
  return { clauses, params }
}

/** Append the compiled scope after the base predicate, keeping them joined by AND. */
function appendScope(sql: string, filter: ScopeFilter): string {
  if (filter.clauses.length === 0) return sql
  return `${sql} AND ${filter.clauses.join(' AND ')}`
}

/**
 * Bind a retrieval port to one admitted database handle.
 *
 * Every method may reject on storage failure; the search engine converts
 * rejections into lane degradation, so nothing here swallows errors. Decode
 * cost follows visitor demand in the scan methods and candidate survival in
 * {@link chunkRowsByIds}, per the division of responsibilities documented on
 * the port.
 * @param db - admitted handle already carrying the schema.
 * @param options - cache wiring; see {@link CreateRetrievalPortOptions}.
 * @returns the read-only retrieval adapter consumed by `createSearchEngine`.
 */
export function createRetrievalPort(
  db: DatabaseSync,
  options: CreateRetrievalPortOptions = {},
): RetrievalPort {
  const cache = options.cache ?? new ChunkTextCache(chunkTextCacheCapacityForTier('large'))

  /**
   * Decode one `(text_encoding, text)` pair under a cache slot keyed by the
   * current epoch and the base-table rowid; only rows a visitor actually
   * reaches reach this point.
   */
  function decodeText(rowid: number, encoding: string, payload: string): string {
    const epochs = readEpochs(db)
    const key = chunkCacheKey(epochs.indexEpoch, rowid)
    const cached = cache.get(key)
    if (cached !== undefined) return cached
    const text = decodeChunkText(encoding, payload)
    cache.setIfFresh(key, text, epochs)
    return text
  }

  function countFiles(): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }).n
  }

  function filePathCandidatesBySubstring(token: string, pathPrefix: string | null, limit: number): readonly string[] {
    const clauses = ['file_path LIKE ? ESCAPE \'\\\'']
    const params: Array<string | number> = [`%${escapeLike(token)}%`]
    if (pathPrefix !== null && pathPrefix.length > 0) {
      clauses.push('file_path LIKE ? ESCAPE \'\\\'')
      params.push(`${escapeLike(pathPrefix)}%`)
    }
    params.push(limit)
    return (db.prepare(
      `SELECT file_path FROM file_paths_fts WHERE ${clauses.join(' AND ')} ORDER BY file_path LIMIT ?`,
    ).all(...params) as Array<{ file_path: string }>).map(row => row.file_path)
  }

  // The v2 symbol tier answers preselect layer 6b: trigram LIKE narrows the
  // candidates, then case-insensitive exactness leads and shorter names follow.
  function symbolNamesByTokenSubstring(token: string, pathPrefix: string | null, limit: number): readonly SymbolTokenHit[] {
    const clauses = ['f.name LIKE ? ESCAPE \'\\\'']
    const params: Array<string | number> = [`%${escapeLike(token)}%`]
    if (pathPrefix !== null && pathPrefix.length > 0) {
      clauses.push('s.file_path LIKE ? ESCAPE \'\\\'')
      params.push(`${escapeLike(pathPrefix)}%`)
    }
    params.push(token, limit)
    return db.prepare(
      'SELECT s.file_path AS filePath, f.name AS name '
      + 'FROM symbols_fts f JOIN symbols s ON s.rowid = f.rowid '
      + `WHERE ${clauses.join(' AND ')} `
      + 'ORDER BY lower(f.name) = lower(?) DESC, length(f.name) ASC '
      + 'LIMIT ?',
    ).all(...params) as unknown as Array<SymbolTokenHit>
  }

  function ftsFileSummaries(matchExpr: string, pathPrefix: string | null, limit: number): readonly FileSummaryHit[] {
    const clauses = ['files_fts MATCH ?']
    const params: Array<string | number> = [matchExpr]
    if (pathPrefix !== null && pathPrefix.length > 0) {
      clauses.push('files.file_path LIKE ? ESCAPE \'\\\'')
      params.push(`${escapeLike(pathPrefix)}%`)
    }
    params.push(limit)
    return db.prepare(
      'SELECT files.file_path AS filePath, bm25(files_fts, 1.8, 1.0) AS rawScore '
      + 'FROM files_fts JOIN files ON files.file_path = files_fts.file_path '
      + `WHERE ${clauses.join(' AND ')} ORDER BY rawScore LIMIT ?`,
    ).all(...params) as unknown as Array<FileSummaryHit>
  }

  function recentIndexedFiles(limit: number): readonly string[] {
    return (db.prepare(
      'SELECT file_path FROM files ORDER BY indexed_at DESC LIMIT ?',
    ).all(limit) as Array<{ file_path: string }>).map(row => row.file_path)
  }

  function ftsChunkCandidates(matchExpr: string, scope: ChunkScope, limit: number): readonly LexicalCandidateRow[] {
    const filter = scopeFilter(scope)
    const sql = appendScope(
      'SELECT chunks.chunk_id AS chunkId, chunks.file_path AS filePath, files.language AS languageName, '
      + 'bm25(chunks_fts, 1.0, 1.0, 2.0) AS score '
      + 'FROM chunks_fts '
      + 'JOIN chunks ON chunks.rowid = chunks_fts.rowid '
      + 'JOIN files ON files.file_path = chunks.file_path '
      + 'WHERE chunks_fts MATCH ?',
      filter,
    )
    return db.prepare(
      `${sql} ORDER BY score LIMIT ?`,
    ).all(matchExpr, ...filter.params, limit) as unknown as Array<LexicalCandidateRow>
  }

  // The literal mirror answers the search package's literal lane: bm25-ordered
  // literal_index rows whose literal/kind FTS columns match, scoped exactly
  // like the chunk queries (the scope's path clauses test the literal_index
  // alias, language still routes through files).
  function literalFtsCandidates(matchExpr: string, scope: ChunkScope, limit: number): readonly LiteralCandidateRow[] {
    const filter = scopeFilter(scope, 'li.file_path')
    const sql = appendScope(
      'SELECT li.literal_id AS literalId, li.file_path AS filePath, li.literal AS literal, '
      + 'li.literal_kind AS literalKind, li.line AS line, li.container AS container, '
      + 'bm25(literal_fts, 1.0, 1.0) AS rank '
      + 'FROM literal_fts '
      + 'JOIN literal_index li ON li.rowid = literal_fts.rowid '
      + 'JOIN files ON files.file_path = li.file_path '
      + 'WHERE literal_fts MATCH ?',
      filter,
    )
    return db.prepare(
      `${sql} ORDER BY rank LIMIT ?`,
    ).all(matchExpr, ...filter.params, limit) as unknown as Array<LiteralCandidateRow>
  }

  function scanChunksForGrepPrefiltered(
    phrase: string,
    scanCap: number,
    scope: ChunkScope,
    visit: ChunkScanVisitor,
  ): void {
    const filter = scopeFilter(scope)
    const sql = appendScope(
      'SELECT chunks.chunk_id AS chunkId, chunks.file_path AS filePath, files.language AS languageName, '
      + 'chunks.text AS text, chunks.text_encoding AS textEncoding, chunks.rowid AS rowid '
      + 'FROM chunks_fts '
      + 'JOIN chunks ON chunks.rowid = chunks_fts.rowid '
      + 'JOIN files ON files.file_path = chunks.file_path '
      + 'WHERE chunks_fts MATCH ?',
      filter,
    )
    runScan(sql, [phrase, ...filter.params], scanCap, visit, null)
  }

  function scanChunksForGrep(
    scope: ChunkScope,
    skipChunkIds: ReadonlySet<string> | null,
    visit: ChunkScanVisitor,
  ): void {
    const filter = scopeFilter(scope)
    let sql = 'SELECT chunks.chunk_id AS chunkId, chunks.file_path AS filePath, files.language AS languageName, '
      + 'chunks.text AS text, chunks.text_encoding AS textEncoding, chunks.rowid AS rowid '
      + 'FROM chunks '
      + 'JOIN files ON files.file_path = chunks.file_path'
    const clauses: string[] = []
    const params: Array<string | number> = []
    if (filter.clauses.length > 0) {
      clauses.push(...filter.clauses)
      params.push(...filter.params)
    }
    if (clauses.length > 0) sql += ` WHERE ${clauses.join(' AND ')}`
    // Recency order serves only open-ended walks: a pinned file set is already
    // cardinality-bounded, so SQLite's natural probe order stands there.
    if (!hasFileScope(scope)) sql += ' ORDER BY chunks.rowid DESC'
    runScan(sql, params, null, visit, skipChunkIds)
  }

  function chunkRowsByIds(chunkIds: readonly string[]): readonly ChunkDetailRow[] {
    const details: ChunkDetailRow[] = []
    for (let start = 0; start < chunkIds.length; start += SQL_IN_BATCH_SIZE) {
      const batch = chunkIds.slice(start, start + SQL_IN_BATCH_SIZE)
      const placeholders = batch.map(() => '?').join(', ')
      const rows = db.prepare(
        'SELECT chunks.chunk_id AS chunkId, chunks.file_path AS filePath, files.language AS languageName, '
        + 'files.content_hash AS contentHash, files.parser_tier AS parserTier, '
        + 'files.parser_confidence AS parserConfidence, '
        + 'chunks.start_line AS startLine, chunks.end_line AS endLine, chunks.breadcrumb AS breadcrumb, '
        + 'chunks.symbol_name AS symbolName, chunks.symbol_kind AS symbolKind, '
        + 'chunks.text AS text, chunks.text_encoding AS textEncoding, chunks.rowid AS rowid '
        + 'FROM chunks JOIN files ON files.file_path = chunks.file_path '
        + `WHERE chunks.chunk_id IN (${placeholders})`,
      ).all(...batch) as Array<Record<string, string | number | null>>
      for (const row of rows) {
        details.push({
          chunkId: row.chunkId as string,
          filePath: row.filePath as string,
          languageName: row.languageName as string,
          contentHash: row.contentHash as string,
          startLine: row.startLine as number,
          endLine: row.endLine as number,
          breadcrumb: row.breadcrumb as string,
          symbolName: row.symbolName as string | null,
          symbolKind: row.symbolKind as string | null,
          text: decodeText(row.rowid as number, row.textEncoding as string, row.text as string),
          parserTier: row.parserTier as ParserTier,
          parserConfidence: row.parserConfidence as number,
        })
      }
    }
    return details
  }

  // The vector tier answers the search package's vector lane: int8 BLOBs read
  // back byte-identical (`node:sqlite` surfaces plain Uint8Array), so
  // `cosineQuantized` scores them without a dequantized copy. Rows are keyed
  // `(chunk_id, generation_id)`; every read filters to one complete generation.
  function vectorsByChunkIds(chunkIds: readonly string[], generationOrModel: string): readonly VectorRow[] {
    const rows: VectorRow[] = []
    for (const batch of inBatches(sortedUnique(chunkIds))) {
      const found = db.prepare(
        'SELECT chunk_id AS chunkId, chunk_rowid AS rowid, q, scale, norm, dim '
        + `FROM chunks_vec WHERE (generation_id = ? OR model = ?) AND chunk_id IN (${placeholders(batch.length)}) `
        + 'ORDER BY chunk_id ASC',
      ).all(generationOrModel, generationOrModel, ...batch) as Array<{
        chunkId: string
        rowid: number
        q: Uint8Array
        scale: number
        norm: number
        dim: number
      }>
      for (const row of found) {
        rows.push({ chunkId: row.chunkId, rowid: row.rowid, q: row.q, scale: row.scale, norm: row.norm, dim: row.dim })
      }
    }
    return rows
  }

  /** Bounded exact cosine scan implementing the future-ANN adapter seam. */
  function recallCandidates(request: VectorRecallRequest): VectorRecallResult {
    const filter = scopeFilter(request.scope, 'c.file_path')
    const sql = appendScope(
      'SELECT c.chunk_id AS chunkId, v.q, v.scale, v.norm, v.dim '
      + 'FROM chunks_vec v JOIN chunks c ON c.chunk_id = v.chunk_id '
      + 'JOIN files ON files.file_path = c.file_path '
      + 'WHERE v.generation_id = ?',
      filter,
    ) + ' ORDER BY c.chunk_id ASC LIMIT ?'
    const rows = db.prepare(sql).all(
      request.generationId,
      ...filter.params,
      request.maxScan + 1,
    ) as Array<{ chunkId: string; q: Uint8Array; scale: number; norm: number; dim: number }>
    const truncated = rows.length > request.maxScan
    const scannedRows = truncated ? rows.slice(0, request.maxScan) : rows
    const hits = scannedRows.flatMap((row) => {
      const score = cosineQuantized(request.queryVector, row.q, row.scale, row.norm)
      return score > 0 ? [{ chunkId: row.chunkId, score }] : []
    })
    hits.sort((left, right) => right.score - left.score || compareStrings(left.chunkId, right.chunkId))
    return { hits: hits.slice(0, request.topK), scanned: scannedRows.length, truncated }
  }

  /**
   * Stream one scan statement row by row: skipped ids pass before any decode
   * cost, each reached row decodes at most once (cache consulted first), and
   * the visitor's `false` stops iteration immediately.
   *
   * `scanCap` is supplied only by the prefiltered stage, whose SQL ends in the
   * caller's cap as LIMIT; the full scan imposes none here because the scan
   * budget belongs to the caller (see the port's responsibility contract).
   */
  function runScan(
    sql: string,
    params: ReadonlyArray<string | number>,
    scanCap: number | null,
    visit: ChunkScanVisitor,
    skipChunkIds: ReadonlySet<string> | null,
  ): void {
    const finalSql = scanCap === null ? sql : `${sql} LIMIT ?`
    const bind = scanCap === null ? params : [...params, scanCap]
    for (const row of db.prepare(finalSql).iterate(...bind) as Iterable<Record<string, unknown>>) {
      if (skipChunkIds?.has(row.chunkId as string) === true) continue
      const keepGoing = visit({
        rowid: row.rowid as number,
        chunkId: row.chunkId as string,
        filePath: row.filePath as string,
        languageName: row.languageName as string,
        text: decodeText(row.rowid as number, row.textEncoding as string, row.text as string),
      })
      if (!keepGoing) break
    }
  }

  return {
    countFiles,
    filePathCandidatesBySubstring,
    symbolNamesByTokenSubstring,
    ftsFileSummaries,
    recentIndexedFiles,
    ftsChunkCandidates,
    literalFtsCandidates,
    scanChunksForGrepPrefiltered,
    scanChunksForGrep,
    chunkRowsByIds,
    vector: {
      vectorsByChunkIds,
      vectorCoverage: model => readVectorCoverage(db, model),
      recallCandidates,
    },
    graph: createGraphReadFacet(db),
  }
}

/**
 * Read one embedding model's chunk-tier coverage counts: how many of the
 * index's chunk rows carry a stored vector for the model. Exported beside the
 * port so providers can project the numbers into status surfaces without
 * borrowing the retrieval port's graph face.
 * @param db - admitted handle already carrying the schema.
 * @param generationOrModel - complete generation id, with model retained for legacy direct callers.
 * @returns the coverage pair.
 */
export function readVectorCoverage(db: DatabaseSync, generationOrModel: string): VectorCoverage {
  // The scalar subqueries always answer exactly one row.
  const row = db.prepare(
    'SELECT (SELECT COUNT(*) FROM chunks) AS totalChunks, '
    + '(SELECT COUNT(*) FROM chunks_vec WHERE generation_id = ? OR model = ?) AS vectorizedChunks',
  ).get(generationOrModel, generationOrModel) as { totalChunks: number; vectorizedChunks: number }
  return { vectorizedChunks: row.vectorizedChunks, totalChunks: row.totalChunks }
}

/** Project one `symbols` row onto the port's lite symbol view. */
function toSymbolRowLite(row: Record<string, string | number | null>): SymbolRowLite {
  return {
    symbolId: row.symbolId as string,
    symbolUid: row.symbolUid as string | null,
    name: row.name as string,
    kind: row.kind as string,
    filePath: row.filePath as string,
    container: row.container as string | null,
    startLine: row.startLine as number,
    endLine: row.endLine as number,
    qname: row.qname as string | null,
    signature: row.signature as string | null,
  }
}

const SYMBOL_LITE_COLUMNS = 'symbol_id AS symbolId, symbol_uid AS symbolUid, name, kind, '
  + 'file_path AS filePath, container, start_line AS startLine, end_line AS endLine, '
  + 'qname, signature'

/** The lite projection plus the resolution-registration columns the catalog loader consumes. */
const SYMBOL_CATALOG_COLUMNS = `${SYMBOL_LITE_COLUMNS}, export_name AS exportName, `
  + 'is_default_export AS isDefaultExport, receiver_type AS receiverType, param_count AS paramCount, '
  + 'base_types AS baseTypes, implements AS implements'

/**
 * Bind the graph read facet to one admitted database handle.
 *
 * The facet implements the search package's {@link GraphReadFacet} over the
 * v2 graph tables: seeds come from `symbols_fts` trigram LIKE with
 * case-insensitive exactness leading, per-seed edge caps run as
 * `ROW_NUMBER() OVER (PARTITION BY seed ORDER BY line, rowid)` windows, every
 * id list is deduplicated, sorted, and batched through `IN (...)`, and all
 * orders are fully deterministic so explore answers stay replayable.
 * @param db - admitted handle already carrying the schema.
 * @returns the read-only graph adapter consumed by graph exploration.
 */
export function createGraphReadFacet(db: DatabaseSync): GraphReadFacet {
  function symbolSeedHits(token: string, limit: number): readonly SymbolSeedHit[] {
    const rows = db.prepare(
      'SELECT s.symbol_uid AS symbolUid, f.name AS name '
      + 'FROM symbols_fts f JOIN symbols s ON s.rowid = f.rowid '
      + 'WHERE f.name LIKE ? ESCAPE \'\\\' '
      + 'ORDER BY lower(f.name) = lower(?) DESC, length(f.name) ASC, f.name ASC '
      + 'LIMIT ?',
    ).all(`%${escapeLike(token)}%`, token, limit) as Array<{ symbolUid: string | null; name: string }>
    return rows.map(row => ({
      symbolUid: row.symbolUid ?? '',
      name: row.name,
      score: seedHitScore(row.name, token),
    }))
  }

  function symbolUidsByExactNames(names: readonly string[], limit: number): readonly SymbolRowLite[] {
    const rows: SymbolRowLite[] = []
    for (const batch of inBatches(sortedUnique(names))) {
      if (rows.length >= limit) break
      const found = db.prepare(
        `SELECT ${SYMBOL_LITE_COLUMNS} FROM symbols WHERE name IN (${placeholders(batch.length)}) `
        + 'ORDER BY name ASC, rowid ASC',
      ).all(...batch) as Array<Record<string, string | number | null>>
      for (const row of found) rows.push(toSymbolRowLite(row))
    }
    return rows.slice(0, limit)
  }

  function callEdgeRowsBySide(seedColumn: 'caller_symbol_uid' | 'callee_symbol_uid', uids: readonly string[], limit: number): readonly CallerEdgeRow[] {
    const rows: CallerEdgeRow[] = []
    for (const batch of inBatches(sortedUnique(uids))) {
      const found = db.prepare(
        'SELECT seedUid, filePath, line, callerSymbol, calleeSymbol, callerSymbolUid, calleeSymbolUid, '
        + 'resolutionKind, dispatchKind, callKind, resolutionStrategy, resolutionConfidence FROM ('
        + `SELECT e.${seedColumn} AS seedUid, e.file_path AS filePath, e.line AS line, `
        + 'e.caller_symbol AS callerSymbol, e.callee_symbol AS calleeSymbol, '
        + 'e.caller_symbol_uid AS callerSymbolUid, e.callee_symbol_uid AS calleeSymbolUid, '
        + 'e.resolution_kind AS resolutionKind, e.dispatch_kind AS dispatchKind, e.call_kind AS callKind, '
        + 'e.resolution_strategy AS resolutionStrategy, e.resolution_confidence AS resolutionConfidence, '
        + 'e.rowid AS edgeRowid, '
        + `ROW_NUMBER() OVER (PARTITION BY e.${seedColumn} ORDER BY e.line ASC, e.rowid ASC) AS rn `
        + `FROM call_edges e WHERE e.${seedColumn} IN (${placeholders(batch.length)})) `
        + 'WHERE rn <= ? ORDER BY seedUid ASC, line ASC, edgeRowid ASC',
      ).all(...batch, limit) as unknown as Array<CallerEdgeRow>
      rows.push(...found)
    }
    return rows
  }

  function symbolRowsByUids(uids: readonly string[]): readonly SymbolRowLite[] {
    const rows: SymbolRowLite[] = []
    for (const batch of inBatches(sortedUnique(uids))) {
      const found = db.prepare(
        `SELECT ${SYMBOL_LITE_COLUMNS} FROM symbols WHERE symbol_uid IN (${placeholders(batch.length)}) `
        + 'ORDER BY file_path ASC, start_line ASC, rowid ASC',
      ).all(...batch) as Array<Record<string, string | number | null>>
      for (const row of found) rows.push(toSymbolRowLite(row))
    }
    return rows
  }

  function symbolDegreeDetailsBatch(uids: readonly string[]): readonly SymbolDegreeRow[] {
    const wanted = sortedUnique(uids)
    const outDegrees = new Map<string, number>()
    const inDegrees = new Map<string, number>()
    const refCounts = new Map<string, number>()
    for (const batch of inBatches(wanted)) {
      const outRows = db.prepare(
        'SELECT caller_symbol_uid AS uid, COUNT(DISTINCT callee_symbol_uid) AS n FROM call_edges '
        + `WHERE caller_symbol_uid IN (${placeholders(batch.length)}) GROUP BY caller_symbol_uid`,
      ).all(...batch) as Array<{ uid: string; n: number }>
      const inRows = db.prepare(
        'SELECT callee_symbol_uid AS uid, COUNT(DISTINCT caller_symbol_uid) AS n FROM call_edges '
        + `WHERE callee_symbol_uid IN (${placeholders(batch.length)}) GROUP BY callee_symbol_uid`,
      ).all(...batch) as Array<{ uid: string; n: number }>
      const refRows = db.prepare(
        'SELECT target_symbol_uid AS uid, COUNT(*) AS n FROM symbol_refs '
        + `WHERE target_symbol_uid IN (${placeholders(batch.length)}) GROUP BY target_symbol_uid`,
      ).all(...batch) as Array<{ uid: string; n: number }>
      for (const row of outRows) outDegrees.set(row.uid, row.n)
      for (const row of inRows) inDegrees.set(row.uid, row.n)
      for (const row of refRows) refCounts.set(row.uid, row.n)
    }
    return wanted.map(symbolUid => ({
      symbolUid,
      inDegree: inDegrees.get(symbolUid) ?? 0,
      outDegree: outDegrees.get(symbolUid) ?? 0,
      refCount: refCounts.get(symbolUid) ?? 0,
    }))
  }

  function chunkSpansForFiles(files: readonly string[]): readonly ChunkSpanRow[] {
    const rows: ChunkSpanRow[] = []
    for (const batch of inBatches(sortedUnique(files))) {
      const found = db.prepare(
        'SELECT file_path AS filePath, chunk_id AS chunkId, start_line AS startLine, end_line AS endLine '
        + `FROM chunks WHERE file_path IN (${placeholders(batch.length)}) `
        + 'ORDER BY file_path ASC, chunk_index ASC',
      ).all(...batch) as unknown as Array<ChunkSpanRow>
      rows.push(...found)
    }
    return rows
  }

  function symbolsByFilePaths(files: readonly string[]): readonly CatalogSymbolRow[] {
    const rows: CatalogSymbolRow[] = []
    for (const batch of inBatches(sortedUnique(files))) {
      const found = db.prepare(
        `SELECT ${SYMBOL_CATALOG_COLUMNS} FROM symbols WHERE file_path IN (${placeholders(batch.length)}) `
        + 'ORDER BY file_path ASC, start_line ASC, rowid ASC',
      ).all(...batch) as Array<Record<string, string | number | null>>
      for (const row of found) {
        rows.push({
          ...toSymbolRowLite(row),
          exportName: row.exportName as string | null,
          isDefaultExport: row.isDefaultExport === 1,
          receiverType: row.receiverType as string | null,
          paramCount: row.paramCount as number | null,
          baseTypes: row.baseTypes as string | null,
          implements: row.implements as string | null,
          // The schema stores no scope column; scopes stay a resolver-side
          // interface for the reference-parity step.
          scopeId: null,
        })
      }
    }
    return rows
  }

  /**
   * Batch-read one edge table's full reload view per file path. `selectSql`
   * is the table's aliased-column `SELECT ... FROM <table>` prefix; the
   * shared WHERE/ORDER BY appends the file filter in store insertion order.
   */
  function edgeRowsByFilePaths<Row>(
    files: readonly string[],
    selectSql: string,
    project: (row: Record<string, string | number | null>) => Row,
  ): readonly Row[] {
    const rows: Row[] = []
    for (const batch of inBatches(sortedUnique(files))) {
      const found = db.prepare(
        `${selectSql} WHERE file_path IN (${placeholders(batch.length)}) `
        + 'ORDER BY file_path ASC, rowid ASC',
      ).all(...batch) as Array<Record<string, string | number | null>>
      for (const row of found) rows.push(project(row))
    }
    return rows
  }

  function callEdgesByFilePaths(files: readonly string[]): readonly StoredCallEdgeRow[] {
    return edgeRowsByFilePaths(files, (
      'SELECT edge_id AS edgeId, file_path AS filePath, caller_symbol AS callerSymbol, callee_symbol AS calleeSymbol, '
      + 'line, start_col AS startCol, target_symbol_id AS targetSymbolId, target_file_path AS targetFilePath, '
      + 'caller_symbol_id AS callerSymbolId, caller_symbol_uid AS callerSymbolUid, callee_symbol_uid AS calleeSymbolUid, '
      + 'dispatch_kind AS dispatchKind, call_kind AS callKind, resolution_kind AS resolutionKind, '
      + 'resolution_confidence AS resolutionConfidence, resolution_strategy AS resolutionStrategy, '
      + 'receiver_expr AS receiverExpr, arg_count AS argCount, is_optional_chain AS isOptionalChain, '
      + 'is_awaited AS isAwaited, is_constructor AS isConstructor, parser_tier AS parserTier, '
      + 'parser_confidence AS parserConfidence FROM call_edges'
    ), row => ({
      edgeId: row.edgeId as string,
      filePath: row.filePath as string,
      callerSymbol: row.callerSymbol as string | null,
      calleeSymbol: row.calleeSymbol as string | null,
      line: row.line as number | null,
      startCol: row.startCol as number | null,
      targetSymbolId: row.targetSymbolId as string | null,
      targetFilePath: row.targetFilePath as string | null,
      callerSymbolId: row.callerSymbolId as string | null,
      callerSymbolUid: row.callerSymbolUid as string | null,
      calleeSymbolUid: row.calleeSymbolUid as string | null,
      dispatchKind: row.dispatchKind as string | null,
      callKind: row.callKind as string | null,
      resolutionKind: row.resolutionKind as string | null,
      resolutionConfidence: row.resolutionConfidence as number | null,
      resolutionStrategy: row.resolutionStrategy as string | null,
      receiverExpr: row.receiverExpr as string | null,
      argCount: row.argCount as number | null,
      isOptionalChain: row.isOptionalChain === 1,
      isAwaited: row.isAwaited === 1,
      isConstructor: row.isConstructor === 1,
      parserTier: row.parserTier as ParserTier | null,
      parserConfidence: row.parserConfidence as number | null,
    }))
  }

  function symbolRefsByFilePaths(files: readonly string[]): readonly StoredSymbolRefRow[] {
    return edgeRowsByFilePaths(files, (
      'SELECT ref_id AS refId, file_path AS filePath, symbol_name AS symbolName, container, ref_kind AS refKind, '
      + 'line, col, target_symbol_id AS targetSymbolId, target_file_path AS targetFilePath, '
      + 'target_symbol_uid AS targetSymbolUid, ref_name AS refName, resolution_kind AS resolutionKind, '
      + 'resolution_confidence AS resolutionConfidence, resolution_strategy AS resolutionStrategy, '
      + 'parser_tier AS parserTier, parser_confidence AS parserConfidence FROM symbol_refs'
    ), row => ({
      refId: row.refId as string,
      filePath: row.filePath as string,
      symbolName: row.symbolName as string | null,
      container: row.container as string | null,
      refKind: row.refKind as string | null,
      line: row.line as number | null,
      col: row.col as number | null,
      targetSymbolId: row.targetSymbolId as string | null,
      targetFilePath: row.targetFilePath as string | null,
      targetSymbolUid: row.targetSymbolUid as string | null,
      refName: row.refName as string | null,
      resolutionKind: row.resolutionKind as string | null,
      resolutionConfidence: row.resolutionConfidence as number | null,
      resolutionStrategy: row.resolutionStrategy as string | null,
      parserTier: row.parserTier as ParserTier | null,
      parserConfidence: row.parserConfidence as number | null,
    }))
  }

  function importerFilesForTargets(resolvedTargets: readonly string[]): readonly string[] {
    const importers = new Set<string>()
    for (const batch of inBatches(sortedUnique(resolvedTargets))) {
      const found = db.prepare(
        `SELECT DISTINCT file_path FROM imports WHERE resolved_path IN (${placeholders(batch.length)})`,
      ).all(...batch) as Array<{ file_path: string }>
      for (const row of found) importers.add(row.file_path)
    }
    return [...importers].sort()
  }

  function reexportTargetsForFiles(files: readonly string[]): ReadonlyMap<string, readonly string[]> {
    const byFile = new Map<string, string[]>()
    for (const batch of inBatches(sortedUnique(files))) {
      const found = db.prepare(
        'SELECT file_path AS filePath, resolved_path AS resolvedPath FROM imports '
        + `WHERE file_path IN (${placeholders(batch.length)}) AND is_reexport = 1 AND resolved_path IS NOT NULL `
        + 'ORDER BY file_path ASC, rowid ASC',
      ).all(...batch) as Array<{ filePath: string; resolvedPath: string }>
      for (const row of found) {
        const targets = byFile.get(row.filePath)
        if (targets === undefined) byFile.set(row.filePath, [row.resolvedPath])
        else targets.push(row.resolvedPath)
      }
    }
    return byFile
  }

  function importsByFilePaths(files: readonly string[]): readonly ImportRow[] {
    const rows: ImportRow[] = []
    for (const batch of inBatches(sortedUnique(files))) {
      const found = db.prepare(
        'SELECT file_path AS filePath, import_string AS importString, resolved_path AS resolvedPath, '
        + 'imported_name AS importedName, alias, is_namespace AS isNamespace, is_default AS isDefault, '
        + `is_reexport AS isReexport FROM imports WHERE file_path IN (${placeholders(batch.length)}) `
        + 'ORDER BY file_path ASC, rowid ASC',
      ).all(...batch) as Array<Record<string, string | number | null>>
      for (const row of found) {
        rows.push({
          filePath: row.filePath as string,
          importString: row.importString as string,
          resolvedPath: row.resolvedPath as string | null,
          importedName: row.importedName as string | null,
          alias: row.alias as string | null,
          isNamespace: row.isNamespace === 1,
          isDefault: row.isDefault === 1,
          isReexport: row.isReexport === 1,
        })
      }
    }
    return rows
  }

  // Impacted tests are unordered by contract: the caller owns any ranking,
  // so neither an ORDER BY nor a cap is imposed here.
  function findImpactedTests(files: readonly string[]): readonly ImpactedTestRow[] {
    const rows: ImpactedTestRow[] = []
    for (const batch of inBatches(files)) {
      const found = db.prepare(
        'SELECT test_file_path AS testFilePath, code_file_path AS codeFilePath, reason, confidence '
        + `FROM test_edges WHERE code_file_path IN (${placeholders(batch.length)})`,
      ).all(...batch) as Array<Record<string, string | number | null>>
      for (const row of found) {
        rows.push({
          testFilePath: row.testFilePath as string,
          codeFilePath: row.codeFilePath as string,
          reason: (row.reason as string | null) ?? '',
          confidence: (row.confidence as number | null) ?? 0,
        })
      }
    }
    return rows
  }

  function exportFingerprints(files: readonly string[]): readonly ExportFingerprintRow[] {
    const rows: ExportFingerprintRow[] = []
    for (const batch of inBatches(sortedUnique(files))) {
      const keys = batch.map(filePath => `${CODE_INDEX_METADATA_EXPORT_FINGERPRINT_PREFIX}${filePath}`)
      const found = db.prepare(
        `SELECT key, value FROM metadata WHERE key IN (${placeholders(keys.length)})`,
      ).all(...keys) as Array<{ key: string; value: string }>
      const byKey = new Map(found.map(row => [row.key, row.value]))
      for (const [index, filePath] of batch.entries()) {
        const fingerprint = byKey.get(keys[index] as string)
        if (fingerprint !== undefined) rows.push({ filePath, fingerprint })
      }
    }
    return rows
  }

  function literalRowsByFilePaths(files: readonly string[]): readonly LiteralRow[] {
    const rows: LiteralRow[] = []
    for (const batch of inBatches(sortedUnique(files))) {
      const found = db.prepare(
        'SELECT literal_id AS literalId, file_path AS filePath, literal, literal_kind AS literalKind, '
        + 'line, container, confidence, enclosing_symbol_uid AS enclosingSymbolUid '
        + `FROM literal_index WHERE file_path IN (${placeholders(batch.length)}) `
        + 'ORDER BY file_path ASC, line ASC, rowid ASC',
      ).all(...batch) as unknown as Array<LiteralRow>
      rows.push(...found)
    }
    return rows
  }

  function fileImportAdjacency(): ReadonlyMap<string, readonly string[]> {
    const adjacency = new Map<string, string[]>()
    for (const row of db.prepare(
      'SELECT file_path AS sourcePath, resolved_path AS resolvedPath FROM imports '
      + 'WHERE resolved_path IS NOT NULL ORDER BY file_path ASC, rowid ASC',
    ).iterate() as Iterable<{ sourcePath: string; resolvedPath: string }>) {
      const targets = adjacency.get(row.sourcePath)
      if (targets === undefined) adjacency.set(row.sourcePath, [row.resolvedPath])
      else if (!targets.includes(row.resolvedPath)) targets.push(row.resolvedPath)
    }
    for (const targets of adjacency.values()) targets.sort()
    return adjacency
  }

  // The dead-code scan evaluates the two reverse-lookup facts per scanned row
  // in SQL so the caller receives candidates ready for in-memory filtering;
  // both EXISTS clauses mirror the reference read model verbatim (an unbound
  // `NULL` caller counts as a caller; a missing or foreign referencing
  // container counts as an external reference).
  function analysisSymbolRows(scanLimit: number): readonly AnalysisSymbolRow[] {
    const rows = db.prepare(
      'SELECT s.symbol_uid AS symbolUid, s.name AS name, s.file_path AS filePath, s.kind AS kind, '
      + 'EXISTS(SELECT 1 FROM call_edges ce WHERE ce.callee_symbol_uid = s.symbol_uid '
      + 'AND (ce.caller_symbol_uid IS NULL OR ce.caller_symbol_uid <> s.symbol_uid)) AS hasCaller, '
      + 'EXISTS(SELECT 1 FROM symbol_refs r WHERE r.target_symbol_uid = s.symbol_uid '
      + 'AND (r.container IS NULL OR r.container <> s.name)) AS hasExternalRef '
      + 'FROM symbols s ORDER BY s.rowid ASC LIMIT ?',
    ).all(scanLimit) as Array<{
      symbolUid: string | null
      name: string | null
      filePath: string | null
      kind: string | null
      hasCaller: number
      hasExternalRef: number
    }>
    return rows.map(row => ({
      symbolUid: row.symbolUid ?? '',
      // `name` / `file_path` / `kind` are NOT NULL columns; only `symbol_uid` is nullable.
      name: row.name as string,
      filePath: row.filePath as string,
      kind: row.kind as string,
      hasCaller: row.hasCaller === 1,
      hasExternalRef: row.hasExternalRef === 1,
    }))
  }

  function internalEdgesForUids(ids: readonly string[]): readonly InternalImportEdgeRow[] {
    const wanted = sortedUnique(ids)
    if (wanted.length === 0) return []
    const rows: InternalImportEdgeRow[] = []
    for (const batch of inBatches(wanted)) {
      const found = db.prepare(
        'SELECT file_path AS sourcePath, resolved_path AS resolvedPath, import_string AS importString FROM imports '
        + `WHERE resolved_path IS NOT NULL AND file_path IN (${placeholders(batch.length)}) `
        + `AND resolved_path IN (${placeholders(batch.length)}) `
        + 'ORDER BY file_path ASC, rowid ASC',
      ).all(...batch, ...batch) as Array<{ sourcePath: string; resolvedPath: string; importString: string }>
      for (const row of found) rows.push({ from: row.sourcePath, to: row.resolvedPath, importString: row.importString })
    }
    return rows
  }

  return {
    symbolSeedHits,
    symbolUidsByExactNames,
    callerRowsByUids: (uids: readonly string[], limit: number): readonly CallerEdgeRow[] =>
      callEdgeRowsBySide('caller_symbol_uid', uids, limit),
    calleeRowsByUids: (uids: readonly string[], limit: number): readonly CalleeEdgeRow[] =>
      callEdgeRowsBySide('callee_symbol_uid', uids, limit),
    symbolRowsByUids,
    symbolDegreeDetailsBatch,
    chunkSpansForFiles,
    symbolsByFilePaths,
    importsByFilePaths,
    callEdgesByFilePaths,
    symbolRefsByFilePaths,
    importerFilesForTargets,
    reexportTargetsForFiles,
    findImpactedTests,
    exportFingerprints,
    literalRowsByFilePaths,
    fileImportAdjacency,
    analysisSymbolRows,
    internalEdgesForUids,
  }
}
