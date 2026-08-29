/**
 * End-to-end dirty-propagation contracts over a real store: fingerprint-diff
 * seeding, removal seeding, re-export chains through the closure, the
 * promotion budget, and the exact re-resolution write-back the promoted
 * files receive.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openCodeIndexDatabase, readEpochs, writeFilesDelta } from '@relay-harness/rlh-code-index-sqlite'
import type { FileGraphDelta, FileUpsert, SymbolRowInput } from '@relay-harness/rlh-code-index-sqlite'
import { SymbolCatalog, createSymbolResolver, runDirtyPropagation } from '../src/index.ts'
import type { SymbolResolver } from '../src/index.ts'
import { computeExportFingerprint } from '../src/dirty/export-fingerprint.ts'
import { catalogRowFromStored } from '../src/dirty/reload-policy.ts'
import { createGraphReadFacet } from '@relay-harness/rlh-code-index-sqlite'

const opened: DatabaseSync[] = []
afterEach(() => {
  while (opened.length > 0) opened.pop()?.close()
})

async function memory(): Promise<DatabaseSync> {
  const db = await openCodeIndexDatabase(':memory:')
  opened.push(db)
  return db
}

function upsert(path: string): FileUpsert {
  return {
    filePath: path,
    language: 'typescript',
    contentHash: `hash-${path}`,
    mtime: 1.5,
    size: 64,
    summary: `summary for ${path}`,
    contentExcerpt: '',
    parserTier: 'semantic',
    parserConfidence: 0.85,
    isTestFile: false,
    chunks: [{
      chunkId: `chunk:${path}:0`,
      chunkIndex: 0,
      startLine: 1,
      endLine: 4,
      breadcrumb: '',
      symbolName: null,
      symbolKind: null,
      text: `body of ${path}`,
      tokenEstimate: 8,
    }],
  }
}

function symbol(filePath: string, name: string, uid: string, exportName: string | null): SymbolRowInput {
  return {
    symbolId: `sym:${filePath}:${name}`,
    filePath,
    name,
    kind: 'function',
    container: null,
    startLine: 1,
    endLine: 4,
    startCol: 0,
    endCol: 12,
    signature: `function ${name}()`,
    doc: null,
    parserTier: 'semantic',
    parserConfidence: 0.85,
    qname: name,
    parentSymbolId: null,
    exportName,
    isDefaultExport: false,
    symbolUid: uid,
    frameworkRole: null,
    receiverType: null,
    paramTypes: null,
    returnType: null,
    paramCount: 0,
    baseTypes: null,
    implements: null,
  }
}

interface ImportSpec {
  readonly from: string
  readonly target: string
  readonly reexport?: boolean
}

interface EdgeSpec {
  readonly file: string
  readonly edgeId: string
  readonly callee: string
  readonly caller?: string | null
  readonly target?: { readonly id: string; readonly file: string; readonly uid: string }
}

/**
 * Build one file's graph half: exported symbols, resolved imports, and call
 * edges seeded with the given (stale) resolution state.
 */
function graph(
  path: string,
  symbols: readonly SymbolRowInput[],
  imports: readonly ImportSpec[],
  edges: readonly EdgeSpec[],
): FileGraphDelta {
  return {
    symbols,
    imports: imports.map(spec => ({
      filePath: path,
      importString: `./${spec.target.replace(/\.ts$/u, '')}`,
      resolvedPath: spec.target,
      importedName: 'beta',
      alias: null,
      isNamespace: false,
      isDefault: false,
      isReexport: spec.reexport === true,
    })),
    callEdges: edges.map(edge => ({
      edgeId: edge.edgeId,
      filePath: edge.file,
      callerSymbol: edge.caller === undefined ? 'caller' : edge.caller,
      calleeSymbol: edge.callee,
      line: 2,
      startCol: 2,
      targetSymbolId: edge.target?.id ?? null,
      targetFilePath: edge.target?.file ?? null,
      callerSymbolId: edge.caller === null ? null : `sym:${edge.file}:caller`,
      callerSymbolUid: edge.caller === null ? null : `uid:${edge.file}:caller`,
      calleeSymbolUid: edge.target?.uid ?? null,
      dispatchKind: null,
      callKind: null,
      resolutionKind: edge.target === undefined ? 'unresolved' : 'exact',
      resolutionConfidence: edge.target === undefined ? 0 : 1,
      resolutionStrategy: edge.target === undefined ? '' : 'import_map',
      receiverExpr: null,
      argCount: null,
      isOptionalChain: false,
      isAwaited: false,
      isConstructor: false,
      parserTier: 'semantic',
      parserConfidence: 0.85,
    })),
    symbolRefs: [],
    testEdges: [],
    literals: [],
    exportFingerprint: computeExportFingerprint(symbols),
  }
}

/** Resolver over a catalog lazily fed from the store's committed symbol rows. */
function resolverOn(db: DatabaseSync): SymbolResolver {
  const facet = createGraphReadFacet(db)
  const catalog = new SymbolCatalog()
  return createSymbolResolver({
    catalog,
    loadSymbolsForFiles: (files) => {
      const missing = files.filter(file => !catalog.byFile.has(file))
      if (missing.length === 0) return
      const rows = facet.symbolsByFilePaths(missing)
      if (rows.length > 0) catalog.addSymbols(rows.map(catalogRowFromStored))
    },
  })
}

describe('runDirtyPropagation', () => {
  it('promotes the importer of an export-changed file and re-resolves its edge to the new symbol', async () => {
    const db = await memory()
    const aV1 = graph('a.ts', [symbol('a.ts', 'beta', 'uid:a.ts:beta', 'beta')], [], [])
    const bV1 = graph('b.ts', [symbol('b.ts', 'caller', 'uid:b.ts:caller', 'caller')], [{ from: 'b.ts', target: 'a.ts' }], [
      { file: 'b.ts', edgeId: 'edge:b:1', callee: 'beta', target: { id: 'sym:a.ts:beta', file: 'a.ts', uid: 'uid:a.ts:beta' } },
    ])
    writeFilesDelta(db, {
      removals: [],
      upserts: [upsert('a.ts'), upsert('b.ts')],
      graph: { byFile: new Map([['a.ts', aV1], ['b.ts', bV1]]) },
    })

    // The next build rewrites a.ts with a second exported symbol: its
    // fingerprint moves, b.ts does not change.
    const aV2 = graph('a.ts', [
      symbol('a.ts', 'beta', 'uid:a.ts:beta:v2', 'beta'),
      symbol('a.ts', 'gamma', 'uid:a.ts:gamma', 'gamma'),
    ], [], [])
    const before = readEpochs(db)
    writeFilesDelta(db, {
      removals: [],
      upserts: [upsert('a.ts')],
      graph: { byFile: new Map([['a.ts', aV2]]) },
    })

    const resolver = resolverOn(db)
    const report = runDirtyPropagation({
      db,
      resolver,
      removedPaths: [],
      reparsedFiles: ['a.ts'],
      previousFingerprints: new Map([['a.ts', computeExportFingerprint(aV1.symbols)]]),
    })

    expect(report.status).toBe('normal')
    expect(report.marked).toBe(1)
    expect(report.promotedFiles).toEqual(['b.ts'])
    expect(report.roundsRun).toBe(1)
    expect(report.partial).toBe(false)
    expect(report.budgetExceeded).toBe(false)

    // Exactly one extra commit: the re-resolution write-back.
    expect(readEpochs(db).indexEpoch - before.indexEpoch).toBe(2)
    const edge = db.prepare(
      'SELECT target_symbol_id, target_file_path, callee_symbol_uid, resolution_kind, resolution_confidence, resolution_strategy '
      + 'FROM call_edges WHERE edge_id = ?',
    ).get('edge:b:1') as Record<string, string | number | null>
    expect(edge).toEqual({
      target_symbol_id: 'sym:a.ts:beta',
      target_file_path: 'a.ts',
      callee_symbol_uid: 'uid:a.ts:beta:v2',
      resolution_kind: 'scope_resolved',
      resolution_confidence: 0.85,
      resolution_strategy: 'import_map',
    })
  })

  it('clears the importer edge back to unresolved when the dependency is removed', async () => {
    const db = await memory()
    const aV1 = graph('a.ts', [symbol('a.ts', 'beta', 'uid:a.ts:beta', 'beta')], [], [])
    const bV1 = graph('b.ts', [symbol('b.ts', 'caller', 'uid:b.ts:caller', 'caller')], [{ from: 'b.ts', target: 'a.ts' }], [
      { file: 'b.ts', edgeId: 'edge:b:1', callee: 'beta', target: { id: 'sym:a.ts:beta', file: 'a.ts', uid: 'uid:a.ts:beta' } },
    ])
    writeFilesDelta(db, {
      removals: [],
      upserts: [upsert('a.ts'), upsert('b.ts')],
      graph: { byFile: new Map([['a.ts', aV1], ['b.ts', bV1]]) },
    })
    const before = readEpochs(db)
    writeFilesDelta(db, { removals: ['a.ts'], upserts: [] })

    const resolver = resolverOn(db)
    const report = runDirtyPropagation({
      db,
      resolver,
      removedPaths: ['a.ts'],
      reparsedFiles: [],
      previousFingerprints: new Map(),
    })

    expect(report.status).toBe('normal')
    expect(report.promotedFiles).toEqual(['b.ts'])
    const edge = db.prepare(
      'SELECT target_symbol_id, callee_symbol_uid, resolution_kind, resolution_confidence, resolution_strategy '
      + 'FROM call_edges WHERE edge_id = ?',
    ).get('edge:b:1') as Record<string, string | number | null>
    // The cleared row re-enters the resolver, whose default backfill stamps
    // the pristine `unresolved` strategy — indistinguishable from a freshly
    // parsed row that found no target.
    expect(edge).toEqual({
      target_symbol_id: null,
      callee_symbol_uid: null,
      resolution_kind: 'unresolved',
      resolution_confidence: 0,
      resolution_strategy: 'unresolved',
    })
    expect(readEpochs(db).indexEpoch - before.indexEpoch).toBe(2)
  })

  it('promotes through a resolved re-export chain in two rounds', async () => {
    const db = await memory()
    // a exports; b re-exports a; c imports b.
    const seedGraphs = new Map<string, FileGraphDelta>([
      ['a.ts', graph('a.ts', [symbol('a.ts', 'beta', 'uid:a.ts:beta', 'beta')], [], [])],
      ['b.ts', graph('b.ts', [symbol('b.ts', 'fwd', 'uid:b.ts:fwd', 'fwd')], [{ from: 'b.ts', target: 'a.ts', reexport: true }], [])],
      ['c.ts', graph('c.ts', [symbol('c.ts', 'caller', 'uid:c.ts:caller', 'caller')], [{ from: 'c.ts', target: 'b.ts' }], [
        { file: 'c.ts', edgeId: 'edge:c:1', callee: 'beta', target: { id: 'sym:a.ts:beta', file: 'a.ts', uid: 'uid:a.ts:beta' } },
      ])],
    ])
    writeFilesDelta(db, {
      removals: [],
      upserts: [upsert('a.ts'), upsert('b.ts'), upsert('c.ts')],
      graph: { byFile: seedGraphs },
    })

    const aV2 = graph('a.ts', [
      symbol('a.ts', 'beta', 'uid:a.ts:beta:v2', 'beta'),
      symbol('a.ts', 'gamma', 'uid:a.ts:gamma', 'gamma'),
    ], [], [])
    writeFilesDelta(db, { removals: [], upserts: [upsert('a.ts')], graph: { byFile: new Map([['a.ts', aV2]]) } })

    const resolver = resolverOn(db)
    const report = runDirtyPropagation({
      db,
      resolver,
      removedPaths: [],
      reparsedFiles: ['a.ts'],
      previousFingerprints: new Map([['a.ts', computeExportFingerprint(seedGraphs.get('a.ts')?.symbols ?? [])]]),
    })

    expect(report.status).toBe('normal')
    expect(report.promotedFiles).toEqual(['b.ts', 'c.ts'])
    expect(report.roundsRun).toBe(2)
    // Round 2's promotion must have re-bound c's edge to the moved uid.
    const edge = db.prepare('SELECT callee_symbol_uid FROM call_edges WHERE edge_id = ?').get('edge:c:1') as
      | { callee_symbol_uid: string | null }
    expect(edge.callee_symbol_uid).toBe('uid:a.ts:beta:v2')
  })

  it('keeps a budget-sized prefix and reports budget_exceeded when round one overflows', async () => {
    const db = await memory()
    const byFile = new Map<string, FileGraphDelta>([
      ['a.ts', graph('a.ts', [symbol('a.ts', 'beta', 'uid:a.ts:beta', 'beta')], [], [])],
    ])
    for (const importer of ['i1.ts', 'i2.ts', 'i3.ts']) {
      byFile.set(importer, graph(importer, [symbol(importer, 'caller', `uid:${importer}:caller`, 'caller')], [{ from: importer, target: 'a.ts' }], []))
    }
    writeFilesDelta(db, { removals: [], upserts: [...byFile.keys()].map(upsert), graph: { byFile } })

    const aV2 = graph('a.ts', [symbol('a.ts', 'beta', 'uid:a.ts:beta:v2', 'beta')], [], [])
    const before = readEpochs(db)
    writeFilesDelta(db, { removals: [], upserts: [upsert('a.ts')], graph: { byFile: new Map([['a.ts', aV2]]) } })

    const report = runDirtyPropagation({
      db,
      resolver: resolverOn(db),
      removedPaths: [],
      reparsedFiles: ['a.ts'],
      previousFingerprints: new Map([['a.ts', computeExportFingerprint(byFile.get('a.ts')?.symbols ?? [])]]),
      config: { enabled: true, maxFiles: 2 },
    })

    expect(report.status).toBe('budget_exceeded')
    expect(report.budgetExceeded).toBe(true)
    expect(report.promotedFiles).toEqual(['i1.ts', 'i2.ts'])
    expect(report.partial).toBe(false)
    // The partial apply still committed its re-resolution transactions.
    expect(readEpochs(db).indexEpoch).toBeGreaterThan(before.indexEpoch)
  })

  it('reports disabled without touching the store', async () => {
    const db = await memory()
    const before = readEpochs(db)
    const report = runDirtyPropagation({
      db,
      resolver: resolverOn(db),
      removedPaths: [],
      reparsedFiles: ['a.ts'],
      previousFingerprints: new Map(),
      config: { enabled: false },
    })
    expect(report).toEqual({
      marked: 0,
      promotedFiles: [],
      roundsRun: 0,
      partial: false,
      budgetExceeded: false,
      status: 'disabled',
    })
    expect(readEpochs(db)).toEqual(before)
  })

  it('reports a trivially converged normal closure when fingerprints are unchanged', async () => {
    const db = await memory()
    const aV1 = graph('a.ts', [symbol('a.ts', 'beta', 'uid:a.ts:beta', 'beta')], [], [])
    writeFilesDelta(db, { removals: [], upserts: [upsert('a.ts')], graph: { byFile: new Map([['a.ts', aV1]]) } })
    const before = readEpochs(db)

    const report = runDirtyPropagation({
      db,
      resolver: resolverOn(db),
      removedPaths: [],
      reparsedFiles: ['a.ts'],
      previousFingerprints: new Map([['a.ts', computeExportFingerprint(aV1.symbols)]]),
    })

    expect(report.status).toBe('normal')
    expect(report.marked).toBe(0)
    expect(readEpochs(db)).toEqual(before)
  })

  it('never promotes a file that this build itself reparsed', async () => {
    const db = await memory()
    const aV1 = graph('a.ts', [symbol('a.ts', 'beta', 'uid:a.ts:beta', 'beta')], [], [])
    const bV1 = graph('b.ts', [], [{ from: 'b.ts', target: 'a.ts' }], [])
    writeFilesDelta(db, {
      removals: [],
      upserts: [upsert('a.ts'), upsert('b.ts')],
      graph: { byFile: new Map([['a.ts', aV1], ['b.ts', bV1]]) },
    })
    const before = readEpochs(db)

    // Both files re-parsed, both fingerprints moved: neither is promotable.
    const aV2 = graph('a.ts', [symbol('a.ts', 'beta', 'uid:a.ts:beta:v2', 'beta')], [], [])
    const bV2 = graph('b.ts', [symbol('b.ts', 'caller', 'uid:b.ts:caller', 'caller')], [{ from: 'b.ts', target: 'a.ts' }], [])
    writeFilesDelta(db, {
      removals: [],
      upserts: [upsert('a.ts'), upsert('b.ts')],
      graph: { byFile: new Map([['a.ts', aV2], ['b.ts', bV2]]) },
    })
    const report = runDirtyPropagation({
      db,
      resolver: resolverOn(db),
      removedPaths: [],
      reparsedFiles: ['a.ts', 'b.ts'],
      previousFingerprints: new Map([
        ['a.ts', computeExportFingerprint(aV1.symbols)],
        ['b.ts', computeExportFingerprint(bV1.symbols)],
      ]),
    })

    expect(report.marked).toBe(0)
    expect(report.promotedFiles).toEqual([])
    expect(readEpochs(db).indexEpoch - before.indexEpoch).toBe(1)
  })

  it('walks the same-round sibling re-export chain b -> z -> a -> c', async () => {
    const db = await memory()
    // b exports; z re-exports b; a imports b AND re-exports z; c imports a.
    const seed = new Map<string, FileGraphDelta>([
      ['b.ts', graph('b.ts', [symbol('b.ts', 'beta', 'uid:b.ts:beta', 'beta')], [], [])],
      ['z.ts', graph('z.ts', [symbol('z.ts', 'zfwd', 'uid:z.ts:zfwd', 'zfwd')], [{ from: 'z.ts', target: 'b.ts', reexport: true }], [])],
      ['a.ts', graph('a.ts', [symbol('a.ts', 'afwd', 'uid:a.ts:afwd', 'afwd')], [
        { from: 'a.ts', target: 'b.ts' },
        { from: 'a.ts', target: 'z.ts', reexport: true },
      ], [])],
      ['c.ts', graph('c.ts', [symbol('c.ts', 'caller', 'uid:c.ts:caller', 'caller')], [{ from: 'c.ts', target: 'a.ts' }], [])],
    ])
    writeFilesDelta(db, {
      removals: [],
      upserts: [...seed.keys()].map(upsert),
      graph: { byFile: seed },
    })

    const bV2 = graph('b.ts', [symbol('b.ts', 'beta', 'uid:b.ts:beta:v2', 'beta')], [], [])
    writeFilesDelta(db, { removals: [], upserts: [upsert('b.ts')], graph: { byFile: new Map([['b.ts', bV2]]) } })

    // a.ts already sits in the catalog from an earlier stage: the phase must
    // evict the stale registration before re-resolving.
    const resolver = resolverOn(db)
    resolver.catalog.addSymbols((seed.get('a.ts')?.symbols ?? []).map(catalogRowFromStored))

    const report = runDirtyPropagation({
      db,
      resolver,
      removedPaths: [],
      reparsedFiles: ['b.ts'],
      previousFingerprints: new Map([['b.ts', computeExportFingerprint(seed.get('b.ts')?.symbols ?? [])]]),
    })

    expect(report.status).toBe('normal')
    // Round 1 promotes a and z (sorted); a's surface only flips after z
    // enters the changed set, and round 2 promotes a's importer c.
    expect(report.promotedFiles).toEqual(['a.ts', 'z.ts', 'c.ts'])
    expect(report.roundsRun).toBe(2)
  })

  it('seeds a newly parsed file with no previous fingerprint and promotes importers of a symbol-less file', async () => {
    const db = await memory()
    // First build: a.ts carries the export, bare.ts imports it but declares
    // no symbols of its own, imp.ts calls the export through bare's re-export.
    const first = new Map<string, FileGraphDelta>([
      ['a.ts', graph('a.ts', [symbol('a.ts', 'beta', 'uid:a.ts:beta', 'beta')], [], [])],
      // Two-step forwarding: bare re-exports a's surface, so its own
      // effective surface changes when a's moves.
      ['bare.ts', graph('bare.ts', [], [{ from: 'bare.ts', target: 'a.ts', reexport: true }], [])],
      // imp declares no symbols either; the phase must tolerate a promoted
      // batch whose facet rows carry no catalog registrations.
      ['imp.ts', graph('imp.ts', [], [{ from: 'imp.ts', target: 'bare.ts' }], [
        { file: 'imp.ts', edgeId: 'edge:imp:1', callee: 'beta', caller: null, target: { id: 'sym:a.ts:beta', file: 'a.ts', uid: 'uid:a.ts:beta' } },
      ])],
    ])
    writeFilesDelta(db, {
      removals: [],
      upserts: [...first.keys()].map(upsert),
      graph: { byFile: first },
    })

    // Second build: a.ts loses its export surface entirely — its ledger entry
    // clears, so the post-write read answers null against the old hash.
    const emptyA = graph('a.ts', [], [], [])
    writeFilesDelta(db, { removals: [], upserts: [upsert('a.ts')], graph: { byFile: new Map([['a.ts', emptyA]]) } })

    const report = runDirtyPropagation({
      db,
      resolver: resolverOn(db),
      removedPaths: [],
      reparsedFiles: ['a.ts'],
      previousFingerprints: new Map([['a.ts', computeExportFingerprint(first.get('a.ts')?.symbols ?? [])]]),
    })

    // bare.ts (no symbols of its own) still promotes and forwards the closure
    // to its importer imp.ts.
    expect(report.promotedFiles).toEqual(['bare.ts', 'imp.ts'])
    expect(report.status).toBe('normal')
  })

  it('reports a trivially converged closure when nothing was reparsed or removed', async () => {
    const db = await memory()
    const before = readEpochs(db)
    const report = runDirtyPropagation({
      db,
      resolver: resolverOn(db),
      removedPaths: [],
      reparsedFiles: [],
      previousFingerprints: new Map(),
    })
    expect(report).toEqual({
      marked: 0,
      promotedFiles: [],
      roundsRun: 0,
      partial: false,
      budgetExceeded: false,
      status: 'normal',
    })
    expect(readEpochs(db)).toEqual(before)
  })
})
