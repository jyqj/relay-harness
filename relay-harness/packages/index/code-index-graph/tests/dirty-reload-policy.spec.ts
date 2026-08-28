/**
 * Dirty-reload policy contracts: the complete per-category policy table, and
 * {@link reloadEdgesForFiles} reading a real store's edge rows back into the
 * resolver's re-resolve input.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openCodeIndexDatabase } from '@relay-harness/rlh-code-index-sqlite'
import type { FileGraphDelta, FileUpsert } from '@relay-harness/rlh-code-index-sqlite'
import { writeFilesDelta } from '@relay-harness/rlh-code-index-sqlite'
import { catalogRowFromParse } from '../src/store/writer.ts'
import { RELOADED_EDGE_CATEGORIES, catalogRowFromStored, classifyReloadPolicy, reloadEdgesForFiles } from '../src/dirty/reload-policy.ts'
import type { CatalogSymbolRow } from '@relay-harness/rlh-code-index-search'
import type { SymbolRecord } from '@relay-harness/rlh-code-index-parser'

const opened: DatabaseSync[] = []
afterEach(() => {
  while (opened.length > 0) opened.pop()?.close()
})

async function memory(): Promise<DatabaseSync> {
  const db = await openCodeIndexDatabase(':memory:')
  opened.push(db)
  return db
}

function fileUpsert(path: string): FileUpsert {
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
      endLine: 10,
      breadcrumb: '',
      symbolName: null,
      symbolKind: null,
      text: `body of ${path}`,
      tokenEstimate: 8,
    }],
  }
}

function graphWithEdges(path: string): FileGraphDelta {
  return {
    symbols: [{
      symbolId: `sym:${path}:run`,
      filePath: path,
      name: 'run',
      kind: 'function',
      container: null,
      startLine: 1,
      endLine: 4,
      startCol: 0,
      endCol: 10,
      signature: 'function run()',
      doc: null,
      parserTier: 'semantic',
      parserConfidence: 0.85,
      qname: 'run',
      parentSymbolId: null,
      exportName: 'run',
      isDefaultExport: false,
      symbolUid: `uid:${path}:run`,
      frameworkRole: null,
      receiverType: null,
      paramTypes: null,
      returnType: null,
      paramCount: 0,
      baseTypes: null,
      implements: null,
    }],
    imports: [{
      filePath: path,
      importString: './dep',
      resolvedPath: 'src/dep.ts',
      importedName: 'dep',
      alias: null,
      isNamespace: false,
      isDefault: false,
      isReexport: false,
    }],
    callEdges: [{
      edgeId: `edge:${path}:1`,
      filePath: path,
      callerSymbol: 'run',
      calleeSymbol: 'dep',
      line: 2,
      startCol: 4,
      targetSymbolId: 'sym:src/dep.ts:dep',
      targetFilePath: 'src/dep.ts',
      callerSymbolId: `sym:${path}:run`,
      callerSymbolUid: `uid:${path}:run`,
      calleeSymbolUid: 'uid:src/dep.ts:dep',
      dispatchKind: 'direct',
      callKind: 'imported',
      resolutionKind: 'exact',
      resolutionConfidence: 1,
      resolutionStrategy: 'import_map',
      receiverExpr: null,
      argCount: 0,
      isOptionalChain: false,
      isAwaited: false,
      isConstructor: false,
      parserTier: 'semantic',
      parserConfidence: 0.85,
    }],
    symbolRefs: [{
      refId: `ref:${path}:1`,
      filePath: path,
      symbolName: 'dep',
      container: null,
      refKind: 'identifier',
      line: 3,
      col: 2,
      targetSymbolId: 'sym:src/dep.ts:dep',
      targetFilePath: 'src/dep.ts',
      targetSymbolUid: 'uid:src/dep.ts:dep',
      refName: null,
      resolutionKind: 'exact',
      resolutionConfidence: 1,
      resolutionStrategy: 'import_map',
      parserTier: 'semantic',
      parserConfidence: 0.85,
    }],
    testEdges: [],
    literals: [],
  }
}

describe('classifyReloadPolicy', () => {
  it('keeps local state and clears every resolver-owned category', () => {
    expect(classifyReloadPolicy()).toEqual({
      symbols: 'keep',
      imports: 'keep',
      callEdges: 'clear',
      symbolRefs: 'clear',
    })
  })

  it('declares a policy for every category of the closed union', () => {
    expect(RELOADED_EDGE_CATEGORIES).toEqual(['symbols', 'imports', 'callEdges', 'symbolRefs'])
    const table = classifyReloadPolicy()
    for (const category of RELOADED_EDGE_CATEGORIES) {
      expect(table[category]).toMatch(/^(?:keep|clear)$/u)
    }
  })
})

describe('reloadEdgesForFiles', () => {
  it('normalizes NULL stored columns to the resolver unset markers and groups sibling rows', async () => {
    const db = await memory()
    const path = 'src/nulls.ts'
    const nulls: FileGraphDelta = {
      ...graphWithEdges(path),
      callEdges: [
        { ...graphWithEdges(path).callEdges[0] as NonNullable<FileGraphDelta['callEdges']>[number], edgeId: 'edge:n1', calleeSymbol: null, line: null, resolutionKind: null, resolutionConfidence: null, resolutionStrategy: null, parserTier: null, parserConfidence: null },
        { ...graphWithEdges(path).callEdges[0] as NonNullable<FileGraphDelta['callEdges']>[number], edgeId: 'edge:n2' },
      ],
      symbolRefs: [
        { ...graphWithEdges(path).symbolRefs[0] as NonNullable<FileGraphDelta['symbolRefs']>[number], refId: 'ref:n1', symbolName: null, col: null, refKind: null, resolutionKind: null, resolutionConfidence: null, resolutionStrategy: null, parserTier: null, parserConfidence: null },
      ],
    }
    writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert(path)],
      graph: { byFile: new Map([[path, nulls]]) },
    })

    const app = reloadEdgesForFiles(db, [path])[0]
    expect(app?.callEdges).toHaveLength(2)
    expect(app?.callEdges[0]).toMatchObject({
      calleeSymbol: '',
      line: 0,
      // A NULL stored kind stays null through the projection; the clear
      // policy overwrites it before resolution ever sees the row.
      resolutionKind: null,
      resolutionConfidence: 0,
      resolutionStrategy: '',
      parserTier: null,
      parserConfidence: 0,
    })
    expect(app?.symbolRefs[0]).toMatchObject({
      symbolName: '',
      col: null,
      refKind: null,
      resolutionKind: null,
      resolutionConfidence: 0,
      resolutionStrategy: '',
      parserTier: null,
      parserConfidence: 0,
    })
  })


  it('reads stored edges and imports back per file, verbatim, with vacant files present', async () => {
    const db = await memory()
    writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/app.ts'), fileUpsert('src/vacant.ts')],
      graph: { byFile: new Map([['src/app.ts', graphWithEdges('src/app.ts')]]) },
    })

    const reloaded = reloadEdgesForFiles(db, ['src/app.ts', 'src/vacant.ts', 'src/unknown.ts'])
    expect(reloaded.map(file => file.filePath)).toEqual(['src/app.ts', 'src/vacant.ts', 'src/unknown.ts'])

    const app = reloaded[0] as Awaited<ReturnType<typeof reloadEdgesForFiles>>[number]
    expect(app.callEdges).toHaveLength(1)
    expect(app.callEdges[0]).toMatchObject({
      edgeId: 'edge:src/app.ts:1',
      filePath: 'src/app.ts',
      calleeSymbol: 'dep',
      line: 2,
      startCol: 4,
      targetSymbolId: 'sym:src/dep.ts:dep',
      calleeSymbolUid: 'uid:src/dep.ts:dep',
      dispatchKind: 'direct',
      resolutionKind: 'exact',
      resolutionConfidence: 1,
      resolutionStrategy: 'import_map',
      isOptionalChain: false,
      parserTier: 'semantic',
    })
    expect(app.symbolRefs).toHaveLength(1)
    expect(app.symbolRefs[0]).toMatchObject({
      refId: 'ref:src/app.ts:1',
      targetSymbolId: 'sym:src/dep.ts:dep',
      targetSymbolUid: 'uid:src/dep.ts:dep',
      resolutionKind: 'exact',
      col: 2,
      refKind: 'identifier',
    })
    expect(app.imports).toEqual([{
      filePath: 'src/app.ts',
      importString: './dep',
      resolvedPath: 'src/dep.ts',
      importedName: 'dep',
      alias: null,
      isNamespace: false,
      isDefault: false,
      isReexport: false,
    }])

    // Files without edge rows reload as empty entries, never as absent ones.
    expect(reloaded[1]).toMatchObject({ filePath: 'src/vacant.ts', callEdges: [], symbolRefs: [], imports: [] })
    expect(reloaded[2]).toMatchObject({ filePath: 'src/unknown.ts', callEdges: [], symbolRefs: [], imports: [] })
  })

  it('answers an empty file list with no reads', async () => {
    const db = await memory()
    expect(reloadEdgesForFiles(db, [])).toEqual([])
  })
})

describe('catalogRowFromParse', () => {
  it('maps a parsed symbol onto the catalog registration row with explicit nulls', () => {
    const record: SymbolRecord = {
      symbolId: 'sym:a.ts:foo',
      filePath: 'a.ts',
      name: 'foo',
      kind: 'function',
      container: null,
      startLine: 1,
      endLine: 4,
      startCol: 0,
      endCol: 12,
      signature: 'function foo()',
      parserTier: 'semantic',
      parserConfidence: 0.85,
      qname: 'foo',
      parentSymbolId: null,
      exportName: 'foo',
      isDefaultExport: false,
      symbolUid: 'uid:a.ts:foo',
      frameworkRole: null,
      receiverType: null,
      paramTypes: null,
      returnType: null,
      paramCount: 0,
    }
    expect(catalogRowFromParse(record)).toEqual({
      symbolId: 'sym:a.ts:foo',
      symbolUid: 'uid:a.ts:foo',
      name: 'foo',
      kind: 'function',
      filePath: 'a.ts',
      container: null,
      qname: 'foo',
      isDefaultExport: false,
      startLine: 1,
      endLine: 4,
      exportName: 'foo',
      receiverType: null,
      paramCount: 0,
      baseTypes: null,
      implements: null,
      scopeId: null,
    })
  })
})

describe('catalogRowFromStored', () => {
  it('maps a full stored row and normalizes absent resolution columns to null', () => {
    const full: CatalogSymbolRow = {
      symbolId: 'sym:a.ts:foo',
      symbolUid: 'uid:a.ts:foo',
      name: 'foo',
      kind: 'function',
      filePath: 'a.ts',
      container: null,
      startLine: 1,
      endLine: 2,
      qname: 'foo',
      signature: 'function foo()',
      exportName: 'foo',
      isDefaultExport: false,
      receiverType: 'Client',
      paramCount: 2,
      baseTypes: 'Base',
      implements: 'IFoo',
      scopeId: null,
    }
    expect(catalogRowFromStored(full)).toEqual({
      symbolId: 'sym:a.ts:foo',
      symbolUid: 'uid:a.ts:foo',
      name: 'foo',
      kind: 'function',
      filePath: 'a.ts',
      container: null,
      qname: 'foo',
      isDefaultExport: false,
      startLine: 1,
      endLine: 2,
      exportName: 'foo',
      receiverType: 'Client',
      paramCount: 2,
      baseTypes: 'Base',
      implements: 'IFoo',
      scopeId: null,
    })

    const sparse: CatalogSymbolRow = {
      symbolId: 'sym:b.ts:bar',
      symbolUid: null,
      name: 'bar',
      kind: 'class',
      filePath: 'b.ts',
      container: null,
      startLine: 3,
      endLine: 9,
      qname: null,
      signature: null,
    }
    expect(catalogRowFromStored(sparse)).toEqual({
      symbolId: 'sym:b.ts:bar',
      symbolUid: null,
      name: 'bar',
      kind: 'class',
      filePath: 'b.ts',
      container: null,
      qname: null,
      isDefaultExport: false,
      startLine: 3,
      endLine: 9,
      exportName: null,
      receiverType: null,
      paramCount: null,
      baseTypes: null,
      implements: null,
      scopeId: null,
    })
  })
})
