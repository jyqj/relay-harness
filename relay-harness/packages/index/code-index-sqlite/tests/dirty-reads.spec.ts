/**
 * Reload-view read contracts added for dirty propagation: the four graph
 * facet methods (complete edge rows, importer reverse lookup, re-export
 * targets) plus the writer's export-fingerprint ledger semantics, including
 * the empty-surface clear.
 */

import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { openCodeIndexDatabase } from '../src/open.ts'
import { createGraphReadFacet } from '../src/reader.ts'
import { readEpochs } from '../src/epoch.ts'
import { writeFilesDelta } from '../src/writer.ts'
import type { FileGraphDelta } from '../src/writer.ts'
import {
  callEdgeRow,
  fileGraphDelta,
  fileUpsert,
  importRow,
  symbolRefRow,
  symbolRow,
} from './support.ts'

const opened: DatabaseSync[] = []
afterEach(() => {
  while (opened.length > 0) opened.pop()?.close()
})

async function memory(): Promise<DatabaseSync> {
  const db = await openCodeIndexDatabase(':memory:')
  opened.push(db)
  return db
}

describe('reload-view facet reads', () => {
  async function seeded(): Promise<DatabaseSync> {
    const db = await memory()
    const routerGraph: FileGraphDelta = fileGraphDelta({
      symbols: [symbolRow('src/app/router.ts', 'routeRequest', 'uid:routeRequest')],
      imports: [
        importRow('src/app/router.ts', './helpers'),
        { ...importRow('src/app/router.ts', './barrel'), resolvedPath: 'src/app/util.ts', importedName: null, alias: null, isDefault: false, isReexport: true },
        { ...importRow('src/app/router.ts', './second'), resolvedPath: 'src/second.ts', importedName: null, alias: null, isDefault: false, isReexport: true },
      ],
      callEdges: [
        callEdgeRow('src/app/router.ts', 'edge:r1', 'uid:routeRequest', 'uid:stableHash', 12),
        { ...callEdgeRow('src/app/router.ts', 'edge:r2', 'uid:routeRequest', null, 5), isOptionalChain: true, isAwaited: false, isConstructor: true, resolutionKind: null, resolutionConfidence: null, resolutionStrategy: null, parserTier: null, parserConfidence: null },
      ],
      symbolRefs: [symbolRefRow('src/app/router.ts', 'ref:1', 'uid:stableHash')],
    })
    writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/app/router.ts', ['router body']), fileUpsert('src/app/util.ts', ['util body'])],
      graph: { byFile: new Map([['src/app/router.ts', routerGraph]]) },
    })
    return db
  }

  it('reads complete call-edge rows back per file with defaults normalized', async () => {
    const db = await seeded()
    const rows = createGraphReadFacet(db).callEdgesByFilePaths(['src/app/router.ts', 'src/app/util.ts'])
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.edgeId)).toEqual(['edge:r1', 'edge:r2'])
    expect(rows[0]).toMatchObject({
      filePath: 'src/app/router.ts',
      line: 12,
      calleeSymbolUid: 'uid:stableHash',
      isOptionalChain: false,
      parserTier: 'tree-sitter',
    })
    // Every stored column round-trips, including NULLs and the boolean trio.
    expect(rows[1]).toEqual({
      edgeId: 'edge:r2',
      filePath: 'src/app/router.ts',
      callerSymbol: 'callerFn',
      calleeSymbol: 'calleeFn',
      line: 5,
      startCol: 4,
      targetSymbolId: null,
      targetFilePath: null,
      callerSymbolId: 'sym:caller',
      callerSymbolUid: 'uid:routeRequest',
      calleeSymbolUid: null,
      dispatchKind: 'direct',
      callKind: 'direct',
      resolutionKind: null,
      resolutionConfidence: null,
      resolutionStrategy: null,
      receiverExpr: 'router',
      argCount: 2,
      isOptionalChain: true,
      isAwaited: false,
      isConstructor: true,
      parserTier: null,
      parserConfidence: null,
    })
  })

  it('reads complete symbol-ref rows back per file', async () => {
    const db = await seeded()
    const rows = createGraphReadFacet(db).symbolRefsByFilePaths(['src/app/router.ts'])
    expect(rows).toEqual([expect.objectContaining({
      refId: 'ref:1',
      filePath: 'src/app/router.ts',
      targetSymbolUid: 'uid:stableHash',
      resolutionKind: 'resolved',
      col: 8,
    })])
    expect(createGraphReadFacet(db).symbolRefsByFilePaths([])).toEqual([])
  })

  it('answers the importer reverse lookup sorted and deduplicated', async () => {
    const db = await seeded()
    // util.ts is imported by router.ts directly AND through the re-export row.
    expect(createGraphReadFacet(db).importerFilesForTargets(['src/app/util.ts', 'src/app/ghost.ts']))
      .toEqual(['src/app/router.ts'])
    expect(createGraphReadFacet(db).importerFilesForTargets(['src/second.ts']))
      .toEqual(['src/app/router.ts'])
    expect(createGraphReadFacet(db).importerFilesForTargets([])).toEqual([])
  })

  it('maps re-export targets only for files carrying resolved re-export imports', async () => {
    const db = await seeded()
    expect(createGraphReadFacet(db).reexportTargetsForFiles(['src/app/router.ts', 'src/app/util.ts']))
      .toEqual(new Map([['src/app/router.ts', ['src/app/util.ts', 'src/second.ts']]]))
    expect(createGraphReadFacet(db).reexportTargetsForFiles([])).toEqual(new Map())
  })

  it('batches past the 200-variable budget without losing rows', async () => {
    const db = await memory()
    const paths = Array.from({ length: 201 }, (_, index) => `src/bulk/${index}.ts`)
    const byFile = new Map(paths.map(path => [
      path,
      fileGraphDelta({
        symbols: [symbolRow(path, `fnBulk${path}`, `uid:${path}`)],
        imports: [{ ...importRow(path, './x'), resolvedPath: 'src/target.ts' }],
        callEdges: [callEdgeRow(path, `edge:${path}`, `uid:${path}`, null, 1)],
        symbolRefs: [symbolRefRow(path, `ref:${path}`, null)],
      }),
    ]))
    writeFilesDelta(db, { removals: [], upserts: paths.map(path => fileUpsert(path, [path])), graph: { byFile } })
    const facet = createGraphReadFacet(db)
    expect(facet.callEdgesByFilePaths(paths)).toHaveLength(201)
    expect(facet.symbolRefsByFilePaths(paths)).toHaveLength(201)
    expect(facet.importerFilesForTargets(['src/target.ts'])).toHaveLength(201)
    expect(facet.reexportTargetsForFiles(paths).size).toBe(0)
  })
})

describe('export-fingerprint ledger semantics', () => {
  it('replaces on a string, clears on null, and leaves the entry on undefined', async () => {
    const db = await memory()
    const fingerprinted = (fingerprint: string | null): FileGraphDelta => ({
      ...fileGraphDelta({}),
      exportFingerprint: fingerprint,
    })
    writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('a.ts', ['a']), fileUpsert('b.ts', ['b']), fileUpsert('c.ts', ['c'])],
      graph: {
        byFile: new Map([
          ['a.ts', fingerprinted('fp-a')],
          ['b.ts', fingerprinted('fp-b')],
          // c.ts carries no fingerprint field at all.
          ['c.ts', fileGraphDelta({})],
        ]),
      },
    })
    const readAll = (): Map<string, string> => {
      const rows = db.prepare('SELECT key, value FROM metadata WHERE key LIKE ?').all('export_fingerprint:%') as
        Array<{ key: string; value: string }>
      return new Map(rows.map(row => [row.key.replace('export_fingerprint:', ''), row.value]))
    }
    expect(readAll()).toEqual(new Map([['a.ts', 'fp-a'], ['b.ts', 'fp-b']]))

    // a gains an empty export surface (null clears), b moves (string replaces),
    // c stays untouched (undefined leaves nothing behind).
    const before = readEpochs(db)
    writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('a.ts', ['a']), fileUpsert('b.ts', ['b']), fileUpsert('c.ts', ['c'])],
      graph: {
        byFile: new Map([
          ['a.ts', fingerprinted(null)],
          ['b.ts', fingerprinted('fp-b2')],
          ['c.ts', fileGraphDelta({})],
        ]),
      },
    })
    expect(readAll()).toEqual(new Map([['b.ts', 'fp-b2']]))
    expect(readEpochs(db).indexEpoch - before.indexEpoch).toBe(1)

    // Removal drops the ledger entry alongside the file's rows.
    writeFilesDelta(db, { removals: ['b.ts'], upserts: [] })
    expect(readAll()).toEqual(new Map())
  })
})
