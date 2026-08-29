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
