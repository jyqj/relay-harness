import { Context } from '@relay-harness/cordis'
import { SlotRegistry } from '@relay-harness/rlh-client-runtime/client'
import { LocaleRuntime } from '@relay-harness/rlh-client-locale/client'
import { resolveSlotLabel } from '@relay-harness/rlh-client-ui-slots'
import type { CodeIndexManagementStatus } from '@relay-harness/rlh-api-remotes/client'
import { expect, it, vi } from 'vitest'
import * as entrypoint from '../src/client/index.ts'
import type { CodeIndexCenterInjected } from '../src/client/CodeIndexCenterSection.tsx'

it.each(['dispose', 'restart'] as const)('registers scoped index actions and fences waiting reads across %s', async (lifecycle) => {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  ctx.provide('sessions', {} as never)
  const status: CodeIndexManagementStatus = {
    workspaceRoot: '/fixture', indexedFileCount: 1, chunkCount: 2, tier: 'tiny',
    epochs: { indexEpoch: 1, evidenceEpoch: 0 }, degraded: false, generations: [],
  }
  const result = {
    executedTopK: 10,
    result: { query: 'needle', tier: 'tiny', candidateCount: 0, epochs: status.epochs,
      truncated: false, degraded: false, readErrors: [], hits: [] },
  }
  const remote = {
    status: vi.fn(async () => ({ ok: true, value: status })),
    refresh: vi.fn(async () => ({ ok: true, value: status })),
    reconcile: vi.fn(async () => ({ ok: true, value: status })),
    rebuild: vi.fn(async () => ({ ok: true, value: status })),
    search: vi.fn(async () => ({ ok: true, value: result })),
  }
  ctx.provide('remote', { codeIndexCenter: remote } as never)
  ctx.provide('remote.codeIndexCenter', remote)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
  const fork = ctx.plugin({ inject: [...entrypoint.inject], apply: entrypoint.apply })
  try {
    await fork.await()
    const entry = slots.entries('settings.section')[0]!
    expect(entry.options).toMatchObject({ id: 'code-index', order: 19 })
    expect(resolveSlotLabel(entry.options.label)).toBe('Code Index')
    const face = entry.inject!() as unknown as CodeIndexCenterInjected
    expect(Object.keys(face).sort()).toEqual(['rebuild', 'reconcile', 'refresh', 'search', 'status', 't'])
    expect(await face.status('session')).toBe(status)
    expect(await face.status('session')).toBe(status)
    expect(remote.status).toHaveBeenCalledTimes(1)
    ctx.emit('connection/reset')
    await face.status('session')
    expect(remote.status).toHaveBeenCalledTimes(2)
    await face.status('session', true)
    expect(remote.status).toHaveBeenCalledTimes(3)
    for (const action of ['refresh', 'reconcile', 'rebuild'] as const) {
      expect(await face[action]('session')).toBe(status)
      expect(remote[action]).toHaveBeenCalledWith({ sessionId: 'session', ...(action === 'rebuild' ? { confirmation: 'REBUILD' } : {}) })
    }
    expect(await face.search('session', 'needle')).toBe(result)
    expect(remote.search).toHaveBeenCalledWith({ sessionId: 'session', query: 'needle', topK: 10 })
    const completion = Promise.withResolvers<{ ok: boolean; value: CodeIndexManagementStatus }>()
    remote.refresh.mockImplementationOnce(() => completion.promise)
    const maintenance = face.refresh('session')
    const waitingRead = face.status('session', true)
    const statusCalls = remote.status.mock.calls.length
    if (lifecycle === 'dispose') await fork.dispose()
    else await fork.restart()
    expect(slots.entries('settings.section')).toHaveLength(lifecycle === 'dispose' ? 0 : 1)
    completion.resolve({ ok: true, value: status })
    expect(await maintenance).toBe(status)
    await expect(waitingRead).rejects.toThrow(/inactive context|disposed/u)
    expect(remote.status).toHaveBeenCalledTimes(statusCalls)
    for (const action of ['status', 'refresh', 'reconcile', 'rebuild'] as const) {
      await expect(face[action]('session')).rejects.toThrow('disposed')
    }
    await expect(face.search('session', 'needle')).rejects.toThrow('disposed')
    if (lifecycle === 'restart') {
      const replacement = slots.entries('settings.section')[0]!.inject!() as unknown as CodeIndexCenterInjected
      expect(await replacement.status('session')).toBe(status)
      expect(remote.status).toHaveBeenCalledTimes(statusCalls + 1)
    }

  } finally { await ctx.fiber.dispose() }
})

it('keeps implementation components and caches private to the plugin', () => {
  expect(Object.keys(entrypoint).sort()).toEqual(['apply', 'inject'])
})
