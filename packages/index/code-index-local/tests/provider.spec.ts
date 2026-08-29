/** Runtime assembly: open/status/refresh/search lifecycle, folding, tier resize, teardown refusals. */

import { mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clampTopKToTierCap,
  LocalCodeIndexRuntime,
  mapSearchRequest,
  mergeRefreshOptions,
  normalizeRefreshPaths,
  revivePersistedRecord,
} from '../src/provider.ts'
import { makeWorkspace, sweepWorkspaces } from './support.ts'

afterEach(sweepWorkspaces)

const trackedDirs: string[] = []

afterEach(async () => {
  for (const dir of trackedDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

function runtimeFor(
  root: string,
  extra?: Partial<ConstructorParameters<typeof LocalCodeIndexRuntime>[0]>,
): LocalCodeIndexRuntime {
  return new LocalCodeIndexRuntime({
    workspaceRoot: root,
    databasePath: ':memory:',
    journalMode: 'wal',
    excludePatterns: [],
    maxFileBytes: 512_000,
    ...extra,
  })
}

describe('request mapping helpers', () => {
  it('passes scope lists through and omits absent optional keys', () => {
    const mapped = mapSearchRequest({
      query: 'token',
      paths: ['a.ts'],
      recentPaths: ['b.md'],
      boostFilePaths: ['work.ts'],
      conversationQueries: ['older', 'newer'],
      pinnedFilePaths: ['pin.ts'],
      overlayFilePaths: ['dirty.ts'],
      pathPrefix: 'src/',
    })
    expect(mapped).toEqual({
      query: 'token',
      paths: ['a.ts'],
      recentPaths: ['b.md'],
      boostFilePaths: ['work.ts'],
      conversationQueries: ['older', 'newer'],
      pinnedFilePaths: ['pin.ts'],
      overlayFilePaths: ['dirty.ts'],
      pathPrefix: 'src/',
    })
    expect(mapSearchRequest({ query: 'only' })).toEqual({ query: 'only' })
  })

  it('normalizes refresh scopes and refuses workspace escapes', () => {
    expect(normalizeRefreshPaths('/workspace', ['src/../src/a.ts', 'src/a.ts'])).toEqual(['src/a.ts'])
    expect(normalizeRefreshPaths('/workspace', ['.'])).toBeUndefined()
    expect(() => normalizeRefreshPaths('/workspace', ['../escape.ts'])).toThrow(/escapes the workspace/u)
  })

  it('merges post-scan refresh scopes and widens when any queued request is full', () => {
    expect(mergeRefreshOptions([
      { reason: 'manual', paths: ['b.ts'] },
      { reason: 'stale', paths: ['a.ts', 'b.ts'] },
    ])).toEqual({ reason: 'stale', paths: ['a.ts', 'b.ts'] })
    expect(mergeRefreshOptions([{ paths: ['a.ts'] }, { reason: 'stale' }])).toEqual({ reason: 'stale' })
    expect(mergeRefreshOptions([{ paths: ['a.ts'] }, { forceRebuild: true }])).toEqual({
      reason: 'manual',
      forceRebuild: true,
    })
  })

  it('clamps explicit topK into the tier cap; undefined stays undefined', () => {
    expect(clampTopKToTierCap(undefined, 'tiny')).toBeUndefined()
    expect(clampTopKToTierCap(3, 'tiny')).toBe(3)
    expect(clampTopKToTierCap(99, 'tiny')).toBe(5)
    expect(clampTopKToTierCap(0, 'small')).toBe(1)
  })

  it('revives only well-formed persisted summaries', () => {
    const good = {
      reason: 'stale',
      changedFiles: 1,
      removedFiles: 2,
      chunksWritten: 3,
      durationMs: 4,
      epochsAfter: { indexEpoch: 5, evidenceEpoch: 0 },
    }
    expect(revivePersistedRecord(good)).toEqual(good)
    expect(revivePersistedRecord(null)).toBeUndefined()
    expect(revivePersistedRecord('text')).toBeUndefined()
    expect(revivePersistedRecord({ ...good, reason: 7 })).toBeUndefined()
    expect(revivePersistedRecord({ ...good, chunksWritten: null })).toBeUndefined()
    expect(revivePersistedRecord({ ...good, epochsAfter: { indexEpoch: 1 } })).toBeUndefined()
    expect(revivePersistedRecord({ changedFiles: 1 })).toBeUndefined()
  })
})

describe('LocalCodeIndexRuntime', () => {
  it('reports a zeroed pre-index status and lazily builds on first search', async () => {
    const root = await makeWorkspace('rlh-rt-lazy-', {
      files: { 'src/greeter.ts': 'export function quantizedHarmonicStride() { return 42 }\n' },
    })
    const runtime = runtimeFor(root)
    await runtime.ensureOpen()
    const before = runtime.status()
    expect(before.indexedFileCount).toBe(0)
    expect(before.tier).toBe('tiny')
    expect(before.lastRefresh).toBeUndefined()
    expect(before.epochs).toEqual({ indexEpoch: 0, evidenceEpoch: 0, embeddingEpoch: 0 })

    const answer = await runtime.search({ query: 'quantizedHarmonicStride' }, new AbortController().signal)
    expect(answer.hits.length).toBeGreaterThan(0)
    expect(answer.hits[0]?.filePath).toBe('src/greeter.ts')
    expect(answer.epochs.indexEpoch).toBeGreaterThanOrEqual(1)
    await runtime.dispose()
  })

  it('hydrates current source by content hash and rejects watcher-lagged revisions', async () => {
    const root = await makeWorkspace('rlh-rt-hydrate-', {
      files: { 'src/current.ts': 'export const sourceVerifiedNeedle = 1\n' },
    })
    const runtime = runtimeFor(root)
    const answer = await runtime.search({ query: 'sourceVerifiedNeedle' })
    const hit = answer.hits[0]!
    expect(hit).toMatchObject({
      filePath: 'src/current.ts',
      language: 'typescript',
      parserTier: 'semantic',
    })
    expect(hit.contentHash).toMatch(/^[0-9a-f]{16}$/u)
    expect(hit.scoreTrace.reduce((sum, component) => sum + component.value, 0)).toBeCloseTo(hit.score, 12)

    const hydrated = await runtime.hydrateChunks({ chunkIds: [hit.chunkId, hit.chunkId] })
    expect(hydrated.rejected).toEqual([])
    expect(hydrated.chunks).toHaveLength(1)
    expect(hydrated.chunks[0]?.chunkId).toBe(hit.chunkId)
    expect(hydrated.chunks[0]?.contentHash).toBe(hit.contentHash)
    expect(hydrated.chunks[0]?.text).toContain('sourceVerifiedNeedle')
    expect(hydrated.chunks[0]?.verification).toBe('source-verified')

    await writeFile(join(root, 'src/current.ts'), 'export const sourceVerifiedNeedle = 2\n')
    const stale = await runtime.hydrateChunks({ chunkIds: [hit.chunkId] })
    expect(stale.chunks).toEqual([])
    expect(stale.rejected).toEqual([{
      chunkId: hit.chunkId,
      state: 'stale',
      reason: 'source-revision-changed',
    }])
    await runtime.dispose()
  })

  it('rejects hydration when an indexed parent directory is replaced by an escaping symlink', async () => {
    const contents = 'export const escapedParentNeedle = 1\n'
    const root = await makeWorkspace('rlh-rt-hydrate-link-', {
      files: { 'src/current.ts': contents },
    })
    const outside = await mkdtemp(join(tmpdir(), 'rlh-rt-hydrate-outside-'))
    trackedDirs.push(outside)
    await writeFile(join(outside, 'current.ts'), contents)
    const runtime = runtimeFor(root)
    const hit = (await runtime.search({ query: 'escapedParentNeedle' })).hits[0]!
    await rename(join(root, 'src'), join(root, 'src-original'))
    await symlink(outside, join(root, 'src'), 'dir')

    const hydrated = await runtime.hydrateChunks({ chunkIds: [hit.chunkId] })
    expect(hydrated.chunks).toEqual([])
    expect(hydrated.rejected).toEqual([{
      chunkId: hit.chunkId,
      state: 'unavailable',
      reason: 'source-path-invalid',
    }])
    await runtime.dispose()
  })

  it('applies explicit refresh paths without removing or rereading unrelated rows', async () => {
    const root = await makeWorkspace('rlh-rt-refresh-scope-', {
      files: {
        'src/a.ts': 'export const scopedAlpha = 1\n',
        'src/b.ts': 'export const scopedBeta = 1\n',
      },
    })
    const runtime = runtimeFor(root)
    await runtime.refresh()
    await writeFile(join(root, 'src/a.ts'), 'export const scopedAlpha = 2\n')
    await writeFile(join(root, 'src/b.ts'), 'export const scopedBeta = 2\n')
    const summary = await runtime.refresh({ reason: 'stale', paths: ['src/a.ts'] })
    expect(summary).toMatchObject({ changedFiles: 1, removedFiles: 0 })
    expect(summary.explain).toMatchObject({ scope: 'scoped', requestedPaths: 1, pass: 'ran' })
    expect((await runtime.search({ query: 'scopedAlpha 2' })).hits[0]?.filePath).toBe('src/a.ts')
    const oldBeta = (await runtime.search({ query: 'scopedBeta' })).hits.find(hit => hit.filePath === 'src/b.ts')!
    expect((await runtime.hydrateChunks({ chunkIds: [oldBeta.chunkId] })).rejected[0]).toMatchObject({ state: 'stale' })

    await rm(join(root, 'src/a.ts'))
    const removed = await runtime.refresh({ reason: 'stale', paths: ['src/a.ts'] })
    expect(removed.removedFiles).toBe(1)
    expect(runtime.status().indexedFileCount).toBe(1)
    await runtime.dispose()
  })

  it('surfaces the committed refresh summary through status with fresh epochs', async () => {
    const root = await makeWorkspace('rlh-rt-sum-', { files: { 'a.py': 'alpha = "一"\n' } })
    const runtime = runtimeFor(root)
    const summary = await runtime.refresh({ reason: 'manual' })
    expect(summary).toMatchObject({ reason: 'manual', changedFiles: 1, removedFiles: 0 })
    expect(summary.durationMs).toBeGreaterThanOrEqual(0)
    const status = runtime.status()
    expect(status.indexedFileCount).toBe(1)
    expect(status.lastRefresh?.changedFiles).toBe(1)
    expect(summary.explain).toMatchObject({ scope: 'full', pass: 'ran', degraded: false })
    const beforeNoop = runtime.status().epochs.indexEpoch
    const noop = await runtime.refresh({ reason: 'manual' })
    expect(noop.explain).toMatchObject({ scope: 'full', pass: 'skipped' })
    expect(runtime.status().epochs.indexEpoch).toBe(beforeNoop)
    await runtime.dispose()
  })

  it('folds concurrent refreshes into one commit so the epoch advances once', async () => {
    const root = await makeWorkspace('rlh-rt-fold-', {
      files: { 'one.ts': 'const one = 1\n', 'two.ts': 'const two = 2\n' },
    })
    const runtime = runtimeFor(root)
    const [first, second] = await Promise.all([
      runtime.refresh({ reason: 'manual' }),
      runtime.refresh({ reason: 'stale' }),
    ])
    // One folded pass reports one committed summary object shared by both callers.
    expect(first).toBe(second)
    expect(runtime.status().epochs.indexEpoch).toBe(1)
    await runtime.dispose()
  })

  it('runs one follow-up generation for scopes arriving after scanning began', async () => {
    const root = await makeWorkspace('rlh-rt-followup-', { files: { 'one.ts': 'const one = 1\n' } })
    const runtime = runtimeFor(root)
    await runtime.ensureOpen()
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const runPass = vi.fn(async (reason: 'manual' | 'stale' | 'lazy', options?: { paths?: readonly string[] }) => {
      ;(runtime as unknown as { inFlightPassStarted: boolean }).inFlightPassStarted = true
      if (runPass.mock.calls.length === 1) await firstGate
      return {
        summary: {
          reason,
          changedFiles: 0,
          removedFiles: 0,
          chunksWritten: 0,
          durationMs: 0,
          epochsAfter: { indexEpoch: 0, evidenceEpoch: 0, embeddingEpoch: 0 },
        },
        changedPaths: options?.paths ?? [],
      }
    })
    ;(runtime as unknown as { runPass: typeof runPass }).runPass = runPass
    const first = runtime.refresh({ reason: 'manual' })
    const folded = runtime.refresh({ reason: 'stale', paths: ['b.ts'] })
    runtime.refresh({ reason: 'stale', paths: ['a.ts'] }).catch(() => {})
    releaseFirst()
    expect(await folded).toBe(await first)
    await vi.waitFor(() =>{  expect(runPass).toHaveBeenCalledTimes(2) })
    expect(runPass.mock.calls[1]?.[1]).toEqual({ reason: 'stale', paths: ['a.ts', 'b.ts'] })
    await runtime.dispose()
  })

  it('forceRebuild deletes and recreates even a file-backed store without stale rows', async () => {
    const root = await makeWorkspace('rlh-rt-rb-', { files: { 'keep.ts': 'kept forever\n' } })
    const dbDir = await mkdtemp(join(tmpdir(), 'rlh-rt-db-'))
    trackedDirs.push(dbDir)
    const runtime = runtimeFor(root, { databasePath: join(dbDir, 'index.sqlite3') })
    await runtime.refresh()
    await runtime.search({ query: 'kept' })
    const summary = await runtime.refresh({ forceRebuild: true })
    expect(summary.changedFiles).toBe(1)
    expect(runtime.indexedFileCount()).toBe(1)
    expect(runtime.status().epochs.indexEpoch).toBeGreaterThanOrEqual(1)
    await runtime.dispose()
  })

  it('resizes the retrieval stack when commits move the repository across tiers', async () => {
    const root = await makeWorkspace('rlh-rt-tier-', { files: {} })
    const many: Array<{ relPath: string; contents: string }> = []
    for (let index = 0; index < 8; index++) {
      many.push({ relPath: `mod-${index}.ts`, contents: `export const value${index} = ${index}\n` })
    }
    for (const file of many) await writeFile(join(root, file.relPath), file.contents)
    const runtime = runtimeFor(root, {
      // Preserve real scan/parse/commit/rebind behavior without coupling this
      // lifecycle test to the production 500-file threshold or wall clock.
      tierForFileCount: fileCount => fileCount < 5 ? 'tiny' : 'small',
    })
    await runtime.refresh()
    expect(runtime.status().tier).toBe('small')
    // Deleting almost everything plus a forced rebuild walks the rebind again.
    for (const file of many.slice(2)) {
      await rm(join(root, file.relPath), { force: true })
    }
    await runtime.refresh({ forceRebuild: true })
    expect(runtime.status().tier).toBe('tiny')
    await runtime.dispose()
  })

  it('runs the five-stage pipeline so cross-file edges resolve and dirty propagation rebinding is auditable', async () => {
    const root = await makeWorkspace('rlh-rt-pipe-', {
      files: {
        'a.ts': 'export function foo(): number {\n  return 1\n}\n',
        'b.ts': "import { foo } from './a'\n\nexport function bar(): number {\n  return foo()\n}\n",
      },
    })
    const dbDir = await mkdtemp(join(tmpdir(), 'rlh-rt-pipedb-'))
    trackedDirs.push(dbDir)
    const databasePath = join(dbDir, 'index.sqlite3')
    const runtime = runtimeFor(root, { databasePath })
    await runtime.refresh()
    await runtime.refresh() // unchanged pass: generic-tier fast path

    await writeFile(join(root, 'a.ts'), 'export function foo(next: number): number {\n  return next\n}\n')
    const summary = await runtime.refresh({ reason: 'stale' })
    expect(summary.reason).toBe('stale')

    // Inspect the committed store through a second handle: b's call edge must
    // be bound to a's current foo symbol after the dirty re-resolution.
    const { openCodeIndexDatabase } = await import('@relay-harness/rlh-code-index-sqlite')
    const inspector = await openCodeIndexDatabase(databasePath)
    try {
      const edge = inspector.prepare(
        'SELECT callee_symbol_uid, target_symbol_id, resolution_strategy FROM call_edges '
        + "WHERE file_path = 'b.ts' AND callee_symbol = 'foo'",
      ).get() as { callee_symbol_uid: string | null; target_symbol_id: string | null; resolution_strategy: string }
      const foo = inspector.prepare(
        "SELECT symbol_id, symbol_uid FROM symbols WHERE file_path = 'a.ts' AND name = 'foo'",
      ).get() as { symbol_id: string; symbol_uid: string }
      expect(edge.callee_symbol_uid).toBe(foo.symbol_uid)
      expect(edge.target_symbol_id).toBe(foo.symbol_id)
      expect(edge.resolution_strategy).not.toBe('')
      const tiers = inspector.prepare('SELECT DISTINCT parser_tier FROM files').all() as Array<{ parser_tier: string }>
      expect(tiers).toEqual([{ parser_tier: 'semantic' }])
    } finally {
      inspector.close()
    }
    await runtime.dispose()
  })

  it('lazy-loads catalog entries from the store after a restart and empties them on removal', async () => {
    const root = await makeWorkspace('rlh-rt-lazy-', {
      files: {
        'a.ts': 'export function foo(): number {\n  return 1\n}\n',
        'b.ts': "import { foo } from './a'\nimport './c'\n\nexport function bar(): number {\n  return foo()\n}\n",
        'c.ts': 'export const helper = 1\n',
      },
    })
    const dbDir = await mkdtemp(join(tmpdir(), 'rlh-rt-lazydb-'))
    trackedDirs.push(dbDir)
    const databasePath = join(dbDir, 'index.sqlite3')
    const first = runtimeFor(root, { databasePath })
    await first.refresh()
    await first.dispose()

    // A restarted runtime starts with an empty catalog over a populated
    // store: the dirty re-resolution's import targets lazy-load from the
    // store — here the unchanged helper c.ts, since a.ts rides in fresh.
    const second = runtimeFor(root, { databasePath })
    await writeFile(join(root, 'a.ts'), 'export function foo(next: number): number {\n  return next\n}\n')
    await second.refresh({ reason: 'stale' })
    expect(second.status().indexedFileCount).toBe(3)

    // Removing the dependency promotes b again; its import target now has no
    // symbol rows to load, and the edge lands back at unresolved.
    await rm(join(root, 'a.ts'), { force: true })
    await second.refresh({ reason: 'stale' })
    await second.dispose()

    const { openCodeIndexDatabase } = await import('@relay-harness/rlh-code-index-sqlite')
    const inspector = await openCodeIndexDatabase(databasePath)
    try {
      const edge = inspector.prepare(
        'SELECT callee_symbol_uid, target_symbol_id FROM call_edges '
        + "WHERE file_path = 'b.ts' AND callee_symbol = 'foo'",
      ).get() as { callee_symbol_uid: string | null; target_symbol_id: string | null }
      expect(edge.callee_symbol_uid).toBeNull()
      expect(edge.target_symbol_id).toBeNull()
    } finally {
      inspector.close()
    }
  })

  it('revives the persisted last_refresh summary for a restarted runtime', async () => {
    const root = await makeWorkspace('rlh-rt-persist-', { files: { 'kept.md': 'durable\n' } })
    const dbDir = await mkdtemp(join(tmpdir(), 'rlh-rt-persistdb-'))
    trackedDirs.push(dbDir)
    const databasePath = join(dbDir, 'index.sqlite3')
    const first = runtimeFor(root, { databasePath })
    await first.refresh({ reason: 'manual' })
    await first.dispose()

    const second = runtimeFor(root, { databasePath })
    await second.ensureOpen()
    // No new pass has run yet; the revived ledger row answers status.
    const statusBefore = second.status()
    expect(statusBefore.lastRefresh?.reason).toBe('manual')
    expect(statusBefore.lastRefresh?.changedFiles).toBe(1)
    expect(statusBefore.indexedFileCount).toBe(1)
    await second.dispose()
  })

  it('tracks answer-level degradation and surfaces it through status', async () => {
    const root = await makeWorkspace('rlh-rt-degraded-', { files: { 'lane.ts': 'lanes recover loudly\n' } })
    const dbDir = await mkdtemp(join(tmpdir(), 'rlh-rt-degradedb-'))
    trackedDirs.push(dbDir)
    const databasePath = join(dbDir, 'index.sqlite3')
    const runtime = runtimeFor(root, { databasePath })
    await runtime.refresh()

    // Sabotage one mirrored store behind the live handle: lanes convert the
    // reader rejection into readErrors instead of throwing past the seam.
    const { DatabaseSync } = await import('node:sqlite')
    const saboteur = new DatabaseSync(databasePath)
    saboteur.exec('DROP TABLE chunks_fts')
    saboteur.close()

    const answer = await runtime.search({ query: 'lanes' })
    expect(answer.degraded).toBe(true)
    expect(answer.readErrors.length).toBeGreaterThan(0)
    expect(runtime.status().degraded).toBe(true)
    await runtime.dispose()
  })

  it('applies graph context through the enriched search path', async () => {
    const root = await makeWorkspace('rlh-rt-graph-', {
      files: {
        'a.ts': 'export function quantaBeamAlign(): number {\n  return 1\n}\n',
        'b.ts': "import { quantaBeamAlign } from './a'\n\nexport function callerSide(): number {\n  return quantaBeamAlign()\n}\n",
      },
    })
    const dbDir = await mkdtemp(join(tmpdir(), 'rlh-rt-graphdb-'))
    trackedDirs.push(dbDir)
    const runtime = runtimeFor(root, { databasePath: join(dbDir, 'index.sqlite3') })
    await runtime.refresh()
    const answer = await runtime.search({ query: 'quantaBeamAlign' })
    // The defining chunk resolves to its symbol, whose in-degree the caller
    // edge feeds: the enrichment assigns a connectivity score and bills the
    // boost reason on top of the base rerank.
    const defining = answer.hits.find(hit => hit.filePath === 'a.ts')
    expect(defining).toBeDefined()
    expect(defining?.graphScore).toBeGreaterThan(0)
    expect(defining?.reasons).toContain('boost:graph-rerank')
    // The caller chunk rides in through the graph lane (fusion-only).
    expect(answer.hits.some(hit => hit.filePath === 'b.ts')).toBe(true)
    expect(answer.degraded).toBe(false)
    await runtime.dispose()
  })

  it('marks degradation from watcher failure and recovers when cleared', async () => {
    const root = await makeWorkspace('rlh-rt-deg-', { files: { 'x.md': 'hello\n' } })
    const runtime = runtimeFor(root)
    await runtime.refresh()
    expect(runtime.status().degraded).toBe(false)
    runtime.setWatcherDegraded(true)
    expect(runtime.status().degraded).toBe(true)
    runtime.setWatcherDegraded(false)
    expect(runtime.status().degraded).toBe(false)
    await runtime.dispose()
  })

  it('refuses work after disposal on every public entry point', async () => {
    const root = await makeWorkspace('rlh-rt-disp-', { files: { 'y.ts': 'let y = 1\n' } })
    const runtime = runtimeFor(root)
    await runtime.refresh()
    await runtime.dispose()
    await runtime.dispose()
    expect(() => runtime.status()).toThrow('disposed')
    expect(() => runtime.indexedFileCount()).toThrow('disposed')
    await expect(runtime.search({ query: 'y' })).rejects.toThrow('disposed')
    await expect(runtime.hydrateChunks({ chunkIds: ['chunk:y'] })).rejects.toThrow('disposed')
    await expect(runtime.ensureOpen()).rejects.toThrow('disposed')

    const unopened = runtimeFor(root)
    expect(() => unopened.status()).toThrow('no open store')
    await unopened.dispose()
  })
})
