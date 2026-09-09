import SessionStore, { type ToolResultMessage } from '@relay-harness/rlh-session'
import type { FSWatcher } from 'node:fs'
import { mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@relay-harness/cordis'
import CodeIndexWorkspaceRouter, { canonicalWorkspaceRoot, type Config } from '../src/index.ts'
import LocalCodeIndex, { LocalCodeIndexRuntime, StaleInvalidator, TreeWatcher } from '@relay-harness/rlh-code-index-local'

const roots: string[] = []
async function fixture(): Promise<{ root: string; a: string; b: string; db: string }> {
  const root = await mkdtemp(join(tmpdir(), 'rlh-code-index-router-'))
  roots.push(root)
  const a = join(root, 'workspace-a')
  const b = join(root, 'workspace-b')
  const db = join(root, 'indexes')
  await Promise.all([mkdir(a), mkdir(b), mkdir(db)])
  await Promise.all([
    writeFile(join(a, 'alpha.ts'), 'export function alphaQuantaOnly() { return 11 }\n'),
    writeFile(join(b, 'beta.ts'), 'export function betaNebulaOnly() { return 22 }\n'),
  ])
  return { root, a, b, db }
}
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function setup(db: string, maxOpenWorkspaces = 4, idleEvictMs = 60_000): Promise<{ ctx: Context; router: CodeIndexWorkspaceRouter }> {
  const ctx = new Context()
  await ctx.plugin(CodeIndexWorkspaceRouter, {
    databaseDirectory: db,
    maxOpenWorkspaces,
    idleEvictMs,
    watcherEnabled: false,
  })
  return { ctx, router: ctx.codeIndex as CodeIndexWorkspaceRouter }
}

describe('workspace isolation and lifecycle', () => {
  it('indexes two real workspaces concurrently without cross-workspace search or hydration', async () => {
    const { a, b, db } = await fixture()
    const { ctx, router } = await setup(db)
    try {
      const [aIndex, bIndex] = await Promise.all([router.forWorkspace(a), router.forWorkspace(b)])
      const [alpha, beta] = await Promise.all([
        aIndex.search({ query: 'alphaQuantaOnly' }),
        bIndex.search({ query: 'betaNebulaOnly' }),
      ])
      expect(alpha.hits.map(hit => hit.filePath)).toEqual(['alpha.ts'])
      expect(beta.hits.map(hit => hit.filePath)).toEqual(['beta.ts'])
      expect((await aIndex.search({ query: 'betaNebulaOnly' })).hits).toEqual([])
      expect((await bIndex.search({ query: 'alphaQuantaOnly' })).hits).toEqual([])
      const chunkId = alpha.hits[0]?.chunkId as string
      expect((await aIndex.hydrateChunks({ chunkIds: [chunkId] })).chunks[0]?.text).toContain('alphaQuantaOnly')
      expect(await bIndex.hydrateChunks({ chunkIds: [chunkId] })).toMatchObject({
        chunks: [],
        rejected: [{ chunkId, state: 'unavailable', reason: 'not-indexed' }],
      })
      expect(router.databasePathFor(a)).not.toBe(router.databasePathFor(b))
      expect(router.openWorkspaceRoots()).toEqual([aIndex.workspaceRoot, bIndex.workspaceRoot].sort())
    } finally { await ctx.fiber.dispose() }
  })

  it('collapses a symlink alias to one canonical identity and one derived store', async () => {
    const { root, a, db } = await fixture()
    const alias = join(root, 'alias-a')
    await symlink(a, alias, 'dir')
    const { ctx, router } = await setup(db)
    try {
      const [direct, throughAlias] = await Promise.all([router.forWorkspace(a), router.forWorkspace(alias)])
      expect(throughAlias.workspaceRoot).toBe(direct.workspaceRoot)
      await Promise.all([direct.status(), throughAlias.status()])
      expect(router.openWorkspaceRoots()).toEqual([direct.workspaceRoot])
      expect(router.databasePathFor(direct.workspaceRoot)).toBe(router.databasePathFor(throughAlias.workspaceRoot))
    } finally { await ctx.fiber.dispose() }
  })

  it('evicts the least-recent quiescent runtime and reopens its durable generation', async () => {
    const { a, b, db } = await fixture()
    const { ctx, router } = await setup(db, 1)
    try {
      const aIndex = await router.forWorkspace(a)
      const first = await aIndex.search({ query: 'alphaQuantaOnly' })
      expect(first.hits).toHaveLength(1)
      const epoch = first.epochs.indexEpoch
      await (await router.forWorkspace(b)).search({ query: 'betaNebulaOnly' })
      await router.evictIdleNow()
      expect(router.openWorkspaceRoots()).toEqual([])
      const reopened = await (await router.forWorkspace(a)).search({ query: 'alphaQuantaOnly' })
      expect(reopened.hits).toHaveLength(1)
      expect(reopened.epochs.indexEpoch).toBe(epoch)
    } finally { await ctx.fiber.dispose() }
  })

  it('waits for an active lease before close and evicts an actually idle runtime on its timer', async () => {
    const { a, db } = await fixture()
    const { ctx, router } = await setup(db, 4, 20)
    try {
      const handle = await router.forWorkspace(a)
      await handle.status()
      const internal = router as unknown as {
        entries: Map<string, { runtime: { search: typeof handle.search } }>
      }
      const entry = [...internal.entries.values()][0]!
      const original = entry.runtime.search.bind(entry.runtime)
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      entry.runtime.search = async (request, signal) => { await gate; return original(request, signal) }
      const active = handle.search({ query: 'alphaQuantaOnly' })
      await Promise.resolve()
      await router.evictIdleNow()
      expect(router.openWorkspaceRoots()).toEqual([handle.workspaceRoot])
      release(); await active
      for (let attempt = 0; router.openWorkspaceRoots().length > 0 && attempt < 50; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      expect(router.openWorkspaceRoots()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })

  it('rejects every unscoped process-wide operation instead of selecting a prior workspace', async () => {
    const { a, db } = await fixture()
    const { ctx, router } = await setup(db)
    try {
      const bound = await router.forWorkspace(a)
      expect((await bound.search({ query: 'alphaQuantaOnly' })).hits).toHaveLength(1)
      await expect(router.status()).rejects.toThrow('bind an explicit Session workspace')
      await expect(router.managementStatus()).rejects.toThrow('bind an explicit Session workspace')
      await expect(router.reconcile()).rejects.toThrow('bind an explicit Session workspace')
      await expect(router.refresh()).rejects.toThrow('bind an explicit Session workspace')
      await expect(router.hydrateChunks({ chunkIds: [] })).rejects.toThrow('bind an explicit Session workspace')
      await expect(router.exploreGraph({ op: 'relations', symbol: 'alphaQuantaOnly' })).rejects.toThrow('bind an explicit Session workspace')
      await expect(router.search({ query: 'anything' })).rejects.toThrow('bind an explicit Session workspace')
    } finally { await ctx.fiber.dispose() }
  })
})

it('does not dispatch a new query to a runtime selected for concurrent eviction', async () => {
  const { a, db } = await fixture()
  const { ctx, router } = await setup(db)
  try {
    const handle = await router.forWorkspace(a)
    await handle.search({ query: 'alphaQuantaOnly' })
    const internal = router as unknown as { entries: Map<string, { closing: boolean; runtime: { search: typeof handle.search } }> }
    const old = [...internal.entries.values()][0]!
    await (Reflect.get(router, 'evictionChain') as Promise<void>)
    let calledWhileClosing = false
    const original = old.runtime.search.bind(old.runtime)
    vi.spyOn(old.runtime, 'search').mockImplementation((request, signal) => {
      calledWhileClosing ||= old.closing
      return original(request, signal)
    })
    const eviction = router.evictIdleNow()
    const search = handle.search({ query: 'alphaQuantaOnly' })
    const [evicted, result] = await Promise.allSettled([eviction, search])
    expect(evicted.status).toBe('fulfilled')
    expect(result.status).toBe('fulfilled')
    expect(calledWhileClosing).toBe(false)
    if (result.status === 'fulfilled') expect(result.value.hits.map(hit => hit.filePath)).toEqual(['alpha.ts'])
  } finally { await ctx.fiber.dispose() }
})

it('closes every workspace when one runtime disposer fails', async () => {
  const { a, b, db } = await fixture()
  const { ctx, router } = await setup(db)
  const aIndex = await router.forWorkspace(a)
  const bIndex = await router.forWorkspace(b)
  await aIndex.status()
  await bIndex.status()
  const internal = router as unknown as { entries: Map<string, { runtime: { dispose: () => Promise<void> } }> }
  const entries = [...internal.entries.values()]
  const first = entries[0]!.runtime
  const second = entries[1]!.runtime
  const disposeFirst = first.dispose.bind(first)
  const failed = vi.spyOn(first, 'dispose').mockImplementation(async () => {
    await disposeFirst()
    throw new Error('fixture first dispose failure')
  })
  const closedSecond = vi.spyOn(second, 'dispose')
  const shutdown = vi.spyOn(router as unknown as { disposeRouter: () => Promise<void> }, 'disposeRouter')
  try {
    await ctx.fiber.dispose()
    expect(shutdown).toHaveBeenCalledTimes(1)
    await expect(shutdown.mock.results[0]!.value).rejects.toMatchObject({
      message: 'code-index-workspace-router shutdown failed',
      errors: [expect.objectContaining({ message: 'fixture first dispose failure' })],
    })
    expect(closedSecond).toHaveBeenCalledTimes(1)
    expect(router.openWorkspaceRoots()).toEqual([])
    await expect(bIndex.status()).rejects.toThrow('disposed')
  } finally {
    failed.mockRestore()
    closedSecond.mockRestore()
    shutdown.mockRestore()
    await Promise.all(entries.map(entry => entry.runtime.dispose()))
    await ctx.fiber.dispose().catch(() => undefined)
  }
})

it('waits for an admitted query while rejecting new work during shutdown', async () => {
  const { a, db } = await fixture()
  const { ctx, router } = await setup(db)
  const handle = await router.forWorkspace(a)
  await handle.status()
  const internal = router as unknown as { entries: Map<string, { runtime: LocalCodeIndexRuntime }> }
  const runtime = [...internal.entries.values()][0]!.runtime
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const original = runtime.search.bind(runtime)
  const searchSpy = vi.spyOn(runtime, 'search').mockImplementation(async (request, signal) => {
    entered.resolve(undefined)
    await release.promise
    return original(request, signal)
  })
  const disposeSpy = vi.spyOn(runtime, 'dispose')
  const query = handle.search({ query: 'alphaQuantaOnly' })
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    closing = ctx.fiber.dispose()
    await vi.waitFor(() => { expect(Reflect.get(router, 'disposed')).toBe(true) })
    await expect(handle.status()).rejects.toThrow('disposed')
    expect(disposeSpy).not.toHaveBeenCalled()
    release.resolve(undefined)
    expect((await query).hits.map(hit => hit.filePath)).toEqual(['alpha.ts'])
    await closing
    expect(disposeSpy).toHaveBeenCalledTimes(1)
    expect(router.openWorkspaceRoots()).toEqual([])
  } finally {
    release.resolve(undefined)
    await query
    await (closing ?? ctx.fiber.dispose())
    searchSpy.mockRestore()
    disposeSpy.mockRestore()
  }
})

it('retires an opening runtime rather than publishing it after shutdown starts', async () => {
  const { a, db } = await fixture()
  const { ctx, router } = await setup(db)
  const handle = await router.forWorkspace(a)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  // oxlint-disable-next-line typescript/unbound-method -- invoked with the runtime receiver below
  const original = LocalCodeIndexRuntime.prototype.ensureOpen
  const opening = vi.spyOn(LocalCodeIndexRuntime.prototype, 'ensureOpen').mockImplementation(async function (this: LocalCodeIndexRuntime) {
    await original.call(this)
    entered.resolve(undefined)
    await release.promise
  })
  const disposed = vi.spyOn(LocalCodeIndexRuntime.prototype, 'dispose')
  const request = handle.status().then(value => ({ value }), (error: unknown) => ({ error }))
  let closing: Promise<void> | undefined
  try {
    await entered.promise
    closing = ctx.fiber.dispose()
    await vi.waitFor(() => { expect(Reflect.get(router, 'disposed')).toBe(true) })
    release.resolve(undefined)
    expect(await request).toMatchObject({ error: { message: 'code-index-workspace-router is disposed' } })
    await closing
    expect(router.openWorkspaceRoots()).toEqual([])
    expect(disposed).toHaveBeenCalledTimes(1)
  } finally {
    release.resolve(undefined)
    await request
    await (closing ?? ctx.fiber.dispose())
    opening.mockRestore()
    disposed.mockRestore()
  }
})

it.each(['explicit', 'timer'] as const)('observes %s eviction failure and keeps later collection usable', async (trigger) => {
  const { a, db } = await fixture()
  const { ctx, router } = await setup(db, 4, trigger === 'timer' ? 30 : 60_000)
  const handle = await router.forWorkspace(a)
  await handle.status()
  await (Reflect.get(router, 'evictionChain') as Promise<void>)
  const internal = router as unknown as { entries: Map<string, { runtime: LocalCodeIndexRuntime }> }
  const runtime = [...internal.entries.values()][0]!.runtime
  const original = runtime.dispose.bind(runtime)
  const failure = new Error('fixture private close details')
  const dispose = vi.spyOn(runtime, 'dispose').mockImplementationOnce(async () => { await original(); throw failure })
  const owner = Reflect.get(router, 'ctx') as Context
  const warning = vi.spyOn(owner.logger, 'warn')
  try {
    if (trigger === 'explicit') await expect(router.evictIdleNow()).rejects.toBe(failure)
    else await vi.waitFor(() => { expect(warning).toHaveBeenCalled() })
    expect(warning).toHaveBeenCalledWith('code-index-workspace-router: eviction failed')
    expect(warning.mock.calls.flat().some(value => String(value).includes('private close details'))).toBe(false)
    expect(router.openWorkspaceRoots()).toEqual([])
    expect((await handle.search({ query: 'alphaQuantaOnly' })).hits).toHaveLength(1)
    await expect(router.evictIdleNow()).resolves.toBeUndefined()
    expect(router.openWorkspaceRoots()).toEqual([])
  } finally {
    dispose.mockRestore()
    warning.mockRestore()
    await ctx.fiber.dispose()
  }
})

describe('router input validation', () => {
  it.each(['maxOpenWorkspaces', 'idleEvictMs', 'maxFileBytes', 'debounceMs', 'dirtyPropagationMaxFiles'] as const)(
    'rejects non-positive or non-integer %s at construction', async (key) => {
      for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
        const ctx = new Context()
        try {
          expect(() => new CodeIndexWorkspaceRouter(ctx, { [key]: value })).toThrow(`${key} must be a positive safe integer`)
        } finally { await ctx.fiber.dispose() }
      }
    },
  )

  it.each<Config>([{ databaseDirectory: '  ' }, { exclude: ['src', ' '] }])('rejects blank config paths: %j', async (config) => {
    const ctx = new Context()
    try {
      expect(() => new CodeIndexWorkspaceRouter(ctx, config)).toThrow(/must not be blank|must be non-empty/)
    } finally { await ctx.fiber.dispose() }
  })

  it('refuses blank, missing, and regular-file workspace roots without creating indexes', async () => {
    const { a, db } = await fixture()
    const { ctx, router } = await setup(db)
    try {
      await expect(canonicalWorkspaceRoot('  ')).rejects.toThrow('must not be blank')
      await expect(router.forWorkspace(join(a, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(router.forWorkspace(join(a, 'alpha.ts'))).rejects.toThrow('not a directory')
      expect(router.openWorkspaceRoots()).toEqual([])
    } finally { await ctx.fiber.dispose() }
  })
})

it('routes refresh, management and graph operations to the bound workspace only', async () => {
  const { a, b, db } = await fixture()
  await writeFile(join(a, 'caller.ts'), "import { alphaQuantaOnly } from './alpha'\nexport function callAlpha() { return alphaQuantaOnly() }\n")
  const { ctx, router } = await setup(db)
  try {
    const aIndex = await router.forWorkspace(a)
    const bIndex = await router.forWorkspace(b)
    const rebuilt = await aIndex.refresh({ reason: 'manual' })
    expect(rebuilt.reason).toBe('manual')
    expect(rebuilt.changedFiles).toBe(2)
    const management = await aIndex.managementStatus()
    expect(management.chunkCount).toBeGreaterThan(0)
    expect(await aIndex.reconcile()).toMatchObject({ chunkCount: management.chunkCount })
    const graph = await aIndex.exploreGraph({ op: 'relations', symbol: 'alphaQuantaOnly', direction: 'callers' })
    expect(graph.op).toBe('relations')
    expect(graph.nodes.map(node => node.name)).toContain('callAlpha')
    expect(graph.nodes.map(node => node.filePath)).toContain('alpha.ts')
    await bIndex.refresh()
    const unrelated = await bIndex.exploreGraph({ op: 'relations', symbol: 'alphaQuantaOnly' })
    expect(unrelated.nodes).toEqual([])
    expect((await bIndex.search({ query: 'callAlpha' })).hits).toEqual([])
  } finally { await ctx.fiber.dispose() }
})

it.each(['search', 'hydrate', 'graph'] as const)('forwards %s cancellation and releases the operation lease', async (operation) => {
  const { a, db } = await fixture()
  const { ctx, router } = await setup(db)
  try {
    const handle = await router.forWorkspace(a)
    const initial = await handle.search({ query: 'alphaQuantaOnly' })
    const cancel = new AbortController()
    const reason = new Error('fixture cancelled request')
    cancel.abort(reason)
    const request = operation === 'search'
      ? handle.search({ query: 'alphaQuantaOnly' }, cancel.signal)
      : operation === 'hydrate'
        ? handle.hydrateChunks({ chunkIds: [initial.hits[0]!.chunkId] }, cancel.signal)
        : handle.exploreGraph({ op: 'relations', symbol: 'alphaQuantaOnly' }, cancel.signal)
    await expect(request).rejects.toBe(reason)
    await router.evictIdleNow()
    expect(router.openWorkspaceRoots()).toEqual([])
    expect((await handle.search({ query: 'alphaQuantaOnly' })).hits).toHaveLength(1)
  } finally { await ctx.fiber.dispose() }
})

it.each(['router', 'single'] as const)('reports a late native watch failure through the %s provider', async (provider) => {
  const { a, db } = await fixture()
  const ctx = new Context()
  try {
    if (provider === 'router') await ctx.plugin(CodeIndexWorkspaceRouter, { databaseDirectory: db, watcherEnabled: true })
    else await ctx.plugin(LocalCodeIndex, { workspaceRoot: a, databasePath: join(db, 'single.sqlite'), watcherEnabled: true })
    const handle = await ctx.codeIndex.forWorkspace(a)
    await handle.refresh()
    expect((await handle.status()).degraded).toBe(false)
    const service = ctx.codeIndex as unknown as { watcher: TreeWatcher; entries: Map<string, { watcher: TreeWatcher }> }
    const watcher = provider === 'router' ? [...service.entries.values()][0]!.watcher : service.watcher
    const native = Reflect.get(watcher, 'watcher') as FSWatcher
    expect(() => native.emit('error', new Error('fixture native watcher failure'))).not.toThrow()
    expect(watcher.state).toBe('degraded')
    expect((await handle.status()).degraded).toBe(true)
    await writeFile(join(a, 'alpha.ts'), 'export function refreshedAfterWatcherFailure() { return 42 }\n')
    await handle.refresh({ reason: 'manual' })
    expect((await handle.search({ query: 'refreshedAfterWatcherFailure' })).hits).toHaveLength(1)
  } finally { await ctx.fiber.dispose() }
})

it.each([new Error('fixture refresh unavailable'), 'fixture refresh unavailable'])('isolates watcher changes and recovers refresh failure %j', async (failure) => {
  const { a, b, db } = await fixture()
  const ctx = new Context()
  await ctx.plugin(CodeIndexWorkspaceRouter, { databaseDirectory: db, watcherEnabled: true, debounceMs: 5 })
  const router = ctx.codeIndex as CodeIndexWorkspaceRouter
  const aIndex = await router.forWorkspace(a)
  const bIndex = await router.forWorkspace(b)
  await aIndex.refresh()
  await bIndex.refresh()
  const internal = router as unknown as { entries: Map<string, { runtime: LocalCodeIndexRuntime }> }
  const aRuntime = internal.entries.get(aIndex.workspaceRoot)!.runtime
  const bRuntime = internal.entries.get(bIndex.workspaceRoot)!.runtime
  const untouched = vi.spyOn(bRuntime, 'refresh')
  const refresh = vi.spyOn(aRuntime, 'refresh')
  const owner = Reflect.get(router, 'ctx') as Context
  const warning = vi.spyOn(owner.logger, 'warn')
  try {
    await writeFile(join(a, 'gamma.ts'), 'export function gammaScopedWatcher() { return 33 }\n')
    await vi.waitFor(async () => { expect((await aIndex.status()).indexedFileCount).toBe(2) }, { timeout: 5000 })
    expect((await bIndex.status()).indexedFileCount).toBe(1)
    expect(untouched).not.toHaveBeenCalled()
    await writeFile(join(a, '.gitignore'), 'gamma.ts\n')
    await vi.waitFor(async () => { expect((await aIndex.status()).indexedFileCount).toBe(1) }, { timeout: 5000 })
    expect(refresh).toHaveBeenCalledWith({ reason: 'stale' })
    expect((await aIndex.search({ query: 'gammaScopedWatcher' })).hits).toEqual([])
    refresh.mockRejectedValueOnce(failure)
    await writeFile(join(a, 'alpha.ts'), 'export function recoveredWatcherRefresh() { return 44 }\n')
    await vi.waitFor(() => { expect(warning).toHaveBeenCalledWith(
      'code-index-workspace-router: background refresh failed',
      { workspaceRoot: aIndex.workspaceRoot, reason: 'fixture refresh unavailable' },
    ) }, { timeout: 5000 })
    await aIndex.refresh()
    expect((await aIndex.search({ query: 'recoveredWatcherRefresh' })).hits).toHaveLength(1)
    expect(untouched).not.toHaveBeenCalled()
  } finally {
    await ctx.fiber.dispose()
    untouched.mockRestore()
    refresh.mockRestore()
    warning.mockRestore()
  }
}, 20_000)

it('routes appended Session tool results only to their already-open workspace', async () => {
  const { root, a, b, db } = await fixture()
  const { ctx, router } = await setup(db)
  await ctx.plugin(SessionStore)
  const aIndex = await router.forWorkspace(a)
  const bIndex = await router.forWorkspace(b)
  await aIndex.refresh()
  await bIndex.refresh()
  const internal = router as unknown as { entries: Map<string, { runtime: LocalCodeIndexRuntime }> }
  const refreshA = vi.spyOn(internal.entries.get(aIndex.workspaceRoot)!.runtime, 'refresh')
  const refreshB = vi.spyOn(internal.entries.get(bIndex.workspaceRoot)!.runtime, 'refresh')
  const unopened = join(root, 'unopened')
  await mkdir(unopened)
  const sessions = [
    ctx.sessions.create(undefined, { meta: { cwd: a } }),
    ctx.sessions.create(undefined, { meta: { cwd: unopened } }),
    ctx.sessions.create(undefined, { meta: { cwd: join(root, 'missing') } }),
    ctx.sessions.create(),
  ]
  const callId = 'fixture-call' as ToolResultMessage['source']['callId']
  const message: ToolResultMessage = {
    id: 'fixture-message' as ToolResultMessage['id'], role: 'user', source: { kind: 'tool', callId },
    content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: 'fixture result' }] }],
  }
  try {
    await writeFile(join(a, 'alpha.ts'), 'export function toolResultRefreshedMarker() { return 55 }\n')
    ctx.sessions.create(undefined, { meta: { cwd: b } }).append('turn/start', { turn: 1 })
    for (const session of sessions) {
      session.append('turn/start', { turn: 1 })
      session.append('tool/result', { turn: 1, step: 1, message }, { surfaceOp: 'append' })
    }
    await vi.waitFor(() => { expect(refreshA).toHaveBeenCalledWith({ reason: 'stale' }) }, { timeout: 3000 })
    await vi.waitFor(async () => {
      expect((await aIndex.search({ query: 'toolResultRefreshedMarker' })).hits).toHaveLength(1)
    }, { timeout: 3000 })
    expect(refreshB).not.toHaveBeenCalled()
    expect(router.openWorkspaceRoots()).toEqual([aIndex.workspaceRoot, bIndex.workspaceRoot].sort())
  } finally {
    await ctx.fiber.dispose()
    refreshA.mockRestore()
    refreshB.mockRestore()
  }
})

it('shares a failed opening and retries after the database directory is repaired', async () => {
  const { a, db } = await fixture()
  const blocked = join(db, 'not-a-directory')
  await writeFile(blocked, 'fixture obstruction')
  const { ctx, router } = await setup(blocked)
  try {
    const handle = await router.forWorkspace(a)
    const results = await Promise.allSettled([handle.status(), handle.status()])
    expect(results.map(result => result.status)).toEqual(['rejected', 'rejected'])
    if (results[0].status === 'rejected' && results[1].status === 'rejected') {
      expect(results[0].reason).toBe(results[1].reason)
    }
    expect(router.openWorkspaceRoots()).toEqual([])
    await rm(blocked)
    await mkdir(blocked)
    expect((await handle.search({ query: 'alphaQuantaOnly' })).hits).toHaveLength(1)
    expect(router.openWorkspaceRoots()).toEqual([handle.workspaceRoot])
  } finally { await ctx.fiber.dispose() }
})

it('rejects a cached acquisition resumed after shutdown without calling the retired runtime', async () => {
  const { a, db } = await fixture()
  const { ctx, router } = await setup(db)
  const handle = await router.forWorkspace(a)
  await handle.status()
  const internal = router as unknown as {
    entries: Map<string, { runtime: LocalCodeIndexRuntime }>
    acquire: (root: string) => Promise<unknown>
  }
  const runtime = [...internal.entries.values()][0]!.runtime
  const status = vi.spyOn(runtime, 'status')
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const original = internal.acquire.bind(router)
  const acquisition = vi.spyOn(internal, 'acquire').mockImplementation(async (root) => {
    const entry = await original(root)
    entered.resolve(undefined)
    await release.promise
    return entry
  })
  const request = handle.status().then(value => ({ value }), (error: unknown) => ({ error }))
  try {
    await entered.promise
    await ctx.fiber.dispose()
    release.resolve(undefined)
    expect(await request).toMatchObject({ error: { message: 'code-index-workspace-router is disposed' } })
    expect(status).not.toHaveBeenCalled()
    expect(router.openWorkspaceRoots()).toEqual([])
  } finally {
    release.resolve(undefined)
    await request
    acquisition.mockRestore()
    status.mockRestore()
    await ctx.fiber.dispose()
  }
})

it('uses isolated default-home database paths without an explicit database directory', async () => {
  const { root, a, b } = await fixture()
  const home = join(root, 'temporary-home')
  const ctx = new Context()
  vi.stubEnv('RLH_HOME', home)
  try {
    await ctx.plugin(CodeIndexWorkspaceRouter, {})
    const router = ctx.codeIndex as CodeIndexWorkspaceRouter
    const aIndex = await router.forWorkspace(a)
    const bIndex = await router.forWorkspace(b)
    const aPath = router.databasePathFor(aIndex.workspaceRoot)
    const bPath = router.databasePathFor(bIndex.workspaceRoot)
    expect(aPath.startsWith(`${home}/index/`)).toBe(true)
    expect(bPath.startsWith(`${home}/index/`)).toBe(true)
    expect(aPath).not.toBe(bPath)
    expect((await aIndex.search({ query: 'alphaQuantaOnly' })).hits).toHaveLength(1)
    expect((await bIndex.search({ query: 'alphaQuantaOnly' })).hits).toEqual([])
    expect((await bIndex.search({ query: 'betaNebulaOnly' })).hits).toHaveLength(1)
    expect((await stat(aPath)).isFile()).toBe(true)
    expect((await stat(bPath)).isFile()).toBe(true)
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllEnvs()
  }
})

it('forwards embedding generation configuration into isolated empty stores without network calls', async () => {
  const { a, b, db } = await fixture()
  await Promise.all([rm(join(a, 'alpha.ts')), rm(join(b, 'beta.ts'))])
  const ctx = new Context()
  const fetch = vi.fn(async () => { throw new Error('Embedding fixture must not make network requests') })
  vi.stubGlobal('fetch', fetch)
  try {
    await ctx.plugin(CodeIndexWorkspaceRouter, {
      databaseDirectory: db,
      embedding: {
        apiKeyEnv: 'RLH_UNUSED_ROUTER_FIXTURE_KEY',
        baseURL: 'http://127.0.0.1:1/v1', model: 'fixture-embedding', dimensions: 3,
      },
    })
    const router = ctx.codeIndex as CodeIndexWorkspaceRouter
    const aIndex = await router.forWorkspace(a)
    const bIndex = await router.forWorkspace(b)
    const [aStatus, bStatus] = await Promise.all([aIndex.reconcile(), bIndex.reconcile()])
    for (const status of [aStatus, bStatus]) {
      expect(status.chunkCount).toBe(0)
      expect(status.generations).toHaveLength(1)
      expect(status.generations[0]).toMatchObject({
        model: 'fixture-embedding', configuredDimensions: 3,
        vectorizedChunks: 0, pendingJobs: 0, runningJobs: 0, failedJobs: 0,
      })
    }
    expect(router.databasePathFor(aIndex.workspaceRoot)).not.toBe(router.databasePathFor(bIndex.workspaceRoot))
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
  }
  expect(fetch).not.toHaveBeenCalled()
})

it.each(['delete', undefined] as const)('applies constructor defaults with journal mode %s', async (journalMode) => {
  const { a, db } = await fixture()
  const ctx = new Context()
  try {
    const router = new CodeIndexWorkspaceRouter(ctx, { databaseDirectory: db, ...(journalMode === undefined ? {} : { journalMode }) })
    const handle = await router.forWorkspace(a)
    expect((await handle.search({ query: 'alphaQuantaOnly' })).hits).toHaveLength(1)
    await router.evictIdleNow()
    expect(router.openWorkspaceRoots()).toEqual([])
  } finally { await ctx.fiber.dispose() }
})

it.each(['evict', 'shutdown'] as const)('ignores a retained invalidator flush after %s', async (ending) => {
  const { a, db } = await fixture()
  const { ctx, router } = await setup(db)
  const handle = await router.forWorkspace(a)
  await handle.status()
  const internal = router as unknown as { entries: Map<string, { runtime: LocalCodeIndexRuntime; invalidator: StaleInvalidator }> }
  const entry = [...internal.entries.values()][0]!
  const refresh = vi.spyOn(entry.runtime, 'refresh')
  try {
    if (ending === 'evict') await router.evictIdleNow()
    else await ctx.fiber.dispose()
    entry.invalidator.flushNow()
    await Promise.resolve()
    expect(refresh).not.toHaveBeenCalled()
    expect(router.openWorkspaceRoots()).toEqual([])
  } finally {
    refresh.mockRestore()
    await ctx.fiber.dispose()
  }
})

it('does not double-close a workspace when shutdown overtakes a multi-entry eviction', async () => {
  const { a, b, db } = await fixture()
  const { ctx, router } = await setup(db)
  await (await router.forWorkspace(a)).status()
  await (await router.forWorkspace(b)).status()
  await (Reflect.get(router, 'evictionChain') as Promise<void>)
  const internal = router as unknown as { entries: Map<string, { runtime: LocalCodeIndexRuntime }> }
  const runtimes = [...internal.entries.values()].map(entry => entry.runtime)
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const original = runtimes[0]!.dispose.bind(runtimes[0])
  const first = vi.spyOn(runtimes[0]!, 'dispose').mockImplementationOnce(async () => {
    entered.resolve(undefined)
    await release.promise
    await original()
  })
  const second = vi.spyOn(runtimes[1]!, 'dispose')
  const eviction = router.evictIdleNow()
  let shutdown: Promise<void> | undefined
  try {
    await entered.promise
    shutdown = ctx.fiber.dispose()
    await vi.waitFor(() => { expect(second).toHaveBeenCalledTimes(1) })
    release.resolve(undefined)
    await Promise.all([eviction, shutdown])
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(router.openWorkspaceRoots()).toEqual([])
  } finally {
    release.resolve(undefined)
    await eviction
    await (shutdown ?? ctx.fiber.dispose())
    first.mockRestore()
    second.mockRestore()
  }
})

it.each(['open-failure', 'eviction', 'shutdown'] as const)('closes SQLite after a settled drain failure during %s', async (phase) => {
  const { a, db } = await fixture()
  const { ctx, router } = await setup(db)
  const handle = await router.forWorkspace(a)
  const openFailure = new Error('fixture opening failure')
  // oxlint-disable-next-line typescript/unbound-method -- each original method receives the actual runtime below
  const originalOpen = LocalCodeIndexRuntime.prototype.ensureOpen
  // oxlint-disable-next-line typescript/unbound-method -- each original method receives the actual runtime below
  const originalDrain = LocalCodeIndexRuntime.prototype.embedDrainIdle
  const open = vi.spyOn(LocalCodeIndexRuntime.prototype, 'ensureOpen')
  const drain = vi.spyOn(LocalCodeIndexRuntime.prototype, 'embedDrainIdle').mockImplementation(async function (this: LocalCodeIndexRuntime) {
    await originalDrain.call(this)
    throw new Error('fixture settled drain failure')
  })
  const dispose = vi.spyOn(LocalCodeIndexRuntime.prototype, 'dispose')
  try {
    if (phase === 'open-failure') {
      open.mockImplementationOnce(async function (this: LocalCodeIndexRuntime) {
        await originalOpen.call(this)
        throw openFailure
      })
      await expect(handle.status()).rejects.toBe(openFailure)
    } else {
      await handle.status()
      if (phase === 'eviction') await router.evictIdleNow()
      else await ctx.fiber.dispose()
    }
    expect(drain).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(router.openWorkspaceRoots()).toEqual([])
  } finally {
    open.mockRestore()
    drain.mockRestore()
    dispose.mockRestore()
    await ctx.fiber.dispose()
  }
})

it('combines expired and LRU eviction while preserving an active workspace', async () => {
  const { root, a, b, db } = await fixture()
  const c = join(root, 'workspace-c')
  await mkdir(c)
  await writeFile(join(c, 'gamma.ts'), 'export function gammaActive() { return 33 }\n')
  const { ctx, router } = await setup(db, 1, 60_000)
  const bEntered = Promise.withResolvers<undefined>()
  const cEntered = Promise.withResolvers<undefined>()
  const releaseB = Promise.withResolvers<undefined>()
  const releaseC = Promise.withResolvers<undefined>()
  const originalNow = Date.now.bind(Date)
  let offset = 0
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => originalNow() + offset)
  // oxlint-disable-next-line typescript/unbound-method -- invoked with the actual runtime receiver
  const originalSearch = LocalCodeIndexRuntime.prototype.search
  const search = vi.spyOn(LocalCodeIndexRuntime.prototype, 'search').mockImplementation(async function (this: LocalCodeIndexRuntime, request, signal) {
    if (request.query === 'betaNebulaOnly') { bEntered.resolve(undefined); await releaseB.promise }
    if (request.query === 'gammaActive') { cEntered.resolve(undefined); await releaseC.promise }
    return originalSearch.call(this, request, signal)
  })
  const outstanding: Promise<unknown>[] = []
  try {
    await (await router.forWorkspace(a)).status()
    await (Reflect.get(router, 'evictionChain') as Promise<void>)
    const bIndex = await router.forWorkspace(b)
    const cIndex = await router.forWorkspace(c)
    const bQuery = bIndex.search({ query: 'betaNebulaOnly' })
    outstanding.push(bQuery)
    await bEntered.promise
    const cQuery = cIndex.search({ query: 'gammaActive' })
    outstanding.push(cQuery)
    await cEntered.promise
    expect(router.openWorkspaceRoots()).toHaveLength(3)
    offset = 60_001
    releaseB.resolve(undefined)
    expect((await bQuery).hits).toHaveLength(1)
    await (Reflect.get(router, 'evictionChain') as Promise<void>)
    expect(router.openWorkspaceRoots()).toEqual([cIndex.workspaceRoot])
    releaseC.resolve(undefined)
    expect((await cQuery).hits).toHaveLength(1)
    await (Reflect.get(router, 'evictionChain') as Promise<void>)
    expect(router.openWorkspaceRoots()).toEqual([cIndex.workspaceRoot])
  } finally {
    releaseB.resolve(undefined)
    releaseC.resolve(undefined)
    await Promise.allSettled(outstanding)
    await ctx.fiber.dispose()
    search.mockRestore()
    clock.mockRestore()
  }
})

it('joins an eviction that closes a just-finished query before the shutdown waiter resumes', async () => {
  const { a, b, db } = await fixture()
  const { ctx, router } = await setup(db)
  await (await router.forWorkspace(a)).status()
  const bIndex = await router.forWorkspace(b)
  await bIndex.status()
  await (Reflect.get(router, 'evictionChain') as Promise<void>)
  const internal = router as unknown as { entries: Map<string, { runtime: LocalCodeIndexRuntime }> }
  const [firstRuntime, secondRuntime] = [...internal.entries.values()].map(entry => entry.runtime)
  const closeEntered = Promise.withResolvers<undefined>()
  const releaseClose = Promise.withResolvers<undefined>()
  const queryEntered = Promise.withResolvers<undefined>()
  const releaseQuery = Promise.withResolvers<undefined>()
  const originalClose = firstRuntime!.dispose.bind(firstRuntime)
  const originalSearch = secondRuntime!.search.bind(secondRuntime)
  const firstClose = vi.spyOn(firstRuntime!, 'dispose').mockImplementationOnce(async () => {
    closeEntered.resolve(undefined)
    await releaseClose.promise
    await originalClose()
  })
  const secondClose = vi.spyOn(secondRuntime!, 'dispose')
  const search = vi.spyOn(secondRuntime!, 'search').mockImplementationOnce(async (request, signal) => {
    queryEntered.resolve(undefined)
    await releaseQuery.promise
    return originalSearch(request, signal)
  })
  const eviction = router.evictIdleNow()
  let query: ReturnType<typeof bIndex.search> | undefined
  let shutdown: Promise<void> | undefined
  try {
    await closeEntered.promise
    query = bIndex.search({ query: 'betaNebulaOnly' })
    await queryEntered.promise
    shutdown = ctx.fiber.dispose()
    await vi.waitFor(() => { expect(Reflect.get(router, 'disposed')).toBe(true) })
    expect(secondClose).not.toHaveBeenCalled()
    releaseQuery.resolve(undefined)
    expect((await query).hits).toHaveLength(1)
    releaseClose.resolve(undefined)
    await Promise.all([eviction, shutdown])
    expect(firstClose).toHaveBeenCalledTimes(1)
    expect(secondClose).toHaveBeenCalledTimes(1)
    expect(router.openWorkspaceRoots()).toEqual([])
  } finally {
    releaseQuery.resolve(undefined)
    releaseClose.resolve(undefined)
    await Promise.allSettled([query, eviction, shutdown ?? ctx.fiber.dispose()])
    firstClose.mockRestore()
    secondClose.mockRestore()
    search.mockRestore()
  }
})

it('delegates repeated shutdown ownership to the single Cordis effect', async () => {
  const { a, db } = await fixture()
  const { ctx, router } = await setup(db)
  const handle = await router.forWorkspace(a)
  await handle.status()
  const internal = router as unknown as {
    disposeRouter: () => Promise<void>
    entries: Map<string, { runtime: LocalCodeIndexRuntime }>
  }
  const runtime = [...internal.entries.values()][0]!.runtime
  const cleanup = vi.spyOn(internal, 'disposeRouter')
  const dispose = vi.spyOn(runtime, 'dispose')
  try {
    await Promise.all([ctx.fiber.dispose(), ctx.fiber.dispose()])
    await ctx.fiber.dispose()
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(router.openWorkspaceRoots()).toEqual([])
    await expect(handle.status()).rejects.toThrow('disposed')
  } finally {
    cleanup.mockRestore()
    dispose.mockRestore()
    await ctx.fiber.dispose()
  }
})
