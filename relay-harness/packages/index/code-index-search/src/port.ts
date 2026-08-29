/**
 * Minimal read-side contract the search engine needs from an index store.
 *
 * The engine is pure logic: every data access goes through
 * {@link RetrievalPort}, so the SQLite reader (the local provider's retrieval
 * face) implements this interface as a thin adapter. Signatures follow the
 * reference implementation's `cc_db` retrieval model; the port exists so the
 * engine never touches SQL, fs, or connection pools.
 *
 * ── Division of responsibilities for the grep scan budget ────────────────
 *
 * The store side (adapter) owns the DB mechanics of a scan:
 * - row ordering: rows arrive in base-table `rowid DESC` (recency) order for
 *   unscoped scans, and natural probe order for explicitly file-scoped scans;
 * - scope enforcement: `pathPrefix` / `filePaths` filtering happens in the
 *   query, not after it;
 * - respecting the visitor's `false` return by stopping iteration immediately;
 * - never surfacing more than one decode of any single chunk to the visitor.
 *
 * The search side (this package) owns the budget policy:
 * - counting visited rows (`scanned`) and comparing against `scanCap`
 *   (`grepScanCap`);
 * - deciding "budget exhausted" (`truncated=true`) vs "enough matches"
 *   (`matches >= limit`), both expressed through the visitor returning `false`;
 * - merging the two grep stages into one recency-ordered result via the rows'
 *   `rowid`, and de-duplicating stages through `skipChunkIds`.
 *
 * A concrete adapter therefore stays free of scoring/ordering logic, and the
 * engine stays free of SQL.
 *
 * @module @relay-harness/rlh-code-index-search/port
 */

import type { ParserTier } from '@relay-harness/rlh-code-index'

/** Structured chunk-scan scope: the same filters the engine re-checks in memory, expressed as data instead of SQL. */
export interface ChunkScope {
  readonly pathPrefix: string | null
  /** Stored `files.language` values candidates must match; `null` leaves language unrestricted. */
  readonly languages: readonly string[] | null
  readonly filePaths: readonly string[] | null
}

/** Minimal candidate row the lexical lane needs from an FTS match. */
export interface LexicalCandidateRow {
  readonly chunkId: string
  readonly filePath: string
  readonly languageName: string
}

/** One classified-literal FTS hit (`literal_fts`), with the raw bm25 score as stored. */
export interface LiteralCandidateRow {
  readonly literalId: string
  readonly filePath: string
  readonly literal: string | null
  readonly literalKind: string | null
  readonly line: number | null
  readonly container: string | null
  /** Raw bm25 value (negative under FTS5 ordering conventions); rows arrive best-first. */
  readonly rank: number
}

/** One decoded chunk row handed back during a grep scan. */
export interface GrepChunkRow {
  /** Base-table `chunks.rowid`; orders the two-stage recency merge. */
  readonly rowid: number
  readonly chunkId: string
  readonly filePath: string
  readonly languageName: string
  /** Decompressed chunk text; only matched rows are retained by the engine. */
  readonly text: string
}

/** Return `true` to keep scanning, `false` to stop the scan at this row. */
export type ChunkScanVisitor = (row: GrepChunkRow) => boolean

/** Full detail row fetched for candidates that survived fusion. */
export interface ChunkDetailRow {
  readonly chunkId: string
  readonly filePath: string
  readonly languageName: string
  /** Content hash of the owning indexed file revision. */
  readonly contentHash: string
  readonly startLine: number
  readonly endLine: number
  readonly breadcrumb: string
  readonly symbolName: string | null
  readonly symbolKind: string | null
  /** Decompressed chunk text; feeds the overlap score. */
  readonly text: string
  /** File-level extraction tier applied to this chunk. */
  readonly parserTier: ParserTier
  /** File-level extraction confidence applied to this chunk. */
  readonly parserConfidence: number
}

/** One file-summary FTS hit (`files_fts`), with the raw bm25 score as stored. */
export interface FileSummaryHit {
  readonly filePath: string
  /** Raw bm25 value (negative under FTS5 ordering conventions); engines use its magnitude. */
  readonly rawScore: number
}

/** One symbol-name hit for a query token (preselect layer 6b). */
export interface SymbolTokenHit {
  readonly filePath: string
  /** Symbol name as stored; exactness is decided against the token case-insensitively. */
  readonly name: string
}

/** One candidate symbol seed for a graph token (graph resolve stage). */
export interface SymbolSeedHit {
  /** Store-global symbol identity, or `''` when the row carries no uid. */
  readonly symbolUid: string
  /** Symbol name as stored. */
  readonly name: string
  /** Informational match quality in `(0, 1]`: `1` for a case-insensitive exact match, decaying with name length. */
  readonly score: number
}

/** Projection of one `symbols` row for graph node rendering. */
export interface SymbolRowLite {
  readonly symbolId: string
  readonly symbolUid: string | null
  readonly name: string
  readonly kind: string
  readonly filePath: string
  readonly container: string | null
  /** Inclusive start line (1-based). */
  readonly startLine: number
  /** Inclusive end line (1-based). */
  readonly endLine: number
  readonly qname: string | null
  readonly signature: string | null
}

/**
 * One call edge bound to a seed symbol. A caller row's `seedUid` names the
 * calling symbol; a callee row's `seedUid` names the called symbol.
 */
export interface CallerEdgeRow {
  /** The partitioning seed's `symbol_uid` (caller side for callers, callee side for callees). */
  readonly seedUid: string
  readonly filePath: string
  readonly line: number | null
  readonly callerSymbol: string | null
  readonly calleeSymbol: string | null
  readonly callerSymbolUid: string | null
  readonly calleeSymbolUid: string | null
  readonly resolutionKind: string | null
  readonly dispatchKind: string | null
  readonly callKind: string | null
  /**
   * Resolution strategy that bound the edge, as stored. Optional because the
   * column postdates the projection: stores and fixtures predating it omit it,
   * and readers normalize absence to `null` at their own boundary.
   */
  readonly resolutionStrategy?: string | null
  /** Stored resolution confidence for the edge; see {@link CallerEdgeRow.resolutionStrategy} for why it is optional. */
  readonly resolutionConfidence?: number | null
}

/** One edge walked in the callee direction; same shape as {@link CallerEdgeRow} with `seedUid` naming the callee. */
export type CalleeEdgeRow = CallerEdgeRow

/** In/out call degrees plus reference count for one symbol. */
export interface SymbolDegreeRow {
  readonly symbolUid: string
  /** Distinct symbols calling this one. */
  readonly inDegree: number
  /** Distinct symbols this one calls. */
  readonly outDegree: number
  /** Reference rows bound to this symbol. */
  readonly refCount: number
}

/** Chunk line span for one file, used to frame graph output with source ranges. */
export interface ChunkSpanRow {
  readonly filePath: string
  readonly chunkId: string
  readonly startLine: number
  readonly endLine: number
}

/** One derived test-to-code association for the impacted-tests question. */
export interface ImpactedTestRow {
  readonly testFilePath: string
  readonly codeFilePath: string
  readonly reason: string
  readonly confidence: number
}

/** The export fingerprint recorded for one file, when present. */
export interface ExportFingerprintRow {
  readonly filePath: string
  readonly fingerprint: string
}

/** One import declaration row for a file. */
export interface ImportRow {
  readonly filePath: string
  readonly importString: string
  readonly resolvedPath: string | null
  readonly importedName: string | null
  readonly alias: string | null
  readonly isNamespace: boolean
  readonly isDefault: boolean
  readonly isReexport: boolean
}

/** One literal occurrence row. */
export interface LiteralRow {
  readonly literalId: string
  readonly filePath: string
  readonly literal: string | null
  readonly literalKind: string | null
  readonly line: number | null
  readonly container: string | null
  readonly confidence: number | null
  readonly enclosingSymbolUid: string | null
}

/**
 * One symbol row carrying the incoming-edge existence facts the `dead_code`
 * analysis consumes, so candidate selection and the reverse lookups stay pure
 * in-memory work above the store. Rows arrive in store insertion order, capped
 * by the caller's scan limit; uid-less symbols surface with an empty
 * {@link AnalysisSymbolRow.symbolUid} and are filtered by the caller.
 */
export interface AnalysisSymbolRow {
  /** Store-global symbol identity, or `''` when the row carries no uid. */
  readonly symbolUid: string
  readonly name: string
  readonly filePath: string
  readonly kind: string
  /**
   * True when at least one call edge names this uid as callee from a different
   * caller; an unbound (`NULL`) caller counts as a caller, mirroring the
   * reference implementation's `callees_with_nonself_callers`.
   */
  readonly hasCaller: boolean
  /**
   * True when a `symbol_refs` row targets this uid from outside the symbol's
   * own declaration: the referencing container is missing or differs from the
   * symbol's own name (self-references keep candidates alive).
   */
  readonly hasExternalRef: boolean
}

/** One stored import edge whose both endpoints lie inside a queried id set — a cycle component's witness. */
export interface InternalImportEdgeRow {
  /** Importing (dependent) file inside the queried set. */
  readonly from: string
  /** Imported file inside the queried set. */
  readonly to: string
  /** Import specifier as stored. */
  readonly importString: string
}

/** Projection of one `symbol_refs` row for a reload. */
export interface CatalogSymbolRowExtension {
  /** Exported name when the declaration is exported, else `null`. */
  readonly exportName?: string | null
  /** True for `export default <name>`. */
  readonly isDefaultExport?: boolean
  /** Receiver (container) type recorded for a method, else `null`. */
  readonly receiverType?: string | null
  /** Declared parameter count, else `null`. */
  readonly paramCount?: number | null
  /** Comma-joined base types, else `null`. */
  readonly baseTypes?: string | null
  /** Comma-joined implemented interfaces, else `null`. */
  readonly implements?: string | null
  /** Owning scope id, or `null` (no producer emits scopes yet). */
  readonly scopeId?: string | null
}

/**
 * One `symbols` row with the resolution-registration columns the resolver's
 * catalog loader needs on top of {@link SymbolRowLite}. The extension columns
 * are optional because explore-only consumers and fixtures omit them; the
 * catalog loader normalizes absence to `null` at its own boundary.
 */
export interface CatalogSymbolRow extends SymbolRowLite, CatalogSymbolRowExtension {}

/**
 * One complete `call_edges` row as stored — the reload view, carrying every
 * parsed-fact column the write-back must restore, unlike the trimmed
 * {@link CallerEdgeRow} exploration projection.
 */
export interface StoredCallEdgeRow {
  readonly edgeId: string
  readonly filePath: string
  readonly callerSymbol: string | null
  readonly calleeSymbol: string | null
  readonly line: number | null
  readonly startCol: number | null
  readonly targetSymbolId: string | null
  readonly targetFilePath: string | null
  readonly callerSymbolId: string | null
  readonly callerSymbolUid: string | null
  readonly calleeSymbolUid: string | null
  readonly dispatchKind: string | null
  readonly callKind: string | null
  readonly resolutionKind: string | null
  readonly resolutionConfidence: number | null
  readonly resolutionStrategy: string | null
  readonly receiverExpr: string | null
  readonly argCount: number | null
  readonly isOptionalChain: boolean
  readonly isAwaited: boolean
  readonly isConstructor: boolean
  readonly parserTier: ParserTier | null
  readonly parserConfidence: number | null
}

/** One complete `symbol_refs` row as stored; see {@link StoredCallEdgeRow}. */
export interface StoredSymbolRefRow {
  readonly refId: string
  readonly filePath: string
  readonly symbolName: string | null
  readonly container: string | null
  readonly refKind: string | null
  readonly line: number | null
  readonly col: number | null
  readonly targetSymbolId: string | null
  readonly targetFilePath: string | null
  readonly targetSymbolUid: string | null
  readonly refName: string | null
  readonly resolutionKind: string | null
  readonly resolutionConfidence: number | null
  readonly resolutionStrategy: string | null
  readonly parserTier: ParserTier | null
  readonly parserConfidence: number | null
}

/**
 * Read-only graph face of an index store: the seed/edge/degree/span/test/fingerprint
 * projections a graph explore consumes. Named neutrally so implementations stay
 * graph-vocabulary-shaped rather than storage-shaped. Every method may reject;
 * callers convert rejections into per-operation degradation, never aborts.
 */
export interface GraphReadFacet {
  /** Symbols whose name contains `token` as a substring, best (case-insensitive exact, then shortest) first. */
  symbolSeedHits(token: string, limit: number): readonly SymbolSeedHit[]

  /** Symbol rows whose stored name equals one of `names` exactly (deduplicated, capped by `limit`). */
  symbolUidsByExactNames(names: readonly string[], limit: number): readonly SymbolRowLite[]

  /**
   * Call edges where `uids` are the callers, at most `limit` rows per seed
   * (per-seed order: line ascending, then store insertion order).
   */
  callerRowsByUids(uids: readonly string[], limit: number): readonly CallerEdgeRow[]

  /**
   * Call edges where `uids` are the callees, at most `limit` rows per seed
   * (per-seed order: line ascending, then store insertion order).
   */
  calleeRowsByUids(uids: readonly string[], limit: number): readonly CalleeEdgeRow[]

  /** Symbol rows for the given uids; unknown uids are omitted, order is store-deterministic. */
  symbolRowsByUids(uids: readonly string[]): readonly SymbolRowLite[]

  /** Degree/ref counts for every distinct requested uid; uids without graph rows report zeros. */
  symbolDegreeDetailsBatch(uids: readonly string[]): readonly SymbolDegreeRow[]

  /** Chunk spans covering the given files; empty for unknown files. */
  chunkSpansForFiles(files: readonly string[]): readonly ChunkSpanRow[]

  /** Symbol rows declared in the given files; empty for unknown files. */
  symbolsByFilePaths(files: readonly string[]): readonly CatalogSymbolRow[]

  /** Import rows declared in the given files; empty for unknown files. */
  importsByFilePaths(files: readonly string[]): readonly ImportRow[]

  /**
   * Complete `call_edges` rows declared in the given files (the reload view,
   * every column); empty for unknown files, ordered file path then store
   * insertion order.
   */
  callEdgesByFilePaths(files: readonly string[]): readonly StoredCallEdgeRow[]

  /**
   * Complete `symbol_refs` rows declared in the given files (the reload
   * view); empty for unknown files, ordered file path then store insertion
   * order.
   */
  symbolRefsByFilePaths(files: readonly string[]): readonly StoredSymbolRefRow[]

  /**
   * Distinct files whose imports resolve into one of `resolvedTargets`, i.e.
   * the importers of the given files, sorted. This is the reverse direction
   * of {@link GraphReadFacet.importsByFilePaths}.
   */
  importerFilesForTargets(resolvedTargets: readonly string[]): readonly string[]

  /**
   * Resolved re-export targets per file: only files carrying at least one
   * `is_reexport` import with a resolved path appear, mapped to those target
   * paths in store insertion order. Drives dirty propagation's re-export
   * surface check.
   */
  reexportTargetsForFiles(files: readonly string[]): ReadonlyMap<string, readonly string[]>

  /** Test associations whose code side is one of `files`; no ordering and no cap are guaranteed. */
  findImpactedTests(files: readonly string[]): readonly ImpactedTestRow[]

  /** Export fingerprints recorded for the given files; files without one are omitted. */
  exportFingerprints(files: readonly string[]): readonly ExportFingerprintRow[]

  /** Literal rows occurring in the given files; empty for unknown files. */
  literalRowsByFilePaths(files: readonly string[]): readonly LiteralRow[]

  /**
   * Full-store file-import adjacency as directed edges `file_path →
   * resolved_path` (unresolved imports contribute nothing). Target lists are
   * deduplicated and sorted, so Tarjan's discovery order — and therefore the
   * answer — is deterministic. Drives the `cycles` op.
   */
  fileImportAdjacency(): ReadonlyMap<string, readonly string[]>

  /**
   * Symbols scan for the `dead_code` op, capped at `scanLimit` rows in store
   * insertion order, each carrying its incoming call/reference existence facts
   * (see {@link AnalysisSymbolRow}); candidate selection stays with the caller.
   */
  analysisSymbolRows(scanLimit: number): readonly AnalysisSymbolRow[]

  /**
   * Stored import edges whose `file_path` AND `resolved_path` both fall inside
   * `ids` — the witness edges of one cycle component. Order is store
   * insertion order; unknown ids contribute nothing.
   */
  internalEdgesForUids(ids: readonly string[]): readonly InternalImportEdgeRow[]
}

/**
 * One stored quantized vector read back from the index's `chunks_vec` tier,
 * in the storage contract of
 * `@relay-harness/rlh-code-index-search/vector-math`: `q` is the byte view of
 * the signed int8 components and `scale` / `norm` are the stored scalars, so
 * {@link cosineQuantized} ranks the row without a dequantized copy.
 */
export interface VectorRow {
  readonly chunkId: string
  /** Base-table `chunks.rowid` denormalized at write time. */
  readonly rowid: number
  readonly q: Uint8Array
  readonly scale: number
  /** ORIGINAL float norm captured before quantization. */
  readonly norm: number
  /** Component count; equals `q.byteLength` for one-byte int8 elements. */
  readonly dim: number
}

/** How much of the chunk tier one embedding model has covered. */
export interface VectorCoverage {
  /** Chunk rows carrying a stored vector for the model. */
  readonly vectorizedChunks: number
  /** All chunk rows currently in the index. */
  readonly totalChunks: number
}

/** Provider-neutral nearest-neighbor request; SQLite implements a bounded exact scan, ANN adapters may replace it. */
export interface VectorRecallRequest {
  readonly generationId: string
  readonly queryVector: Float32Array
  readonly scope: ChunkScope
  readonly topK: number
  readonly maxScan: number
}

/** One semantic candidate returned best-first by a vector adapter. */
export interface VectorRecallHit {
  readonly chunkId: string
  readonly score: number
}

/** Bounded vector recall result with explicit coverage truncation. */
export interface VectorRecallResult {
  readonly hits: readonly VectorRecallHit[]
  readonly scanned: number
  readonly truncated: boolean
}

/**
 * Read-only vector face of an index store: quantized `chunks_vec` reads for
 * the vector lane and coverage counters for observability. Optional with the
 * same precedent as the literal FTS mirror: stores without a vector tier stay
 * valid ports, and deployments without an embedding tier never wire the lane
 * that would consume it.
 */
export interface VectorReadFacet {
  /**
   * Stored vectors of `model` for the given chunk ids; ids without a vector
   * row for that model are simply absent, order is store-deterministic.
   */
  vectorsByChunkIds(chunkIds: readonly string[], model: string): readonly VectorRow[]

  /** Chunk-tier coverage counts for `model`. */
  vectorCoverage(model: string): VectorCoverage

  /** Independent semantic candidate query; adapters may use exact scan or ANN. */
  recallCandidates?(request: VectorRecallRequest): VectorRecallResult
}

/**
 * Read-only retrieval face of an index store. Every method may reject; the
 * engine converts rejections into per-lane/per-layer degradation
 * (`readErrors` + `degraded`), except `countFiles`, whose failure makes tier
 * resolution impossible and aborts the search.
 */
export interface RetrievalPort {
  /** Number of files currently present in the index (drives the size tier). */
  countFiles(): number

  /** Files whose path contains `token` as a substring (trigram/mirror accelerated on the store side). */
  filePathCandidatesBySubstring(token: string, pathPrefix: string | null, limit: number): readonly string[]

  /** Symbols whose name contains `token` as a substring, mapped to their files. */
  symbolNamesByTokenSubstring(token: string, pathPrefix: string | null, limit: number): readonly SymbolTokenHit[]

  /** FTS summary hits over file-level summaries (`files_fts` MATCH). */
  ftsFileSummaries(matchExpr: string, pathPrefix: string | null, limit: number): readonly FileSummaryHit[]

  /** Recently indexed file paths, most recent first. */
  recentIndexedFiles(limit: number): readonly string[]

  /** Chunks matching an FTS5 MATCH expression, bm25-ordered, within the scope. */
  ftsChunkCandidates(matchExpr: string, scope: ChunkScope, limit: number): readonly LexicalCandidateRow[]

  /**
   * Classified literals matching an FTS5 MATCH expression, bm25-ordered,
   * within the scope. Optional because it requires a store carrying the
   * literal FTS mirror: adapters without one stay valid ports, and the
   * built-in literal lane skips itself instead of failing every search.
   */
  literalFtsCandidates?(matchExpr: string, scope: ChunkScope, limit: number): readonly LiteralCandidateRow[]

  /**
   * Stage-1 grep scan: walk chunks whose text contains the quoted FTS phrase
   * `phrase` (a tokenizer-visible superset of token-boundary regex matches),
   * decoding at most `scanCap` rows before invoking the visitor chain; call
   * `visit(row)` per decoded row and stop when it returns `false`.
   */
  scanChunksForGrepPrefiltered(phrase: string, scanCap: number, scope: ChunkScope, visit: ChunkScanVisitor): void

  /**
   * Stage-2 grep scan: full scan of the scope in store-owned row order,
   * skipping chunk ids listed in `skipChunkIds` BEFORE any decode cost is
   * paid for them (`null` skips nothing). Same visitor contract as stage 1.
   */
  scanChunksForGrep(scope: ChunkScope, skipChunkIds: ReadonlySet<string> | null, visit: ChunkScanVisitor): void

  /** Full detail rows for the given candidate chunk ids (order irrelevant; unknown ids may be omitted). */
  chunkRowsByIds(chunkIds: readonly string[]): readonly ChunkDetailRow[]

  /**
   * Quantized vector reads over the same store. Optional because it requires
   * the `chunks_vec` tier: adapters without one stay valid ports, and the
   * vector lane skips itself instead of failing every search.
   */
  readonly vector?: VectorReadFacet

  /** Graph read facet over the same store; no engine stage consumes it until the graph lane lands. */
  readonly graph: GraphReadFacet
}
