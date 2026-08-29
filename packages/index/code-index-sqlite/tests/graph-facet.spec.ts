import { afterEach, describe, expect, it } from 'vitest'
import { openCodeIndexDatabase } from '../src/open.ts'
import { createGraphReadFacet, createRetrievalPort } from '../src/reader.ts'
import { writeFilesDelta } from '../src/writer.ts'
import type { DatabaseSync } from 'node:sqlite'
import type { FileGraphDelta } from '../src/writer.ts'
import {
  callEdgeRow,
  fileGraphDelta,
  fileUpsert,
  importRow,
  literalRow,
  symbolRefRow,
  symbolRow,
  testEdgeRow,
} from './support.ts'

/**
 * Contracts for the graph read facet over real SQL: seed ordering, per-seed
 * window truncation, IN-batching, LIKE escaping, degree aggregation, and the
 * unordered impacted-test projection.
 */
describe('createGraphReadFacet', () => {
  const opened: Array<DatabaseSync> = []
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close()
  })

  async function memory(): Promise<DatabaseSync> {
    const db = await openCodeIndexDatabase(':memory:')
    opened.push(db)
    return db
  }

  /** Seed the shared two-file graph fixture used by most contracts below. */
  async function seeded(): ReturnType<typeof createFacet> {
    const db = await memory()
    const routerGraph: FileGraphDelta = fileGraphDelta({
      symbols: [
        symbolRow('src/app/router.ts', 'routeRequest', 'uid:routeRequest'),
        symbolRow('src/app/router.ts', 'dispatch', 'uid:dispatch'),
        symbolRow('src/app/router.ts', 'a%b_c\\d', 'uid:weird'),
      ],
      imports: [
        importRow('src/app/router.ts', './helpers'),
        { ...importRow('src/app/router.ts', './reexports'), isReexport: true, isDefault: false, isNamespace: true, resolvedPath: null, importedName: null, alias: null },
      ],
      callEdges: [
        callEdgeRow('src/app/router.ts', 'edge:r1', 'uid:routeRequest', 'uid:dispatch', 12),
        callEdgeRow('src/app/router.ts', 'edge:r2', 'uid:routeRequest', 'uid:stableHash', 5),
        callEdgeRow('src/app/router.ts', 'edge:r3', 'uid:routeRequest', 'uid:other1', 20),
        callEdgeRow('src/app/router.ts', 'edge:r4', 'uid:routeRequest', 'uid:other2', 30),
        callEdgeRow('src/app/router.ts', 'edge:d1', 'uid:callerB', 'uid:dispatch', 7),
        { ...callEdgeRow('src/app/router.ts', 'edge:d2', 'uid:callerC', 'uid:dispatch', 3), isOptionalChain: true, isAwaited: false, isConstructor: true },
      ],
      symbolRefs: [
        symbolRefRow('src/app/router.ts', 'ref:1', 'uid:stableHash'),
        symbolRefRow('src/app/router.ts', 'ref:2', 'uid:stableHash'),
      ],
      literals: [
        literalRow('src/app/router.ts', 'lit:late', 'POST'),
        { ...literalRow('src/app/router.ts', 'lit:early', 'PUT'), line: 4 },
      ],
      exportFingerprint: 'fp-router',
    })
    const utilGraph = fileGraphDelta({
      symbols: [
        symbolRow('src/app/util.ts', 'stableHash', 'uid:stableHash'),
        symbolRow('src/app/util.ts', 'Request', 'uid:Request'),
        // uid-less rows seed fine and surface with an empty uid.
        { ...symbolRow('src/app/util.ts', 'requestUtils', null), isDefaultExport: true },
      ],
    })
    writeFilesDelta(db, {
      removals: [],
      upserts: [
        fileUpsert('src/app/router.ts', ['routeRequest body', 'dispatch body']),
        fileUpsert('src/app/util.ts', ['stableHash body']),
      ],
      graph: {
        byFile: new Map([
          ['src/app/router.ts', routerGraph],
          ['src/app/util.ts', utilGraph],
        ]),
      },
    })
    writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/app/pairs.ts', ['pairs body'])],
      graph: {
        byFile: new Map([
          ['src/app/pairs.ts', fileGraphDelta({
            testEdges: [
              testEdgeRow('tedge:1', 'src/app/router.spec.ts', 'src/app/router.ts', 'direct import', 0.9),
              testEdgeRow('tedge:2', 'src/app/util.spec.ts', 'src/app/util.ts', null, null),
            ],
          })],
        ]),
      },
    })
    return createFacet(db)
  }

  async function createFacet(db: DatabaseSync) {
    return { db, facet: createGraphReadFacet(db) }
  }

  it('seeds symbols through symbols_fts with exact-first, shortest-name ordering and LIKE escaping', async () => {
    const { facet } = await seeded()
    // 'request' matches all three names case-insensitively; the exact hit
    // leads, the length tie breaks alphabetically, and the uid-less row
    // surfaces with an empty uid.
    const seeds = facet.symbolSeedHits('request', 10)
    expect(seeds.map(hit => hit.name)).toEqual(['Request', 'requestUtils', 'routeRequest'])
    expect(seeds[0]).toEqual({ symbolUid: 'uid:Request', name: 'Request', score: 1 })
    expect(seeds[1]).toMatchObject({ symbolUid: '', name: 'requestUtils' })
    expect(seeds[2]?.score).toBeLessThan(1)
    expect(facet.symbolSeedHits('request', 1)).toEqual([seeds[0]])

    // `%`, `_`, and `\` match literally instead of acting as wildcards.
    expect(facet.symbolSeedHits('%', 10).map(hit => hit.name)).toEqual(['a%b_c\\d'])
    expect(facet.symbolSeedHits('b_c', 10).map(hit => hit.name)).toEqual(['a%b_c\\d'])
    expect(facet.symbolSeedHits('b\\_c', 10)).toEqual([])
    expect(facet.symbolSeedHits('nomatch', 10)).toEqual([])
  })

  it('resolves exact names case-sensitively with dedup, deterministic order, and a cap', async () => {
    const { facet } = await seeded()
    const rows = facet.symbolUidsByExactNames(['stableHash', 'missing', 'routeRequest', 'stableHash'], 10)
    expect(rows.map(row => row.name)).toEqual(['routeRequest', 'stableHash'])
    expect(rows[0]).toMatchObject({
      symbolId: 'sym:src/app/router.ts:routeRequest',
      symbolUid: 'uid:routeRequest',
      kind: 'function',
      filePath: 'src/app/router.ts',
      container: 'outerScope',
      startLine: 10,
      endLine: 20,
    })
    // Lowercase input never matches: exactness is case-sensitive.
    expect(facet.symbolUidsByExactNames(['routerequest'], 10)).toEqual([])
    expect(facet.symbolUidsByExactNames(['routeRequest', 'stableHash', 'dispatch'], 2).map(row => row.name))
      .toEqual(['dispatch', 'routeRequest'])
    expect(facet.symbolUidsByExactNames([], 5)).toEqual([])
  })

  it('truncates call edges per seed through the line-ordered window on both sides', async () => {
    const { facet } = await seeded()
    const callers = facet.callerRowsByUids(['uid:routeRequest', 'uid:callerB'], 2)
    // Four outgoing edges exist for routeRequest; the window keeps the two
    // lowest lines. Seeds return in sorted order; unknown seeds contribute
    // nothing.
    expect(callers.map(row => [row.seedUid, row.line])).toEqual([
      ['uid:callerB', 7],
      ['uid:routeRequest', 5],
      ['uid:routeRequest', 12],
    ])
    expect(callers[1]).toMatchObject({
      callerSymbolUid: 'uid:routeRequest',
      calleeSymbolUid: 'uid:stableHash',
      callerSymbol: 'callerFn',
      calleeSymbol: 'calleeFn',
      resolutionKind: 'resolved',
      dispatchKind: 'direct',
      callKind: 'direct',
    })

    const callees = facet.calleeRowsByUids(['uid:dispatch'], 2)
    expect(callees.map(row => [row.seedUid, row.line])).toEqual([
      ['uid:dispatch', 3],
      ['uid:dispatch', 7],
    ])
    expect(callees[0]?.calleeSymbolUid).toBe('uid:dispatch')
    expect(facet.callerRowsByUids(['uid:unknown'], 3)).toEqual([])
    expect(facet.callerRowsByUids([], 3)).toEqual([])
  })

  it('projects the stored resolution strategy and confidence onto edge rows', async () => {
    const { facet } = await seeded()
    const rows = facet.callerRowsByUids(['uid:routeRequest'], 10)
    for (const row of rows) {
      expect(row).toMatchObject({ resolutionStrategy: 'local-exact', resolutionConfidence: 0.8 })
    }
  })

  it('batches uid lists past the 200-variable budget without losing rows', async () => {
    const db = await memory()
    const paths = Array.from({ length: 201 }, (_, index) => `src/bulk/${index}.ts`)
    const byFile = new Map(paths.map(path => [
      path,
      fileGraphDelta({
        symbols: [symbolRow(path, `fnBulk${path}`, `uid:${path}`)],
        callEdges: [callEdgeRow(path, `edge:${path}`, `uid:${path}`, null, 1)],
      }),
    ]))
    writeFilesDelta(db, { removals: [], upserts: paths.map(path => fileUpsert(path, [path])), graph: { byFile } })

    const { facet } = await createFacet(db)
    const rows = facet.callerRowsByUids(paths.map(path => `uid:${path}`), 1)
    expect(rows).toHaveLength(201)
    expect(rows.every(row => row.callerSymbolUid?.startsWith('uid:src/bulk/'))).toBe(true)

    const symbols = facet.symbolRowsByUids(paths.map(path => `uid:${path}`))
    expect(symbols).toHaveLength(201)

    // A small cap stops batch iteration once satisfied: the second batch never runs.
    const names = paths.map(path => `fnBulk${path}`)
    expect(facet.symbolUidsByExactNames(names, 5)).toHaveLength(5)
  })

  it('aggregates degrees and ref counts with zero defaults for graph-absent uids', async () => {
    const { facet } = await seeded()
    const degrees = facet.symbolDegreeDetailsBatch(['uid:routeRequest', 'uid:dispatch', 'uid:stableHash', 'uid:absent'])
    // Rows return per sorted uid; stableHash absorbs both references and one
    // inbound call edge.
    expect(degrees).toEqual([
      { symbolUid: 'uid:absent', inDegree: 0, outDegree: 0, refCount: 0 },
      { symbolUid: 'uid:dispatch', inDegree: 3, outDegree: 0, refCount: 0 },
      { symbolUid: 'uid:routeRequest', inDegree: 0, outDegree: 4, refCount: 0 },
      { symbolUid: 'uid:stableHash', inDegree: 1, outDegree: 0, refCount: 2 },
    ])
    expect(facet.symbolDegreeDetailsBatch([])).toEqual([])
  })

  it('projects chunk spans, symbols, and imports per file in deterministic order', async () => {
    const { facet } = await seeded()
    expect(facet.chunkSpansForFiles(['src/app/router.ts', 'src/app/vacant.ts'])).toEqual([
      { filePath: 'src/app/router.ts', chunkId: 'chunk:src/app/router.ts:0', startLine: 1, endLine: 10 },
      { filePath: 'src/app/router.ts', chunkId: 'chunk:src/app/router.ts:1', startLine: 11, endLine: 20 },
    ])
    const symbols = facet.symbolsByFilePaths(['src/app/router.ts'])
    expect(symbols.map(row => row.name)).toEqual(['routeRequest', 'dispatch', 'a%b_c\\d'])
    const imports = facet.importsByFilePaths(['src/app/router.ts'])
    expect(imports).toEqual([
      {
        filePath: 'src/app/router.ts',
        importString: './helpers',
        resolvedPath: 'src/resolved.ts',
        importedName: 'helper',
        alias: 'h',
        isNamespace: false,
        isDefault: true,
        isReexport: false,
      },
      {
        filePath: 'src/app/router.ts',
        importString: './reexports',
        resolvedPath: null,
        importedName: null,
        alias: null,
        isNamespace: true,
        isDefault: false,
        isReexport: true,
      },
    ])
    expect(facet.chunkSpansForFiles(['src/app/vacant.ts'])).toEqual([])
    expect(facet.symbolsByFilePaths([])).toEqual([])
    expect(facet.importsByFilePaths([])).toEqual([])
  })

  it('answers impacted tests unordered and uncapped, mapping null reason/confidence to empty values', async () => {
    const { facet } = await seeded()
    const rows = [...facet.findImpactedTests(['src/app/router.ts', 'src/app/util.ts'])]
    expect(rows.map(row => [row.testFilePath, row.codeFilePath]).sort()).toEqual([
      ['src/app/router.spec.ts', 'src/app/router.ts'],
      ['src/app/util.spec.ts', 'src/app/util.ts'],
    ])
    const routerPair = rows.find(row => row.codeFilePath === 'src/app/router.ts')
    expect(routerPair).toMatchObject({ reason: 'direct import', confidence: 0.9 })
    const utilPair = rows.find(row => row.codeFilePath === 'src/app/util.ts')
    expect(utilPair).toMatchObject({ reason: '', confidence: 0 })
    expect(facet.findImpactedTests(['src/app/vacant.ts'])).toEqual([])
    expect(facet.findImpactedTests([])).toEqual([])
  })

  it('reads export fingerprints back only for files that carry one', async () => {
    const { facet } = await seeded()
    expect(facet.exportFingerprints(['src/app/router.ts', 'src/app/util.ts'])).toEqual([
      { filePath: 'src/app/router.ts', fingerprint: 'fp-router' },
    ])
    expect(facet.exportFingerprints([])).toEqual([])
  })

  it('projects literal rows ordered by line', async () => {
    const { facet } = await seeded()
    expect(facet.literalRowsByFilePaths(['src/app/router.ts'])).toEqual([
      expect.objectContaining({ literalId: 'lit:early', literal: 'PUT', line: 4 }),
      expect.objectContaining({ literalId: 'lit:late', literal: 'POST', line: 7 }),
    ])
    expect(facet.literalRowsByFilePaths([])).toEqual([])
  })

  it('rides on every retrieval port as its graph facet', async () => {
    const { db, facet } = await seeded()
    const port = createRetrievalPort(db)
    expect(port.graph).not.toBe(facet)
    expect(port.graph.symbolSeedHits('request', 10).map(hit => hit.name))
      .toEqual(['Request', 'requestUtils', 'routeRequest'])
  })

  describe('analysis reads for the cycles and dead_code ops', () => {
    /** Build a store holding bare files plus resolved/unresolved import rows. */
    async function importFixture(
      imports: ReadonlyArray<{ from: string; to: string | null; importString: string }>,
    ): Promise<DatabaseSync> {
      const db = await memory()
      const paths = [...new Set(imports.flatMap(row => [row.from, ...(row.to === null ? [] : [row.to])]))]
      for (const path of paths) {
        db.prepare(
          'INSERT INTO files (file_path, language, content_hash, mtime, size, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
        ).run(path, 'typescript', `hash-${path}`, 1, 10, '2026-01-01')
      }
      for (const row of imports) {
        db.prepare(
          'INSERT INTO imports (file_path, import_string, resolved_path, imported_name, alias, is_namespace, is_default, is_reexport) '
          + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        ).run(row.from, row.importString, row.to, null, null, 0, 0, 0)
      }
      return db
    }

    it('projects the full import adjacency with resolved edges only, targets deduplicated and sorted', async () => {
      const db = await importFixture([
        { from: 'src/a.ts', to: 'src/b.ts', importString: './b' },
        { from: 'src/a.ts', to: 'src/c.ts', importString: './c' },
        { from: 'src/a.ts', to: 'src/b.ts', importString: './b-again' },
        { from: 'src/b.ts', to: 'src/a.ts', importString: './a' },
        { from: 'src/d.ts', to: null, importString: './missing' },
      ])
      const adjacency = createGraphReadFacet(db).fileImportAdjacency()
      expect(adjacency.get('src/a.ts')).toEqual(['src/b.ts', 'src/c.ts'])
      expect(adjacency.get('src/b.ts')).toEqual(['src/a.ts'])
      // Target-only files and unresolved imports contribute no entries.
      expect(adjacency.has('src/c.ts')).toBe(false)
      expect(adjacency.has('src/d.ts')).toBe(false)
      expect(createGraphReadFacet(await memory()).fileImportAdjacency().size).toBe(0)
    })

    it('bounds the dead-code symbol scan and computes both reverse-lookup facts', async () => {
      const db = await memory()
      db.prepare(
        'INSERT INTO files (file_path, language, content_hash, mtime, size, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('src/dead.ts', 'typescript', 'hash', 1, 10, '2026-01-01')
      db.prepare(
        'INSERT INTO files (file_path, language, content_hash, mtime, size, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('src/other.ts', 'typescript', 'hash-other', 1, 10, '2026-01-01')
      const insertSymbol = db.prepare(
        'INSERT INTO symbols (symbol_id, file_path, name, kind, start_line, end_line, symbol_uid) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      insertSymbol.run('s-called', 'src/dead.ts', 'calledFn', 'function', 1, 2, 'uid:calledFn')
      insertSymbol.run('s-self', 'src/dead.ts', 'selfLoopFn', 'function', 3, 4, 'uid:selfLoopFn')
      insertSymbol.run('s-ext', 'src/dead.ts', 'externallyRefdFn', 'function', 5, 6, 'uid:externallyRefdFn')
      insertSymbol.run('s-selfref', 'src/dead.ts', 'selfRefdFn', 'function', 7, 8, 'uid:selfRefdFn')
      insertSymbol.run('s-orphan', 'src/dead.ts', 'orphanFn', 'function', 9, 10, 'uid:orphanFn')
      insertSymbol.run('s-nouid', 'src/dead.ts', 'noUidFn', 'function', 11, 12, null)
      const insertEdge = db.prepare(
        'INSERT INTO call_edges (edge_id, file_path, caller_symbol_uid, callee_symbol_uid, line) VALUES (?, ?, ?, ?, ?)',
      )
      // A non-self caller keeps calledFn alive; a self-loop does NOT count as
      // a caller for selfLoopFn (the reference's non-self comparison).
      insertEdge.run('e1', 'src/dead.ts', 'uid:callerX', 'uid:calledFn', 3)
      insertEdge.run('e2', 'src/dead.ts', 'uid:selfLoopFn', 'uid:selfLoopFn', 1)
      const insertRef = db.prepare(
        'INSERT INTO symbol_refs (ref_id, file_path, container, target_symbol_uid, line) VALUES (?, ?, ?, ?, ?)',
      )
      // An external container (and a missing one) marks the reference
      // external; a container equal to the symbol's own name does not.
      insertRef.run('r1', 'src/other.ts', 'someoneElse', 'uid:externallyRefdFn', 2)
      insertRef.run('r2', 'src/dead.ts', 'selfRefdFn', 'uid:selfRefdFn', 4)

      const facet = createGraphReadFacet(db)
      const rows = facet.analysisSymbolRows(100)
      expect(rows.map(row => row.name)).toEqual([
        'calledFn', 'selfLoopFn', 'externallyRefdFn', 'selfRefdFn', 'orphanFn', 'noUidFn',
      ])
      expect(rows.map(row => [row.hasCaller, row.hasExternalRef])).toEqual([
        [true, false], [false, false], [false, true], [false, false], [false, false], [false, false],
      ])
      expect(rows.find(row => row.name === 'noUidFn')?.symbolUid).toBe('')
      // The scan limit caps rows in store order.
      expect(facet.analysisSymbolRows(2).map(row => row.name)).toEqual(['calledFn', 'selfLoopFn'])
      expect(facet.analysisSymbolRows(0)).toEqual([])
    })

    it('returns witness edges whose both endpoints are inside the queried set', async () => {
      const db = await importFixture([
        { from: 'src/a.ts', to: 'src/b.ts', importString: './b' },
        { from: 'src/a.ts', to: 'src/b.ts', importString: './b-again' },
        { from: 'src/b.ts', to: 'src/a.ts', importString: './a' },
        { from: 'src/c.ts', to: 'src/d.ts', importString: './d' },
      ])
      const facet = createGraphReadFacet(db)
      expect(facet.internalEdgesForUids(['src/a.ts', 'src/b.ts'])).toEqual([
        { from: 'src/a.ts', to: 'src/b.ts', importString: './b' },
        { from: 'src/a.ts', to: 'src/b.ts', importString: './b-again' },
        { from: 'src/b.ts', to: 'src/a.ts', importString: './a' },
      ])
      // An edge leaving the set is not a witness.
      expect(facet.internalEdgesForUids(['src/c.ts'])).toEqual([])
      expect(facet.internalEdgesForUids([])).toEqual([])
    })

    it('keeps edge projection nulls for rows written without a resolution strategy', async () => {
      const db = await memory()
      db.prepare(
        'INSERT INTO files (file_path, language, content_hash, mtime, size, indexed_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('src/plain.ts', 'typescript', 'hash', 1, 10, '2026-01-01')
      db.prepare(
        'INSERT INTO symbols (symbol_id, file_path, name, kind, start_line, end_line, symbol_uid) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('s1', 'src/plain.ts', 'callerFn', 'function', 1, 2, 'uid:callerFn')
      db.prepare(
        'INSERT INTO symbols (symbol_id, file_path, name, kind, start_line, end_line, symbol_uid) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run('s2', 'src/plain.ts', 'targetFn', 'function', 4, 5, 'uid:targetFn')
      db.prepare(
        'INSERT INTO call_edges (edge_id, file_path, caller_symbol_uid, callee_symbol_uid, line) VALUES (?, ?, ?, ?, ?)',
      ).run('e1', 'src/plain.ts', 'uid:callerFn', 'uid:targetFn', 3)
      const rows = createGraphReadFacet(db).callerRowsByUids(['uid:callerFn'], 5)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.resolutionStrategy).toBeNull()
      expect(rows[0]?.resolutionConfidence).toBeNull()
    })
  })
})
