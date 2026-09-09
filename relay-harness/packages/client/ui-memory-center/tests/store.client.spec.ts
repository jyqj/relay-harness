import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@relay-harness/rlh-client-runtime/client'
import { MemoryCenterStore } from '../src/client/store.ts'
import { memory, snapshot as memorySnapshot } from './memory-fixtures.client.ts'

describe('MemoryCenterStore', () => {
  it('caches scoped pages and invalidates after a governance mutation', async () => {
    const snapshot = memorySnapshot()
    const list = vi.fn(async () => ({ ok: true as const, value: snapshot }))
    const approve = vi.fn(async () => ({ ok: true as const, value: memory('active') }))
    const ctx = { remote: { memoryCenter: { list, approve } } } as unknown as ClientContext
    const store = new MemoryCenterStore(ctx)
    await store.list({ workspaceId: '/work', sessionId: 'session' })
    await store.list({ workspaceId: '/work', sessionId: 'session' })
    expect(list).toHaveBeenCalledTimes(1)
    await store.approve('session', 'm1', 1)
    await store.list({ workspaceId: '/work', sessionId: 'session' })
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('does not repopulate a cleared cache from a read that started before governance', async () => {
    const snapshot = memorySnapshot()
    let settle!: (value: { ok: true; value: typeof snapshot }) => void
    const list = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
      .mockResolvedValue({ ok: true, value: snapshot })
    const detail = memory('active')
    const approve = vi.fn(async () => ({ ok: true as const, value: detail }))
    const store = new MemoryCenterStore({ remote: { memoryCenter: { list, approve } } } as unknown as ClientContext)
    const request = { workspaceId: '/work', sessionId: 'session' }
    const stale = store.list(request)
    await Promise.resolve()
    await store.approve('session', 'm1', 1)
    settle({ ok: true, value: snapshot })
    await stale
    await store.list(request)
    expect(list).toHaveBeenCalledTimes(2)
  })
})

it.each(['list', 'read'] as const)('does not let an older %s response replace a newer fresh cache value', async (method) => {
  const oldPage = memorySnapshot()
  const freshPage = memorySnapshot(memory('active'))
  const oldDetail = memory()
  const freshDetail = memory('active')
  const held = Promise.withResolvers<{ ok: true; value: typeof oldPage | typeof oldDetail }>()
  const remote = vi.fn().mockReturnValueOnce(held.promise)
    .mockResolvedValueOnce({ ok: true, value: method === 'list' ? freshPage : freshDetail })
  const store = new MemoryCenterStore({ remote: { memoryCenter: { [method]: remote } } } as unknown as ClientContext)
  const request = { workspaceId: '/work', sessionId: 'session' }
  const selection = { ...request, id: 'm1' }
  const stale = method === 'list' ? store.list(request) : store.read(selection)
  const fresh = method === 'list' ? await store.list(request, true) : await store.read(selection, true)
  held.resolve({ ok: true, value: method === 'list' ? oldPage : oldDetail })
  await stale
  const cached = method === 'list' ? await store.list(request) : await store.read(selection)
  expect(cached).toBe(fresh)
  expect(remote).toHaveBeenCalledTimes(2)
})

it('keeps unrelated scoped cache entries when one request is refreshed', async () => {
  const page = memorySnapshot()
  const list = vi.fn(async () => ({ ok: true as const, value: page }))
  const store = new MemoryCenterStore({ remote: { memoryCenter: { list } } } as unknown as ClientContext)
  const other = { workspaceId: '/work', sessionId: 'other-session' }
  await store.list(other)
  await store.list({ workspaceId: '/work', sessionId: 'session' }, true)
  expect(await store.list(other)).toBe(page)
  expect(list).toHaveBeenCalledTimes(2)
})

it('keeps search pages separate by query and offset and bypasses only the requested fresh page', async () => {
  const page = memorySnapshot()
  const list = vi.fn(async () => ({ ok: true as const, value: page }))
  const search = vi.fn(async () => ({ ok: true as const, value: page }))
  const store = new MemoryCenterStore({ remote: { memoryCenter: { list, search } } } as unknown as ClientContext)
  const base = { workspaceId: '/work', sessionId: 'session' }
  const query = { ...base, query: 'provenance', offset: 0, limit: 5 }
  await store.list(base)
  await store.list(query)
  await store.list(query)
  await store.list({ ...query, offset: 5 })
  await store.list({ ...query, query: 'other' })
  expect(list).toHaveBeenCalledTimes(1)
  expect(search).toHaveBeenCalledTimes(3)
  await store.list(query, true)
  expect(search).toHaveBeenCalledTimes(4)
  expect(search).toHaveBeenLastCalledWith(query)
  await store.list(base)
  expect(list).toHaveBeenCalledTimes(1)
})

it.each(['list', 'read'] as const)('does not cache an obsolete %s after a newer refresh fails', async (method) => {
  const page = memorySnapshot()
  const detail = memory()
  const value = method === 'list' ? page : detail
  const held = Promise.withResolvers<{ ok: true; value: typeof value }>()
  const remote = vi.fn().mockReturnValueOnce(held.promise)
    .mockRejectedValueOnce(new Error('fresh request failed'))
    .mockResolvedValueOnce({ ok: true, value })
  const store = new MemoryCenterStore({ remote: { memoryCenter: { [method]: remote } } } as unknown as ClientContext)
  const request = { workspaceId: '/work', sessionId: 'session' }
  const selection = { ...request, id: 'm1' }
  const old = method === 'list' ? store.list(request) : store.read(selection)
  const fresh = method === 'list' ? store.list(request, true) : store.read(selection, true)
  await expect(fresh).rejects.toThrow('fresh request failed')
  held.resolve({ ok: true, value })
  await old
  expect(await (method === 'list' ? store.list(request) : store.read(selection))).toBe(value)
  expect(remote).toHaveBeenCalledTimes(3)
})
