import { Context } from '@relay-harness/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductShellService } from '../src/client/mode.ts'

describe('ProductShellService', () => {
  afterEach(() => { Reflect.deleteProperty(globalThis, 'window') })
  it('opens simple before the Host answers, folds writes, and reloads after errors', async () => {
    const ctx = new Context()
    const get = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { mode: 'simple' } })
      .mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: 'offline' } })
    const set = vi.fn().mockResolvedValue({ ok: true, value: { mode: 'developer' } })
    ctx.provide('remote', { productMode: { get, set } } as never)
    const service = new ProductShellService(ctx)
    expect(service.store.getSnapshot().mode).toBe('simple')
    await service.load()
    expect(service.store.getSnapshot()).toEqual({ mode: 'simple', status: 'ready', error: null })
    await service.set('developer')
    expect(set).toHaveBeenCalledWith({ mode: 'developer' })
    expect(service.store.getSnapshot()).toEqual({ mode: 'developer', status: 'ready', error: null })
    await service.load()
    expect(service.store.getSnapshot()).toMatchObject({ mode: 'developer', status: 'error', error: 'offline: offline' })
  })

  it('rolls a rejected write back to the last confirmed mode', async () => {
    const ctx = new Context()
    ctx.provide('remote', { productMode: {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue({ ok: false, error: { code: 'denied', message: 'read only' } }),
    } } as never)
    const service = new ProductShellService(ctx)
    await service.set('developer')
    expect(service.store.getSnapshot()).toMatchObject({ mode: 'simple', status: 'error' })
  })

  it('keeps a fresh Desktop Simple default aligned without inventing Developer mode', async () => {
    const ctx = new Context()
    const set = vi.fn()
    const saveConfig = vi.fn(async () => ({ simpleMode: true }))
    Object.assign(globalThis, { window: { shell: { getConfig: async () => ({ simpleMode: true }), saveConfig } } })
    ctx.provide('remote', { productMode: {
      get: vi.fn().mockResolvedValue({ ok: true, value: { mode: 'simple' } }), set,
    } } as never)
    const service = new ProductShellService(ctx)
    await service.load()
    expect(service.store.getSnapshot().mode).toBe('simple')
    expect(set).not.toHaveBeenCalled()
    expect(saveConfig).toHaveBeenCalledWith({ simpleMode: true })
  })

  it('migrates a legacy explicit Desktop false once and mirrors Developer mode', async () => {
    const ctx = new Context()
    const set = vi.fn().mockResolvedValue({ ok: true, value: { mode: 'developer' } })
    const saveConfig = vi.fn(async () => ({ simpleMode: false }))
    Object.assign(globalThis, { window: { shell: { getConfig: async () => ({ simpleMode: false }), saveConfig } } })
    ctx.provide('remote', { productMode: {
      get: vi.fn().mockResolvedValue({ ok: true, value: { mode: 'simple' } }), set,
    } } as never)
    const service = new ProductShellService(ctx)
    await service.load()
    expect(set).toHaveBeenCalledWith({ mode: 'developer' })
    expect(service.store.getSnapshot().mode).toBe('developer')
    expect(saveConfig).toHaveBeenCalledWith({ simpleMode: false })
  })
})

it.each(['load', 'set'] as const)('does not publish or mirror a late %s response after owner disposal', async (operation) => {
  const ctx = new Context()
  const held = Promise.withResolvers<{ ok: true; value: { mode: 'developer' } }>()
  const get = vi.fn(() => held.promise)
  const set = vi.fn(() => held.promise)
  const saveConfig = vi.fn()
  Object.assign(globalThis, { window: { shell: { saveConfig } } })
  ctx.provide('remote', { productMode: { get, set } } as never)
  const service = new ProductShellService(ctx)
  const publish = vi.fn()
  const off = service.store.subscribe(publish)
  const pending = operation === 'load' ? service.load() : service.set('developer')
  const before = service.store.getSnapshot()
  try {
    await ctx.fiber.dispose()
    publish.mockClear()
    held.resolve({ ok: true, value: { mode: 'developer' } })
    await pending
    expect(service.store.getSnapshot()).toBe(before)
    expect(publish).not.toHaveBeenCalled()
    expect(saveConfig).not.toHaveBeenCalled()
    await service.load()
    await service.set('simple')
    expect(get.mock.calls.length + set.mock.calls.length).toBe(1)
  } finally {
    held.resolve({ ok: true, value: { mode: 'developer' } })
    await pending
    off()
    await ctx.fiber.dispose()
    Reflect.deleteProperty(globalThis, 'window')
  }
})

it('does not migrate a legacy Desktop flag that arrives after disposal', async () => {
  const ctx = new Context()
  const legacy = Promise.withResolvers<{ simpleMode: boolean }>()
  const getConfig = vi.fn(() => legacy.promise)
  const saveConfig = vi.fn()
  const set = vi.fn()
  Object.assign(globalThis, { window: { shell: { getConfig, saveConfig } } })
  ctx.provide('remote', { productMode: {
    get: async () => ({ ok: true, value: { mode: 'simple' } }), set,
  } } as never)
  const service = new ProductShellService(ctx)
  const loading = service.load()
  try {
    await vi.waitFor(() => { expect(getConfig).toHaveBeenCalledTimes(1) })
    await ctx.fiber.dispose()
    legacy.resolve({ simpleMode: false })
    await loading
    expect(set).not.toHaveBeenCalled()
    expect(saveConfig).not.toHaveBeenCalled()
  } finally {
    legacy.resolve({ simpleMode: false })
    await loading
    await ctx.fiber.dispose()
    Reflect.deleteProperty(globalThis, 'window')
  }
})

it('keeps an old mode service retired when its owning plugin restarts', async () => {
  const ctx = new Context()
  const get = vi.fn(async () => ({ ok: true, value: { mode: 'simple' } }))
  const set = vi.fn(async () => ({ ok: true, value: { mode: 'developer' } }))
  ctx.provide('remote', { productMode: { get, set } } as never)
  const instances: ProductShellService[] = []
  const fork = ctx.plugin((owner) => { instances.push(new ProductShellService(owner)) })
  try {
    await fork.await()
    const old = instances[0]!
    await old.load()
    await fork.restart()
    await fork.await()
    expect(instances).toHaveLength(2)
    const current = instances[1]!
    const oldSnapshot = old.store.getSnapshot()
    const reads = get.mock.calls.length
    await old.load()
    await old.set('developer')
    expect(get).toHaveBeenCalledTimes(reads)
    expect(set).not.toHaveBeenCalled()
    expect(old.store.getSnapshot()).toBe(oldSnapshot)
    await current.load()
    await current.set('developer')
    expect(set).toHaveBeenCalledTimes(1)
    expect(current.store.getSnapshot()).toMatchObject({ mode: 'developer', status: 'ready' })
  } finally { await ctx.fiber.dispose() }
})

it.each(['resolve', 'reject'] as const)('keeps a newer chosen mode when an old read later %s', async (outcome) => {
  const ctx = new Context()
  const held = Promise.withResolvers<{ ok: true; value: { mode: 'simple' } }>()
  ctx.provide('remote', { productMode: {
    get: () => held.promise,
    set: async () => ({ ok: true, value: { mode: 'developer' } }),
  } } as never)
  const service = new ProductShellService(ctx)
  const read = service.load()
  try {
    await service.set('developer')
    if (outcome === 'resolve') held.resolve({ ok: true, value: { mode: 'simple' } })
    else held.reject(new Error('obsolete read failed'))
    await read
    expect(service.store.getSnapshot()).toEqual({ mode: 'developer', status: 'ready', error: null })
  } finally {
    held.resolve({ ok: true, value: { mode: 'simple' } })
    await read
    await ctx.fiber.dispose()
  }
})

it.each(['resolve', 'reject'] as const)('does not roll back a newer write when an older write later %s', async (outcome) => {
  const ctx = new Context()
  const held = Promise.withResolvers<{ ok: true; value: { mode: 'developer' } }>()
  const set = vi.fn().mockReturnValueOnce(held.promise).mockResolvedValueOnce({ ok: true, value: { mode: 'simple' } })
  ctx.provide('remote', { productMode: { get: vi.fn(), set } } as never)
  const service = new ProductShellService(ctx)
  const older = service.set('developer')
  try {
    await service.set('simple')
    if (outcome === 'resolve') held.resolve({ ok: true, value: { mode: 'developer' } })
    else held.reject(new Error('obsolete write failed'))
    await older
    expect(service.store.getSnapshot()).toEqual({ mode: 'simple', status: 'ready', error: null })
    expect(set.mock.calls).toEqual([[{ mode: 'developer' }], [{ mode: 'simple' }]])
  } finally {
    held.resolve({ ok: true, value: { mode: 'developer' } })
    await older
    await ctx.fiber.dispose()
  }
})

it.each([false, true])('reads Host mode after a pending write settles; write failure=%s', async (fails) => {
  const ctx = new Context()
  const commit = Promise.withResolvers<undefined>()
  let persisted: 'simple' | 'developer' = 'simple'
  const get = vi.fn(async () => ({ ok: true, value: { mode: persisted } }))
  const set = vi.fn(async () => {
    await commit.promise
    if (fails) throw new Error('fixture persistence rejected')
    persisted = 'developer'
    return { ok: true, value: { mode: persisted } }
  })
  ctx.provide('remote', { productMode: { get, set } } as never)
  const service = new ProductShellService(ctx)
  await service.load()
  const writing = service.set('developer')
  const resetting = service.load()
  try {
    await Promise.resolve()
    await Promise.resolve()
    expect(get).toHaveBeenCalledTimes(1)
    commit.resolve(undefined)
    await Promise.all([writing, resetting])
    expect(persisted).toBe(fails ? 'simple' : 'developer')
    expect(service.store.getSnapshot()).toEqual({ mode: persisted, status: 'ready', error: null })
    expect(get).toHaveBeenCalledTimes(2)
  } finally {
    commit.resolve(undefined)
    await Promise.all([writing, resetting])
    await ctx.fiber.dispose()
  }
})

it('keeps reload waiting when another write is admitted during the first wait', async () => {
  const ctx = new Context()
  const first = Promise.withResolvers<undefined>()
  const second = Promise.withResolvers<undefined>()
  let persisted: 'simple' | 'developer' = 'simple'
  const get = vi.fn(async () => ({ ok: true, value: { mode: persisted } }))
  const set = vi.fn(async ({ mode }: { mode: 'simple' | 'developer' }) => {
    await (mode === 'developer' ? first.promise : second.promise)
    persisted = mode
    return { ok: true, value: { mode } }
  })
  ctx.provide('remote', { productMode: { get, set } } as never)
  const service = new ProductShellService(ctx)
  await service.load()
  const older = service.set('developer')
  const reload = service.load()
  const newer = service.set('simple')
  try {
    first.resolve(undefined)
    await older
    await Promise.resolve()
    expect(get).toHaveBeenCalledTimes(1)
    second.resolve(undefined)
    await Promise.all([newer, reload])
    expect(get).toHaveBeenCalledTimes(2)
    expect(service.store.getSnapshot()).toEqual({ mode: persisted, status: 'ready', error: null })
    expect(persisted).toBe('simple')
  } finally {
    first.resolve(undefined)
    second.resolve(undefined)
    await Promise.all([older, newer, reload])
    await ctx.fiber.dispose()
  }
})

it('does not resume a deferred reload after the plugin is disposed', async () => {
  const ctx = new Context()
  const commit = Promise.withResolvers<undefined>()
  const get = vi.fn(async () => ({ ok: true, value: { mode: 'simple' } }))
  const set = vi.fn(async () => { await commit.promise; return { ok: true, value: { mode: 'developer' } } })
  ctx.provide('remote', { productMode: { get, set } } as never)
  const service = new ProductShellService(ctx)
  await service.load()
  const writing = service.set('developer')
  const reload = service.load()
  const before = service.store.getSnapshot()
  try {
    await ctx.fiber.dispose()
    commit.resolve(undefined)
    await Promise.all([writing, reload])
    expect(get).toHaveBeenCalledTimes(1)
    expect(service.store.getSnapshot()).toBe(before)
  } finally {
    commit.resolve(undefined)
    await Promise.all([writing, reload])
    await ctx.fiber.dispose()
  }
})

it.each(['native-read', 'native-save', 'migration-rejected', 'migration-throws'] as const)('preserves Host mode when %s fails', async (failure) => {
  const ctx = new Context()
  const set = vi.fn().mockResolvedValue({ ok: false, error: { code: 'denied', message: 'migration refused' } })
  if (failure === 'migration-throws') set.mockRejectedValue(new Error('migration transport failed'))
  const getConfig = vi.fn(async () => {
    if (failure === 'native-read') throw new Error('native config unavailable')
    return { simpleMode: failure === 'native-save' }
  })
  const saveConfig = vi.fn(async () => {
    if (failure === 'native-save') throw new Error('native save unavailable')
    return undefined
  })
  Object.assign(globalThis, { window: { shell: { getConfig, saveConfig } } })
  ctx.provide('remote', { productMode: { get: async () => ({ ok: true, value: { mode: 'simple' } }), set } } as never)
  const service = new ProductShellService(ctx)
  try {
    await service.load()
    expect(service.store.getSnapshot()).toEqual({ mode: 'simple', status: 'ready', error: null })
    expect(set).toHaveBeenCalledTimes(failure.startsWith('migration') ? 1 : 0)
    expect(saveConfig).toHaveBeenCalledWith({ simpleMode: true })
    await service.load()
    expect(getConfig).toHaveBeenCalledTimes(1)
  } finally {
    await ctx.fiber.dispose()
    Reflect.deleteProperty(globalThis, 'window')
  }
})

it.each(['load', 'set'] as const)('reports a non-Error %s rejection and permits recovery', async (operation) => {
  const ctx = new Context()
  const get = vi.fn().mockRejectedValueOnce('fixture offline').mockResolvedValue({ ok: true, value: { mode: 'simple' } })
  const set = vi.fn().mockRejectedValueOnce('fixture denied').mockResolvedValue({ ok: true, value: { mode: 'developer' } })
  ctx.provide('remote', { productMode: { get, set } } as never)
  const service = new ProductShellService(ctx)
  try {
    if (operation === 'load') await service.load()
    else await service.set('developer')
    expect(service.store.getSnapshot()).toMatchObject({ status: 'error', error: operation === 'load' ? 'fixture offline' : 'fixture denied' })
    if (operation === 'load') await service.load()
    else await service.set('developer')
    expect(service.store.getSnapshot()).toMatchObject({ status: 'ready', error: null })
  } finally { await ctx.fiber.dispose() }
})

it.each(['load', 'set', 'mirror'] as const)('does not dispatch %s work after a synchronous subscriber unloads its owner', async (stage) => {
  const ctx = new Context()
  const get = vi.fn(async () => ({ ok: true, value: { mode: 'simple' } }))
  const set = vi.fn(async () => ({ ok: true, value: { mode: 'developer' } }))
  const saveConfig = vi.fn()
  Object.assign(globalThis, { window: { shell: { saveConfig } } })
  ctx.provide('remote', { productMode: { get, set } } as never)
  const instances: ProductShellService[] = []
  const fork = ctx.plugin({ inject: ['remote'], apply(owner: Context) { instances.push(new ProductShellService(owner)) } })
  await fork.await()
  const service = instances[0]!
  let closing: Promise<void> | undefined
  const off = service.store.subscribe(() => {
    if (stage === 'mirror' && service.store.getSnapshot().status !== 'ready') return
    closing ??= fork.dispose()
  })
  try {
    if (stage === 'load') await service.load()
    else await service.set('developer')
    expect(closing).toBeDefined()
    await closing
    expect(get).not.toHaveBeenCalled()
    expect(set).toHaveBeenCalledTimes(stage === 'mirror' ? 1 : 0)
    expect(saveConfig).not.toHaveBeenCalled()
  } finally {
    off()
    await ctx.fiber.dispose()
    Reflect.deleteProperty(globalThis, 'window')
  }
})
