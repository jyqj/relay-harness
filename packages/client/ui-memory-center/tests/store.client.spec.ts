import { describe, expect, it, vi } from 'vitest'
import type { ClientContext } from '@relay-harness/rlh-client-runtime/client'
import { MemoryCenterStore } from '../src/client/store.ts'

describe('MemoryCenterStore', () => {
  it('caches scoped pages and invalidates after a governance mutation', async () => {
    const snapshot = {
      scope: { workspaceId: '/work', userId: 'u', agentId: 'a' },
      entries: [], total: 0, offset: 0, hasMore: false,
      usageCoverage: { status: 'complete', sessionsScanned: 0, sessionsFailed: 0 },
    } as const
    const list = vi.fn(async () => ({ ok: true as const, value: snapshot }))
    const approve = vi.fn(async () => ({ ok: true as const, value: {
      memory: undefined,
      conflicts: [],
      signals: [],
      outcomes: [],
      outcomeSummary: { positive: 0, negative: 0, neutral: 0, rankingAdjustment: 0 },
      outcomeCoverage: 'unavailable',
      usageCoverage: { status: 'unavailable', sessionsScanned: 0, sessionsFailed: 0 },
    } }))
    const ctx = { remote: { memoryCenter: { list, approve } } } as unknown as ClientContext
    const store = new MemoryCenterStore(ctx)
    await store.list({ workspaceId: '/work', sessionId: 'session' })
    await store.list({ workspaceId: '/work', sessionId: 'session' })
    expect(list).toHaveBeenCalledTimes(1)
    await store.approve('session', 'memory', 1)
    await store.list({ workspaceId: '/work', sessionId: 'session' })
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('does not repopulate a cleared cache from a read that started before governance', async () => {
    const snapshot = {
      scope: { workspaceId: '/work', userId: 'u', agentId: 'a' }, entries: [], total: 0, offset: 0,
      hasMore: false, usageCoverage: { status: 'complete', sessionsScanned: 0, sessionsFailed: 0 },
    } as const
    let settle!: (value: { ok: true; value: typeof snapshot }) => void
    const list = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
      .mockResolvedValue({ ok: true, value: snapshot })
    const detail = {
      memory: undefined, conflicts: [], signals: [], outcomes: [],
      outcomeSummary: { positive: 0, negative: 0, neutral: 0, rankingAdjustment: 0 },
      outcomeCoverage: 'unavailable',
      usageCoverage: { status: 'unavailable', sessionsScanned: 0, sessionsFailed: 0 },
    }
    const approve = vi.fn(async () => ({ ok: true as const, value: detail }))
    const store = new MemoryCenterStore({ remote: { memoryCenter: { list, approve } } } as unknown as ClientContext)
    const request = { workspaceId: '/work', sessionId: 'session' }
    const stale = store.list(request)
    await Promise.resolve()
    await store.approve('session', 'memory', 1)
    settle({ ok: true, value: snapshot })
    await stale
    await store.list(request)
    expect(list).toHaveBeenCalledTimes(2)
  })
})
