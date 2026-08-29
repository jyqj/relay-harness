/**
 * Five-stage incremental e2e over a real workspace and a real store: an edit
 * to one exporter promotes only its importer to re-resolution, a deleted
 * export rolls the importer's edge back to unresolved, and the test-edge
 * rebuild lands the path-pair rows once the batch changes the stored path
 * set. Every pass's index-epoch count is audited exactly.
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { SymbolCatalog, catalogRowFromStored, createSymbolResolver, runDirtyPropagation } from '@relay-harness/rlh-code-index-graph'
import type { SymbolResolver } from '@relay-harness/rlh-code-index-graph'
import { createRetrievalPort, readEpochs } from '@relay-harness/rlh-code-index-sqlite'
import { DEFAULT_INCLUDE_PATTERNS } from '../src/scanner.ts'
import { buildExclusionStack, loadIndexedSnapshot, openStore, runRefreshPass } from '../src/indexer.ts'
import type { RefreshPassInputs } from '../src/indexer.ts'
import { makeWorkspace, sweepWorkspaces } from './support.ts'

afterEach(sweepWorkspaces)

const A_V1 = 'export function foo(): number {\n  return 1\n}\n'
// The signature change moves foo's symbol uid, making the rebind observable.
const A_V2 = 'export function foo(next: number): number {\n  return next\n}\n'
const B_V1 = "import { foo } from './a'\n\nexport function bar(): number {\n  return foo()\n}\n"

interface Harness {
  readonly db: DatabaseSync
  readonly resolver: SymbolResolver
  readonly inputs: (
    previousGeneration: ReadonlyMap<string, { mtimeMs: number; size: number; contentHash: string }>,
  ) => Promise<RefreshPassInputs>
}

/** Assemble the pass inputs exactly the way the runtime provider does. */
async function harness(root: string): Promise<Harness> {
  const store = await openStore(':memory:', 'wal')
  const port = createRetrievalPort(store.db)
  const facet = port.graph
  const catalog = new SymbolCatalog()
  const resolver = createSymbolResolver({
    catalog,
    loadSymbolsForFiles: (files) => {
      const missing = files.filter(file => !catalog.byFile.has(file))
      if (missing.length === 0) return
      const rows = facet.symbolsByFilePaths(missing)
      if (rows.length > 0) catalog.addSymbols(rows.map(catalogRowFromStored))
    },
  })
  const exclusionFilters = await buildExclusionStack(root, [])
  return {
    db: store.db,
    resolver,
    inputs: async previousGeneration => ({
      db: store.db,
      workspaceRoot: root,
      includePatterns: DEFAULT_INCLUDE_PATTERNS,
      exclusionFilters,
      maxFileBytes: 512_000,
      previousGeneration,
      graph: facet,
      resolver,
    }),
  }
}

/** The single call edge b.ts carries toward a's `foo`, with its resolution columns. */
function fooEdge(db: DatabaseSync): Record<string, string | number | null> {
  const row = db.prepare(
    'SELECT target_symbol_id, target_file_path, callee_symbol_uid, resolution_kind, resolution_confidence, '
    + 'resolution_strategy FROM call_edges WHERE file_path = ? AND callee_symbol = ?',
  ).get('b.ts', 'foo') as Record<string, string | number | null> | undefined
  expect(row, 'b.ts must carry a call edge toward foo').toBeDefined()
  return row as Record<string, string | number | null>
}

function aFoo(db: DatabaseSync): { symbol_id: string; symbol_uid: string } {
  const row = db.prepare(
    "SELECT symbol_id, symbol_uid FROM symbols WHERE file_path = 'a.ts' AND name = 'foo'",
  ).get() as { symbol_id: string; symbol_uid: string } | undefined
  expect(row, 'a.ts must still declare foo').toBeDefined()
  return row as { symbol_id: string; symbol_uid: string }
}

describe('five-stage incremental pipeline', () => {
  it('re-resolves only the dirty closure and audits every epoch bump', async () => {
    const root = await makeWorkspace('rlh-dirty-e2e-', {
      files: {
        'a.ts': A_V1,
        'b.ts': B_V1,
        'notes.md': 'plain notes\n',
      },
    })
    const h = await harness(root)
    let epoch = readEpochs(h.db).indexEpoch

    // Pass 1 — full build: parse → resolve → write. No dirty phase runs on a
    // full build (cc: full builds carry no propagation status), and the
    // test-edge decision skips because nothing was removed.
    const pass1 = await runRefreshPass(await h.inputs(new Map()))
    expect(pass1.changedFiles).toBe(3)
    expect(pass1.symbolsWritten).toBeGreaterThan(0)
    expect(pass1.dirty).toBeNull()
    epoch += 1
    expect(readEpochs(h.db).indexEpoch).toBe(epoch)

    // The resolve stage bound b's call to a's exported foo through the
    // global-unique ladder step (top-level jsts symbols carry plain qnames).
    const v1 = aFoo(h.db)
    expect(fooEdge(h.db)).toEqual({
      target_symbol_id: v1.symbol_id,
      target_file_path: 'a.ts',
      callee_symbol_uid: v1.symbol_uid,
      resolution_kind: 'heuristic',
      resolution_confidence: 0.75,
      resolution_strategy: 'global_unique',
    })

    // Pass 2 — a.ts's export signature moves: exactly b.ts is promoted.
    await writeFile(join(root, 'a.ts'), A_V2)
    const pass2 = await runRefreshPass(await h.inputs(loadIndexedSnapshot(h.db)))
    expect(pass2.changedPaths).toEqual(['a.ts'])
    expect(pass2.dirty).toEqual({
      status: 'normal',
      marked: 1,
      promotedFiles: ['b.ts'],
      roundsRun: 1,
      partial: false,
      budgetExceeded: false,
    })
    // One commit for the delta, one for the re-resolution write-back.
    epoch += 2
    expect(readEpochs(h.db).indexEpoch).toBe(epoch)

    const v2 = aFoo(h.db)
    expect(v2.symbol_uid).not.toBe(v1.symbol_uid)
    expect(fooEdge(h.db)).toEqual({
      target_symbol_id: v2.symbol_id,
      target_file_path: 'a.ts',
      callee_symbol_uid: v2.symbol_uid,
      resolution_kind: 'heuristic',
      resolution_confidence: 0.75,
      resolution_strategy: 'global_unique',
    })

    // Pass 3 — the export disappears entirely: the importer's edge loses its
    // target and lands back at the pristine unresolved state.
    await writeFile(join(root, 'a.ts'), 'export const gone = 3\n')
    const pass3 = await runRefreshPass(await h.inputs(loadIndexedSnapshot(h.db)))
    expect(pass3.dirty).toMatchObject({ status: 'normal', marked: 1, promotedFiles: ['b.ts'] })
    epoch += 2
    expect(readEpochs(h.db).indexEpoch).toBe(epoch)
    expect(fooEdge(h.db)).toEqual({
      target_symbol_id: null,
      target_file_path: null,
      callee_symbol_uid: null,
      resolution_kind: 'unresolved',
      resolution_confidence: 0,
      resolution_strategy: 'unresolved',
    })

    // Pass 4 — the stored path set changes (new test + code file, one
    // removal): the test-edge rebuild lands both relation strengths, and the
    // removal seeds a closure that promotes nothing (nothing imports the new
    // files or the removed notes).
    await mkdir(dirname(join(root, 'tests', 'b.test.ts')), { recursive: true })
    await writeFile(join(root, 'tests', 'b.test.ts'), "import { bar } from '../b'\ntest('b', () => {})\n")
    await mkdir(dirname(join(root, 'src', 'b_helpers.ts')), { recursive: true })
    await writeFile(join(root, 'src', 'b_helpers.ts'), 'export const helper = 1\n')
    await rm(join(root, 'notes.md'), { force: true })
    const pass4 = await runRefreshPass(await h.inputs(loadIndexedSnapshot(h.db)))
    expect([...pass4.changedPaths].sort()).toEqual(['src/b_helpers.ts', 'tests/b.test.ts'])
    expect(pass4.removedPaths).toEqual(['notes.md'])
    expect(pass4.dirty).toMatchObject({ status: 'normal', marked: 0, promotedFiles: [] })
    epoch += 2
    expect(readEpochs(h.db).indexEpoch).toBe(epoch)

    const edges = h.db.prepare(
      'SELECT code_file_path, reason, confidence FROM test_edges WHERE test_file_path = ? ORDER BY code_file_path',
    ).all('tests/b.test.ts') as Array<{ code_file_path: string; reason: string; confidence: number }>
    expect(edges).toEqual([
      { code_file_path: 'b.ts', reason: 'same-basename', confidence: 0.9 },
      { code_file_path: 'src/b_helpers.ts', reason: 'path-overlap', confidence: 0.7 },
    ])
  })

  it('routes a removed dependency through the closure and leaves the importer unresolved', async () => {
    const root = await makeWorkspace('rlh-dirty-rm-', {
      files: { 'a.ts': A_V1, 'b.ts': B_V1 },
    })
    const h = await harness(root)
    await runRefreshPass(await h.inputs(new Map()))
    let epoch = readEpochs(h.db).indexEpoch

    await rm(join(root, 'a.ts'), { force: true })
    const pass = await runRefreshPass(await h.inputs(loadIndexedSnapshot(h.db)))
    expect(pass.removedPaths).toEqual(['a.ts'])
    expect(pass.dirty).toMatchObject({ status: 'normal', marked: 1, promotedFiles: ['b.ts'] })
    // Delta + test-edge rebuild (the path set shrank) + re-resolution.
    epoch += 3
    expect(readEpochs(h.db).indexEpoch).toBe(epoch)
    expect(fooEdge(h.db)).toMatchObject({
      target_symbol_id: null,
      callee_symbol_uid: null,
      resolution_kind: 'unresolved',
    })

    // The removed file left the inventory, and an unchanged follow-up pass
    // commits nothing at all.
    const files = h.db.prepare('SELECT COUNT(*) AS n FROM files').get() as { n: number }
    expect(files.n).toBe(1)
    const idle = await runRefreshPass(await h.inputs(loadIndexedSnapshot(h.db)))
    expect(idle.changedFiles).toBe(0)
    expect(idle).toMatchObject({ skipped: true, dirty: null })
    // An unchanged pass opens no empty write transaction and freezes the epoch.
    expect(readEpochs(h.db).indexEpoch).toBe(epoch)
  })

  it('honors the promotion budget when one exporter has many importers', async () => {
    const root = await makeWorkspace('rlh-dirty-budget-', { files: { 'a.ts': A_V1 } })
    for (const index of [1, 2, 3]) {
      await writeFile(join(root, `imp${index}.ts`), `import { foo } from './a'\nexport const v${index} = foo()\n`)
    }
    const h = await harness(root)
    await runRefreshPass(await h.inputs(new Map()))

    await writeFile(join(root, 'a.ts'), A_V2)
    const report = runDirtyPropagation({
      db: h.db,
      resolver: h.resolver,
      removedPaths: [],
      reparsedFiles: ['a.ts'],
      // The stale sentinel stands in for the pre-write fingerprint: this test
      // pins the budget arithmetic, which the closure specs cover in detail.
      previousFingerprints: new Map([['a.ts', 'stale']]),
      config: { enabled: true, maxFiles: 2 },
    })
    expect(report.status).toBe('budget_exceeded')
    expect(report.promotedFiles).toEqual(['imp1.ts', 'imp2.ts'])
    expect(report.partial).toBe(false)
  })

  it('counts undecodable payloads as binary skips inside the pipeline', async () => {
    const root = await makeWorkspace('rlh-dirty-bin-', { files: { 'a.ts': A_V1 } })
    const { writeFile: writeBin } = await import('node:fs/promises')
    await writeBin(join(root, 'blob.rs'), Buffer.from([0xff, 0xfe, 0x00]))
    const h = await harness(root)
    const pass = await runRefreshPass(await h.inputs(new Map()))
    expect(pass.binarySkipped).toBe(1)
    expect(pass.changedFiles).toBe(1)
  })

  it('keeps generic-tier files on the legacy chunking path inside the pipeline', async () => {
    const root = await makeWorkspace('rlh-dirty-generic-', {
      files: { 'notes.md': 'just text\n', 'a.ts': A_V1 },
    })
    const h = await harness(root)
    const pass = await runRefreshPass(await h.inputs(new Map()))
    expect(pass.changedFiles).toBe(2)
    // The generic tier lives on the files row; the parser tier stamps both
    // the row and the symbol-aware chunks.
    const mdFile = h.db.prepare(
      "SELECT parser_tier, parser_confidence FROM files WHERE file_path = 'notes.md'",
    ).get() as { parser_tier: string; parser_confidence: number }
    expect(mdFile).toEqual({ parser_tier: 'generic', parser_confidence: 0.5 })
    const mdChunks = h.db.prepare(
      "SELECT symbol_name FROM chunks WHERE file_path = 'notes.md'",
    ).all() as Array<{ symbol_name: string | null }>
    expect(mdChunks.length).toBeGreaterThan(0)
    expect(mdChunks.every(chunk => chunk.symbol_name === null)).toBe(true)

    const tsFile = h.db.prepare(
      "SELECT parser_tier, parser_confidence FROM files WHERE file_path = 'a.ts'",
    ).get() as { parser_tier: string; parser_confidence: number }
    expect(tsFile).toEqual({ parser_tier: 'semantic', parser_confidence: 0.85 })
    const tsChunks = h.db.prepare(
      'SELECT symbol_name, breadcrumb FROM chunks WHERE file_path = ?',
    ).all('a.ts') as Array<{ symbol_name: string | null; breadcrumb: string }>
    expect(tsChunks.some(chunk => chunk.symbol_name === 'foo' && chunk.breadcrumb === 'foo')).toBe(true)
  })
})
