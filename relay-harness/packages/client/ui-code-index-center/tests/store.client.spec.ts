import { describe, expect, it, vi } from 'vitest'
import { CodeIndexCenterStore } from '../src/client/store.ts'
const status = { workspaceRoot: '/workspace/a', indexedFileCount: 1, chunkCount: 2, tier: 'tiny', epochs: { indexEpoch: 1, evidenceEpoch: 0 }, degraded: false, generations: [] }
describe('CodeIndexCenterStore', () => {
  it('partitions status cache by Session, invalidates, and unwraps Remote failures', async () => {
    const remote = {
      status: vi.fn(async ({ sessionId }: { sessionId: string }) => ({ ok: true, value: { ...status, workspaceRoot: `/workspace/${sessionId}` } })),
      refresh: vi.fn(async () => ({ ok: true, value: status })),
      reconcile: vi.fn(async () => ({ ok: false, error: { code: 'FAIL', message: 'broken' } })),
      rebuild: vi.fn(), search: vi.fn(),
    }
    const store = new CodeIndexCenterStore({ remote: { codeIndexCenter: remote } } as never)
    expect((await store.status('a')).workspaceRoot).toBe('/workspace/a')
    expect((await store.status('a')).workspaceRoot).toBe('/workspace/a')
    expect((await store.status('b')).workspaceRoot).toBe('/workspace/b')
    expect(remote.status).toHaveBeenCalledTimes(2)
    store.invalidate(); await store.status('a'); expect(remote.status).toHaveBeenCalledTimes(3)
    await expect(store.reconcile('a')).rejects.toThrow(/FAIL: broken/)
  })
})

it.each(['invalidate', 'fresh', 'refresh', 'reconcile', 'rebuild'] as const)('prevents an old status read from repopulating cache after %s', async (operation) => {
  const held = Promise.withResolvers<{ ok: true; value: typeof status }>()
  const newer = { ...status, indexedFileCount: 7 }
  const remote = {
    status: vi.fn().mockReturnValueOnce(held.promise).mockResolvedValue({ ok: true, value: newer }),
    refresh: vi.fn(async () => ({ ok: true, value: newer })),
    reconcile: vi.fn(async () => ({ ok: true, value: newer })),
    rebuild: vi.fn(async () => ({ ok: true, value: newer })),
  }
  const store = new CodeIndexCenterStore({ remote: { codeIndexCenter: remote } } as never)
  const oldRead = store.status('a')
  if (operation === 'invalidate') store.invalidate()
  else if (operation === 'fresh') await store.status('a', true)
  else await store[operation]('a')
  held.resolve({ ok: true, value: status })
  expect(await oldRead).toBe(status)
  expect(await store.status('a')).toBe(newer)
})

it('preserves other Session caches and allows retry after the newest request fails', async () => {
  const held = Promise.withResolvers<{ ok: true; value: typeof status }>()
  const other = { ...status, workspaceRoot: '/workspace/b' }
  const newest = { ...status, indexedFileCount: 9 }
  const remote = {
    status: vi.fn().mockResolvedValueOnce({ ok: true, value: other })
      .mockReturnValueOnce(held.promise)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue({ ok: true, value: newest }),
  }
  const store = new CodeIndexCenterStore({ remote: { codeIndexCenter: remote } } as never)
  expect(await store.status('b')).toBe(other)
  const oldRead = store.status('a')
  await expect(store.status('a', true)).rejects.toThrow('offline')
  held.resolve({ ok: true, value: status })
  expect(await oldRead).toBe(status)
  expect(await store.status('b')).toBe(other)
  expect(await store.status('a')).toBe(newest)
  expect(remote.status).toHaveBeenCalledTimes(4)
})

it.each(['refresh', 'reconcile', 'rebuild'] as const)('waits for pending %s before reading status again', async (operation) => {
  const completion = Promise.withResolvers<{ ok: true; value: typeof status }>()
  const newer = { ...status, indexedFileCount: 8 }
  let persisted = status
  const remote = {
    status: vi.fn(async () => ({ ok: true, value: persisted })),
    [operation]: vi.fn(() => completion.promise),
  }
  const store = new CodeIndexCenterStore({ remote: { codeIndexCenter: remote } } as never)
  await store.status('a')
  const maintenance = store[operation]('a')
  const read = store.status('a', true)
  await Promise.resolve()
  const callsWhilePending = remote.status.mock.calls.length
  persisted = newer
  completion.resolve({ ok: true, value: newer })
  await maintenance
  expect(await read).toBe(newer)
  expect(callsWhilePending).toBe(1)
  expect(await store.status('a')).toBe(newer)
})

it('rereads instead of serving old cached status after pending maintenance fails', async () => {
  const held = Promise.withResolvers<{ ok: true; value: typeof status }>()
  const newer = { ...status, indexedFileCount: 4 }
  const remote = {
    status: vi.fn().mockResolvedValueOnce({ ok: true, value: status }).mockResolvedValue({ ok: true, value: newer }),
    refresh: vi.fn(() => held.promise),
  }
  const store = new CodeIndexCenterStore({ remote: { codeIndexCenter: remote } } as never)
  await store.status('a')
  const maintenance = store.refresh('a')
  const rejection = expect(maintenance).rejects.toThrow('maintenance failed')
  const read = store.status('a')
  held.reject(new Error('maintenance failed'))
  await rejection
  expect(await read).toBe(newer)
  expect(remote.status).toHaveBeenCalledTimes(2)
})

it('waits for newly admitted maintenance through reset without blocking another Session', async () => {
  const first = Promise.withResolvers<{ ok: true; value: typeof status }>()
  const second = Promise.withResolvers<{ ok: true; value: typeof status }>()
  const newer = { ...status, indexedFileCount: 9 }
  const remote = {
    status: vi.fn(async () => ({ ok: true, value: newer })),
    refresh: vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
  }
  const store = new CodeIndexCenterStore({ remote: { codeIndexCenter: remote } } as never)
  const firstWrite = store.refresh('a')
  const read = store.status('a')
  const secondWrite = store.refresh('a')
  store.invalidate()
  expect(await store.status('b')).toBe(newer)
  first.resolve({ ok: true, value: status })
  await firstWrite
  await Promise.resolve()
  expect(remote.status).toHaveBeenCalledTimes(1)
  expect(remote.status).toHaveBeenLastCalledWith({ sessionId: 'b' })
  second.resolve({ ok: true, value: newer })
  await secondWrite
  expect(await read).toBe(newer)
  expect(remote.status).toHaveBeenLastCalledWith({ sessionId: 'a' })
  expect(await store.status('a')).toBe(newer)
  expect(remote.status).toHaveBeenCalledTimes(2)
})
