import { afterEach, describe, expect, it } from 'vitest'
import { assertExactAdvance, readEpochs, writeResolvedEdges } from '@relay-harness/rlh-code-index-sqlite'
import { SymbolCatalog, createSymbolResolver } from '../src/index.ts'
import { clearResolvedCallEdge, clearResolvedSymbolRef, reresolveDirtyFiles } from '../src/store/resolved-writer.ts'
import type { StoredCallEdgeRow, StoredSymbolRefRow } from '../src/store/resolved-writer.ts'
import type { ImportRow } from '../src/types.ts'
import { seededStore, storedCallEdge, storedSymbolRef, tableCount } from './store-helpers.ts'

const APP = 'src/app.ts'
const LIB = 'src/lib.ts'

/** The live catalog target: sayHi declared in src/lib.ts. */
function libSymbols() {
  return [{
    symbolId: 'sym:lib:sayHi',
    symbolUid: 'uid:lib:sayHi',
    name: 'sayHi',
    kind: 'function',
    filePath: LIB,
    container: null,
    qname: 'sayHi',
    isDefaultExport: false,
    startLine: 1,
    endLine: 5,
    exportName: 'sayHi',
    receiverType: null,
    paramCount: null,
    baseTypes: null,
    implements: null,
    scopeId: null,
  }] as const
}

/** Stored rows for the dirty file: one resolvable edge, one dead callee, one ref. */
function appRows(): { callEdges: StoredCallEdgeRow[]; symbolRefs: StoredSymbolRefRow[] } {
  return {
    callEdges: [
      storedCallEdge({ filePath: APP, edgeId: 'call:live', calleeSymbol: 'sayHi', isAwaited: true }),
      storedCallEdge({ filePath: APP, edgeId: 'call:dead', calleeSymbol: 'ghostFn', startCol: 8 }),
    ],
    symbolRefs: [storedSymbolRef({ filePath: APP, refId: 'ref:live', symbolName: 'sayHi' })],
  }
}

const appImports: ImportRow[] = [{
  filePath: APP,
  importString: './lib',
  resolvedPath: LIB,
  importedName: 'sayHi',
  alias: null,
  isNamespace: false,
  isDefault: false,
  isReexport: false,
}]

describe('clearResolvedCallEdge / clearResolvedSymbolRef', () => {
  it('drops every resolved-target column and resets the resolution triple', () => {
    const { callEdges, symbolRefs } = appRows()
    const clearedEdge = clearResolvedCallEdge(callEdges[0]!)
    expect(clearedEdge).toEqual({
      ...callEdges[0],
      targetSymbolId: null,
      targetFilePath: null,
      calleeSymbolUid: null,
      resolutionKind: 'unresolved',
      resolutionConfidence: 0,
      resolutionStrategy: '',
    })
    // targetSymbolId clears with the uid: the resolver's never-overwrite gate
    // skips rows that still carry an id, which would leave the uid dangling.
    expect(clearedEdge.targetSymbolId).toBeNull()
    const clearedRef = clearResolvedSymbolRef(symbolRefs[0]!)
    expect(clearedRef).toEqual({
      ...symbolRefs[0],
      targetSymbolId: null,
      targetFilePath: null,
      targetSymbolUid: null,
      resolutionKind: 'unresolved',
      resolutionConfidence: 0,
      resolutionStrategy: '',
    })
  })
})

describe('reresolveDirtyFiles', () => {
  const opened: Array<import('node:sqlite').DatabaseSync> = []
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close()
  })

  function resolverFor(): ReturnType<typeof createSymbolResolver> {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([...libSymbols()])
    return createSymbolResolver({ catalog })
  }

  function edgeRow(db: import('node:sqlite').DatabaseSync, edgeId: string): Record<string, unknown> {
    return db.prepare(
      'SELECT target_symbol_id, target_file_path, callee_symbol_uid, resolution_kind, '
      + 'resolution_confidence, resolution_strategy, caller_symbol_uid, is_awaited, start_col '
      + 'FROM call_edges WHERE edge_id = ?',
    ).get(edgeId) as Record<string, unknown>
  }

  it('clears, re-resolves through the catalog, and persists in one epoch-bumped transaction', async () => {
    const db = await seededStore([APP, LIB])
    opened.push(db)
    // Seed the store with the stale rows the reload would hand back.
    const { callEdges, symbolRefs } = appRows()
    writeResolvedEdges(db, [{ filePath: APP, callEdges, symbolRefs }])

    const before = readEpochs(db)
    const result = reresolveDirtyFiles(db, resolverFor(), [{
      filePath: APP,
      callEdges,
      symbolRefs,
      imports: appImports,
    }])
    assertExactAdvance(before, readEpochs(db), 'index')
    // The live call bound to the catalog symbol; its parsed-fact columns
    // (caller uid, awaited flag, start column) survived the round trip.
    expect(edgeRow(db, 'call:live')).toEqual({
      target_symbol_id: 'sym:lib:sayHi',
      target_file_path: LIB,
      callee_symbol_uid: 'uid:lib:sayHi',
      resolution_kind: 'scope_resolved',
      resolution_confidence: 0.85,
      resolution_strategy: 'import_map',
      caller_symbol_uid: 'uid:app:run',
      is_awaited: 1,
      start_col: 4,
    })
    // The dead callee stays unresolved — no stale target survived the pass.
    // The resolver backfills the cleared strategy with its unresolved default.
    expect(edgeRow(db, 'call:dead')).toEqual({
      target_symbol_id: null,
      target_file_path: null,
      callee_symbol_uid: null,
      resolution_kind: 'unresolved',
      resolution_confidence: 0,
      resolution_strategy: 'unresolved',
      caller_symbol_uid: 'uid:app:run',
      is_awaited: 0,
      start_col: 8,
    })
    expect(db.prepare(
      'SELECT target_symbol_id, target_symbol_uid, resolution_kind FROM symbol_refs',
    ).get()).toEqual({
      target_symbol_id: 'sym:lib:sayHi',
      target_symbol_uid: 'uid:lib:sayHi',
      resolution_kind: 'scope_resolved',
    })
    expect(result).toMatchObject({
      filesTouched: 1,
      callEdgesWritten: 2,
      symbolRefsWritten: 1,
      resolvedCallEdgeCount: 1,
      resolvedSymbolRefCount: 1,
    })
  })

  it('writes empty replacement sets for files without rows and keeps base rows intact', async () => {
    const db = await seededStore([APP, LIB, 'src/empty.ts'])
    opened.push(db)
    writeResolvedEdges(db, [{
      filePath: APP,
      callEdges: appRows().callEdges,
      symbolRefs: appRows().symbolRefs,
    }])

    const result = reresolveDirtyFiles(db, resolverFor(), [
      { filePath: APP, callEdges: appRows().callEdges, symbolRefs: [], imports: appImports },
      { filePath: 'src/empty.ts', callEdges: [], symbolRefs: [], imports: [] },
    ])
    expect(result.filesTouched).toBe(2)
    expect(result.symbolRefsWritten).toBe(0)
    expect(tableCount(db, 'call_edges')).toBe(2)
    expect(tableCount(db, 'symbol_refs')).toBe(0)
    expect(tableCount(db, 'files')).toBe(3)
    // Only the two resolver-owned tables moved.
    expect(tableCount(db, 'chunks')).toBe(3)
    expect(tableCount(db, 'symbols')).toBe(0)
    expect(tableCount(db, 'test_edges')).toBe(0)
  })
})
