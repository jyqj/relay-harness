import { afterEach, describe, expect, it } from 'vitest'
import { assertExactAdvance, readEpochs } from '../src/epoch.ts'
import { CODE_INDEX_METADATA_EXPORT_FINGERPRINT_PREFIX } from '../src/ddl.ts'
import { decodeChunkText } from '../src/codec.ts'
import { openCodeIndexDatabase } from '../src/open.ts'
import { writeFilesDelta, writeResolvedEdges } from '../src/writer.ts'
import {
  callEdgeRow,
  chunkUpsert,
  fileGraphDelta,
  fileUpsert,
  importRow,
  literalRow,
  symbolRefRow,
  symbolRow,
  storageCounts,
  testEdgeRow,
} from './support.ts'

describe('writeFilesDelta', () => {
  const opened: Array<import('node:sqlite').DatabaseSync> = []
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close()
  })

  async function memory(): Promise<import('node:sqlite').DatabaseSync> {
    const db = await openCodeIndexDatabase(':memory:')
    opened.push(db)
    return db
  }

  function count(db: import('node:sqlite').DatabaseSync, sql: string): number {
    return (db.prepare(sql).get() as { n: number }).n
  }

  it('commits a two-file delta atomically and counts what changed', async () => {
    const db = await memory()
    const result = writeFilesDelta(
      db,
      {
        removals: [],
        upserts: [
          fileUpsert('src/one.ts', ['export const one = 1', 'export const oneAgain = one']),
          { ...fileUpsert('src/two.ts', ['export const two = 2']), isTestFile: true },
        ],
      },
      { now: () => '2026-08-27T00:00:01Z' },
    )
    expect(result).toEqual({
      removedFiles: 0,
      upsertedFiles: 2,
      chunksWritten: 3,
      symbolsWritten: 0,
      edgesWritten: 0,
      testEdgesWritten: 0,
      literalsWritten: 0,
    })
    expect(count(db, 'SELECT COUNT(*) AS n FROM files WHERE is_test_file = 1')).toBe(1)
    expect(readEpochs(db)).toEqual({ indexEpoch: 1, evidenceEpoch: 0, embeddingEpoch: 0 })
    // Mirrors follow their base rows 1:1 under aligned rowids.
    expect(storageCounts(db)).toEqual({
      files: 2,
      chunks: 3,
      chunks_fts: 3,
      files_fts: 2,
      file_paths_fts: 2,
      symbols: 0,
      symbols_fts: 0,
      imports: 0,
      symbol_refs: 0,
      call_edges: 0,
      test_edges: 0,
      literal_index: 0,
    })
    expect(count(db, "SELECT COUNT(*) AS n FROM files WHERE indexed_at = '2026-08-27T00:00:01Z'")).toBe(2)
  })

  it('replays an identical upsert idempotently without duplicating mirrors', async () => {
    const db = await memory()
    const delta = { removals: [] as string[], upserts: [fileUpsert('src/idem.ts', ['idempotent body'])] }
    const noGraph = {
      removedFiles: 0,
      upsertedFiles: 1,
      chunksWritten: 1,
      symbolsWritten: 0,
      edgesWritten: 0,
      testEdgesWritten: 0,
      literalsWritten: 0,
    }
    expect(writeFilesDelta(db, delta, { now: () => '2026-08-27T00:00:00Z' })).toEqual(noGraph)
    expect(writeFilesDelta(db, delta, { now: () => '2026-08-27T00:00:05Z' })).toEqual(noGraph)

    expect(storageCounts(db)).toMatchObject({ files: 1, chunks: 1, chunks_fts: 1, files_fts: 1 })
    expect(readEpochs(db)).toEqual({ indexEpoch: 2, evidenceEpoch: 0, embeddingEpoch: 0 })
    const stored = db.prepare('SELECT summary, indexed_at FROM files WHERE file_path = ?')
      .get('src/idem.ts') as { summary: string; indexed_at: string }
    expect(stored.summary).toBe('summary for src/idem.ts')
    expect(stored.indexed_at).toBe('2026-08-27T00:00:05Z')
  })

  it('removes a whole file subtree through the foreign key and every mirror', async () => {
    const db = await memory()
    writeFilesDelta(db, { removals: [], upserts: [fileUpsert('src/gone.ts', ['body a', 'body b'])] })
    writeFilesDelta(db, { removals: [], upserts: [fileUpsert('src/stays.ts', ['keeper'])] })

    const result = writeFilesDelta(db, { removals: ['src/gone.ts', 'src/never-was.ts'], upserts: [] })
    expect(result).toEqual({
      removedFiles: 1,
      upsertedFiles: 0,
      chunksWritten: 0,
      symbolsWritten: 0,
      edgesWritten: 0,
      testEdgesWritten: 0,
      literalsWritten: 0,
    })
    expect(storageCounts(db)).toEqual({
      files: 1,
      chunks: 1,
      chunks_fts: 1,
      files_fts: 1,
      file_paths_fts: 1,
      symbols: 0,
      symbols_fts: 0,
      imports: 0,
      symbol_refs: 0,
      call_edges: 0,
      test_edges: 0,
      literal_index: 0,
    })
    // The trigram mirror heals through its DELETE trigger only.
    expect(count(db, "SELECT COUNT(*) AS n FROM file_paths_fts WHERE file_path = 'src/gone.ts'")).toBe(0)
  })

  it('rolls back the entire delta and leaves the epoch untouched when any statement fails', async () => {
    const db = await memory()
    // Duplicate chunk ids violate the primary key mid-transaction, after the
    // preceding file already committed its statements into the open unit.
    const corruptFile = {
      ...fileUpsert('src/broken.ts', []),
      chunks: [
        chunkUpsert('src/broken.ts', 0, 'first'),
        { ...chunkUpsert('src/broken.ts', 1, 'second'), chunkId: 'chunk:src/broken.ts:0' },
      ],
    }
    expect(() => writeFilesDelta(
      db,
      { removals: [], upserts: [fileUpsert('src/fine.ts', ['transient']), corruptFile] },
    )).toThrow(/UNIQUE|primary key/i)

    expect(storageCounts(db)).toEqual({
      files: 0,
      chunks: 0,
      chunks_fts: 0,
      files_fts: 0,
      file_paths_fts: 0,
      symbols: 0,
      symbols_fts: 0,
      imports: 0,
      symbol_refs: 0,
      call_edges: 0,
      test_edges: 0,
      literal_index: 0,
    })
    expect(readEpochs(db)).toEqual({ indexEpoch: 0, evidenceEpoch: 0, embeddingEpoch: 0 })
  })

  it('mirrors plain text into the FTS tables so English and Chinese queries MATCH', async () => {
    const db = await memory()
    writeFilesDelta(db, {
      removals: [],
      upserts: [
        fileUpsert('src/en.ts', ['the parser writes searchable chunks']),
        fileUpsert('src/zh.ts', ['缓存 命中 说明文档']),
      ],
    })

    const englishHits = count(db, "SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'chunks'")
    expect(englishHits).toBe(1)
    const chineseHits = count(db, "SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH '命中'")
    expect(chineseHits).toBe(1)
    // Summary text mirrored into files_fts is searchable too.
    expect(count(db, "SELECT COUNT(*) AS n FROM files_fts WHERE files_fts MATCH 'summary'")).toBe(2)
  })

  it('stores a large CJK chunk compressed while the FTS mirror keeps searchable plaintext', async () => {
    const db = await memory()
    // unicode61 has no CJK segmenter, so the space-separated tokens stay
    // individually searchable — same fixture shape as the plain-text test above.
    const cjkChunk = '解析器 索引 命中 原样解回 派生存储\n'.repeat(6)
    expect(Buffer.byteLength(cjkChunk, 'utf8')).toBeGreaterThan(128)
    writeFilesDelta(db, { removals: [], upserts: [fileUpsert('src/zh/large.ts', [cjkChunk, 'tiny plain chunk'])] })

    const stored = db.prepare(
      'SELECT text, text_encoding FROM chunks WHERE chunk_id = ?',
    ).get('chunk:src/zh/large.ts:0') as { text: string; text_encoding: string }
    expect(stored.text_encoding).toBe('zstd')
    expect(stored.text).not.toBe(cjkChunk)
    // The small sibling chunk stays plain, and the compressed one decodes verbatim.
    expect(db.prepare('SELECT text_encoding FROM chunks WHERE chunk_id = ?')
      .get('chunk:src/zh/large.ts:1')).toMatchObject({ text_encoding: 'plain' })
    expect(decodeChunkText(stored.text_encoding, stored.text)).toBe(cjkChunk)

    // The mirror column holds the decoded text, so CJK plaintext queries still MATCH.
    expect(count(db, "SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH '解析器'")).toBe(1)
  })

  it('chunks IN (...) lists at the ported variable budget when removing many paths', async () => {
    const db = await memory()
    const paths = Array.from({ length: 201 }, (_, index) => `src/bulk/${index}.ts`)
    writeFilesDelta(db, { removals: [], upserts: paths.map(path => fileUpsert(path, [path])) })
    expect(count(db, 'SELECT COUNT(*) AS n FROM files')).toBe(201)

    const result = writeFilesDelta(db, { removals: paths, upserts: [] })
    expect(result.removedFiles).toBe(201)
    expect(storageCounts(db)).toEqual({
      files: 0,
      chunks: 0,
      chunks_fts: 0,
      files_fts: 0,
      file_paths_fts: 0,
      symbols: 0,
      symbols_fts: 0,
      imports: 0,
      symbol_refs: 0,
      call_edges: 0,
      test_edges: 0,
      literal_index: 0,
    })
  })

  it('writes a full graph delta with real column values and mirrors symbols into symbols_fts', async () => {
    const db = await memory()
    const graph = fileGraphDelta({
      symbols: [symbolRow('src/app.ts', 'runQuery', 'uid:runQuery'), symbolRow('src/app.ts', 'helper', null)],
      imports: [importRow('src/app.ts', './helper')],
      callEdges: [callEdgeRow('src/app.ts', 'edge:1', 'uid:runQuery', 'uid:helper', 12)],
      symbolRefs: [symbolRefRow('src/app.ts', 'ref:1', 'uid:helper')],
      testEdges: [testEdgeRow('edge:t1', 'src/app.spec.ts', 'src/app.ts', 'direct import', 0.9)],
      literals: [literalRow('src/app.ts', 'lit:1', 'GET')],
      exportFingerprint: 'fp-app-1',
    })
    const result = writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/app.ts', ['export function runQuery() {}'])],
      graph: { byFile: new Map([['src/app.ts', graph]]) },
    })
    expect(result).toEqual({
      removedFiles: 0,
      upsertedFiles: 1,
      chunksWritten: 1,
      symbolsWritten: 2,
      edgesWritten: 2,
      testEdgesWritten: 1,
      literalsWritten: 1,
    })
    // The trigram mirror tracked the insert trigger, one row per symbol.
    expect(count(db, 'SELECT COUNT(*) AS n FROM symbols_fts')).toBe(2)
    const stored = db.prepare(
      'SELECT kind, container, start_col, end_col, signature, doc, parser_tier, parser_confidence, '
      + 'qname, parent_symbol_id, export_name, is_default_export, symbol_uid, framework_role, '
      + 'param_types, return_type, param_count, implements FROM symbols WHERE symbol_uid = ?',
    ).get('uid:runQuery') as Record<string, unknown>
    expect(stored).toEqual({
      kind: 'function',
      container: 'outerScope',
      start_col: 2,
      end_col: 30,
      signature: 'function runQuery()',
      doc: 'doc for runQuery',
      parser_tier: 'semantic',
      parser_confidence: 0.9,
      qname: 'mod.runQuery',
      parent_symbol_id: 'sym:parent',
      export_name: 'runQuery',
      is_default_export: 0,
      symbol_uid: 'uid:runQuery',
      framework_role: 'handler',
      param_types: 'string',
      return_type: 'void',
      param_count: 1,
      implements: null,
    })
    const edge = db.prepare(
      'SELECT caller_symbol_uid, callee_symbol_uid, dispatch_kind, call_kind, resolution_kind, '
      + 'resolution_confidence, resolution_strategy, receiver_expr, arg_count, is_optional_chain, '
      + 'is_awaited, is_constructor, parser_tier FROM call_edges WHERE edge_id = ?',
    ).get('edge:1') as Record<string, unknown>
    expect(edge).toEqual({
      caller_symbol_uid: 'uid:runQuery',
      callee_symbol_uid: 'uid:helper',
      dispatch_kind: 'direct',
      call_kind: 'direct',
      resolution_kind: 'resolved',
      resolution_confidence: 0.8,
      resolution_strategy: 'local-exact',
      receiver_expr: 'router',
      arg_count: 2,
      is_optional_chain: 0,
      is_awaited: 1,
      is_constructor: 0,
      parser_tier: 'tree-sitter',
    })
    expect(db.prepare('SELECT resolved_path, is_default, is_reexport FROM imports').get())
      .toEqual({ resolved_path: 'src/resolved.ts', is_default: 1, is_reexport: 0 })
    expect(db.prepare('SELECT target_symbol_uid, resolution_strategy FROM symbol_refs').get())
      .toEqual({ target_symbol_uid: 'uid:helper', resolution_strategy: 'import' })
    expect(db.prepare('SELECT literal, literal_kind, container, enclosing_symbol_uid FROM literal_index').get())
      .toEqual({ literal: 'GET', literal_kind: 'string', container: 'buildUrl', enclosing_symbol_uid: 'uid:buildUrl' })
    expect(db.prepare('SELECT value FROM metadata WHERE key = ?')
      .get(`${CODE_INDEX_METADATA_EXPORT_FINGERPRINT_PREFIX}src/app.ts`))
      .toEqual({ value: 'fp-app-1' })
  })

  it('accepts the plain-record byFile form and skips files without a graph entry', async () => {
    const db = await memory()
    const result = writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/rec.ts', ['body']), fileUpsert('src/plain.ts', ['body'])],
      graph: {
        byFile: {
          'src/rec.ts': fileGraphDelta({
            symbols: [symbolRow('src/rec.ts', 'recordForm', 'uid:recordForm')],
          }),
        },
      },
    })
    expect(result.symbolsWritten).toBe(1)
    expect((db.prepare("SELECT COUNT(*) AS n FROM symbols WHERE file_path = 'src/plain.ts'").get() as { n: number }).n).toBe(0)
    expect((db.prepare("SELECT COUNT(*) AS n FROM symbols WHERE file_path = 'src/rec.ts'").get() as { n: number }).n).toBe(1)
  })

  it('replaces graph rows and the fingerprint on re-upsert without double-mirroring symbols_fts', async () => {
    const db = await memory()
    writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/again.ts', ['v1'])],
      graph: {
        byFile: new Map([
          ['src/again.ts', fileGraphDelta({
            symbols: [symbolRow('src/again.ts', 'fnA', 'uid:fnA')],
            exportFingerprint: 'fp-v1',
          })],
        ]),
      },
    })
    // Re-upsert: the writer deletes symbols explicitly (firing the symbols_fts
    // triggers exactly once per doomed row) BEFORE the files cascade deletes
    // zero remaining symbol rows — a double delete must stay invisible.
    const result = writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/again.ts', ['v2'])],
      graph: {
        byFile: new Map([
          ['src/again.ts', fileGraphDelta({
            symbols: [symbolRow('src/again.ts', 'fnB', 'uid:fnB'), symbolRow('src/again.ts', 'fnC', 'uid:fnC')],
            exportFingerprint: 'fp-v2',
          })],
        ]),
      },
    })
    expect(result.symbolsWritten).toBe(2)
    expect(count(db, 'SELECT COUNT(*) AS n FROM symbols')).toBe(2)
    expect(count(db, 'SELECT COUNT(*) AS n FROM symbols_fts')).toBe(2)
    expect(count(db, "SELECT COUNT(*) AS n FROM symbols WHERE name = 'fnA'")).toBe(0)
    expect(db.prepare('SELECT value FROM metadata WHERE key = ?')
      .get(`${CODE_INDEX_METADATA_EXPORT_FINGERPRINT_PREFIX}src/again.ts`))
      .toEqual({ value: 'fp-v2' })
  })

  it('drops every file-owned graph row and the fingerprint on removal but keeps test edges', async () => {
    const db = await memory()
    writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/gone.ts', ['body'])],
      graph: {
        byFile: new Map([
          ['src/gone.ts', fileGraphDelta({
            symbols: [symbolRow('src/gone.ts', 'fnG', 'uid:fnG')],
            imports: [importRow('src/gone.ts', './x')],
            callEdges: [callEdgeRow('src/gone.ts', 'edge:g', 'uid:fnG', null, 3)],
            symbolRefs: [symbolRefRow('src/gone.ts', 'ref:g', 'uid:fnG')],
            literals: [literalRow('src/gone.ts', 'lit:g', 'POST')],
            exportFingerprint: 'fp-gone',
          })],
        ]),
      },
    })
    writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/other.ts', ['body'])],
      graph: {
        byFile: new Map([
          ['src/other.ts', fileGraphDelta({
            testEdges: [testEdgeRow('edge:keep', 'src/other.spec.ts', 'src/gone.ts', null, null)],
          })],
        ]),
      },
    })

    const result = writeFilesDelta(db, { removals: ['src/gone.ts'], upserts: [] })
    expect(result.removedFiles).toBe(1)
    expect(storageCounts(db)).toEqual({
      files: 1,
      chunks: 1,
      chunks_fts: 1,
      files_fts: 1,
      file_paths_fts: 1,
      symbols: 0,
      symbols_fts: 0,
      imports: 0,
      symbol_refs: 0,
      call_edges: 0,
      // test_edges are path pairs, not file-owned rows: they survive removals.
      test_edges: 1,
      literal_index: 0,
    })
    expect(db.prepare('SELECT value FROM metadata WHERE key = ?')
      .get(`${CODE_INDEX_METADATA_EXPORT_FINGERPRINT_PREFIX}src/gone.ts`)).toBeUndefined()
    // Null reason/confidence persist as SQL NULL; the reader maps them to ''/0.
    expect(db.prepare('SELECT reason, confidence FROM test_edges').get())
      .toEqual({ reason: null, confidence: null })
  })

  it('commits the graph half inside the single epoch-bumped transaction and rolls it back on failure', async () => {
    const db = await memory()
    const before = readEpochs(db)
    writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/tx.ts', ['body'])],
      graph: {
        byFile: new Map([
          ['src/tx.ts', fileGraphDelta({
            symbols: [symbolRow('src/tx.ts', 'fnT', 'uid:fnT')],
          })],
        ]),
      },
    })
    assertExactAdvance(before, readEpochs(db), 'index')

    // A duplicate symbol id violates the primary key mid-unit; nothing persists.
    const duplicate = symbolRow('src/boom.ts', 'dup', 'uid:dup')
    const broken = fileGraphDelta({
      symbols: [duplicate, { ...symbolRow('src/boom.ts', 'dup2', 'uid:dup2'), symbolId: duplicate.symbolId }],
    })
    expect(() => writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/boom.ts', ['body'])],
      graph: { byFile: new Map([['src/boom.ts', broken]]) },
    })).toThrow(/UNIQUE|primary key/i)
    expect(count(db, 'SELECT COUNT(*) AS n FROM symbols')).toBe(1)
    expect(count(db, 'SELECT COUNT(*) AS n FROM files')).toBe(1)
    expect(readEpochs(db)).toEqual({ indexEpoch: 1, evidenceEpoch: 0, embeddingEpoch: 0 })
  })
})

describe('writeResolvedEdges', () => {
  const opened: Array<import('node:sqlite').DatabaseSync> = []
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close()
  })

  async function seeded(): Promise<import('node:sqlite').DatabaseSync> {
    const db = await openCodeIndexDatabase(':memory:')
    opened.push(db)
    writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/app.ts', ['body']), fileUpsert('src/lib.ts', ['body'])],
      graph: {
        byFile: new Map([
          ['src/app.ts', fileGraphDelta({
            callEdges: [callEdgeRow('src/app.ts', 'edge:stale', 'uid:caller', null, 3)],
            symbolRefs: [symbolRefRow('src/app.ts', 'ref:stale', 'uid:gone')],
          })],
        ]),
      },
    })
    return db
  }

  function edgeRows(db: import('node:sqlite').DatabaseSync): Array<Record<string, unknown>> {
    return db.prepare(
      'SELECT edge_id, target_symbol_id, target_file_path, callee_symbol_uid, resolution_kind, '
      + 'resolution_confidence, resolution_strategy, is_optional_chain, is_awaited, is_constructor '
      + 'FROM call_edges ORDER BY edge_id',
    ).all()
  }

  function refRows(db: import('node:sqlite').DatabaseSync): Array<Record<string, unknown>> {
    return db.prepare(
      'SELECT ref_id, target_symbol_id, target_file_path, target_symbol_uid, resolution_kind '
      + 'FROM symbol_refs ORDER BY ref_id',
    ).all()
  }

  it('replaces both edge row sets per file inside one epoch-bumped transaction', async () => {
    const db = await seeded()
    const before = readEpochs(db)
    const resolvedEdge = {
      ...callEdgeRow('src/app.ts', 'edge:bound', 'uid:caller', 'uid:callee', 5),
      targetSymbolId: 'sym:callee',
      targetFilePath: 'src/lib.ts',
      calleeSymbolUid: 'uid:callee',
      resolutionKind: 'exact',
      resolutionConfidence: 1,
      resolutionStrategy: 'exact',
      isOptionalChain: true,
      isAwaited: false,
      isConstructor: true,
    }
    const resolvedRef = {
      ...symbolRefRow('src/app.ts', 'ref:bound', 'uid:callee'),
      targetSymbolId: 'sym:callee',
      targetFilePath: 'src/lib.ts',
      resolutionKind: 'exact',
    }
    const result = writeResolvedEdges(db, [{
      filePath: 'src/app.ts',
      callEdges: [resolvedEdge],
      symbolRefs: [resolvedRef],
    }])
    expect(result).toEqual({ filesTouched: 1, callEdgesWritten: 1, symbolRefsWritten: 1 })
    assertExactAdvance(before, readEpochs(db), 'index')
    expect(edgeRows(db)).toEqual([{
      edge_id: 'edge:bound',
      target_symbol_id: 'sym:callee',
      target_file_path: 'src/lib.ts',
      callee_symbol_uid: 'uid:callee',
      resolution_kind: 'exact',
      resolution_confidence: 1,
      resolution_strategy: 'exact',
      is_optional_chain: 1,
      is_awaited: 0,
      is_constructor: 1,
    }])
    expect(refRows(db)).toEqual([{
      ref_id: 'ref:bound',
      target_symbol_id: 'sym:callee',
      target_file_path: 'src/lib.ts',
      target_symbol_uid: 'uid:callee',
      resolution_kind: 'exact',
    }])
    // Only the two resolver-owned tables moved; symbols, imports, test edges,
    // and the base rows stay exactly as the delta path wrote them.
    expect(storageCounts(db)).toMatchObject({
      files: 2,
      chunks: 2,
      symbols: 0,
      imports: 0,
      symbol_refs: 1,
      call_edges: 1,
      test_edges: 0,
      literal_index: 0,
    })
  })

  it('treats an omitted category as an empty replacement and batches multiple files', async () => {
    const db = await seeded()
    writeResolvedEdges(db, [
      { filePath: 'src/app.ts', callEdges: [callEdgeRow('src/app.ts', 'edge:only', null, null, 1)] },
      { filePath: 'src/lib.ts' },
    ])
    expect(edgeRows(db).map(row => row.edge_id)).toEqual(['edge:only'])
    expect(refRows(db)).toEqual([])
    expect(readEpochs(db)).toEqual({ indexEpoch: 2, evidenceEpoch: 0, embeddingEpoch: 0 })
  })

  it('rolls back completely when an update names a path without a files row', async () => {
    const db = await seeded()
    const before = readEpochs(db)
    expect(() => writeResolvedEdges(db, [
      { filePath: 'src/lib.ts', callEdges: [callEdgeRow('src/lib.ts', 'edge:fine', null, null, 1)] },
      { filePath: 'src/never-indexed.ts', symbolRefs: [symbolRefRow('src/never-indexed.ts', 'ref:x', null)] },
    ])).toThrow(/FOREIGN|foreign key/i)
    expect(edgeRows(db).map(row => row.edge_id)).toEqual(['edge:stale'])
    expect(refRows(db).map(row => row.ref_id)).toEqual(['ref:stale'])
    expect(readEpochs(db)).toEqual(before)
  })
})
