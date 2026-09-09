import { Context } from '@relay-harness/cordis'
import { SlotRegistry } from '@relay-harness/rlh-client-runtime/client'
import { LocaleRuntime } from '@relay-harness/rlh-client-locale/client'
import { resolveSlotLabel } from '@relay-harness/rlh-client-ui-slots'
import { expect, it, vi } from 'vitest'
import * as entrypoint from '../src/client/index.ts'
import type { MemoryCenterSectionInjected } from '../src/client/MemoryCenterSection.tsx'
import { memory, snapshot } from './memory-fixtures.client.ts'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  ctx.provide('sessions', {} as never)
  const page = snapshot()
  const detail = memory()
  const remote = {
    list: vi.fn(async () => ({ ok: true, value: page })),
    read: vi.fn(async () => ({ ok: true, value: detail })),
    approve: vi.fn(), reject: vi.fn(), revise: vi.fn(), delete: vi.fn(),
  }
  ctx.provide('remote', { memoryCenter: remote } as never)
  ctx.provide('remote.memoryCenter', remote)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: { 'settings.section': { kind: 'list', scope: 'root' } } } as never, () => null)
  const fork = ctx.plugin({ inject: [...entrypoint.inject], apply: entrypoint.apply })
  await fork.await()
  return { ctx, slots, fork, remote, page, detail }
}

it('registers Memory settings, resets scoped caches on reconnect, and unloads its slot', async () => {
  const { ctx, slots, fork, remote, page, detail } = await bench()
  try {
    const entry = slots.entries('settings.section')[0]!
    expect(entry.options).toMatchObject({ id: 'memory', order: 17 })
    expect(resolveSlotLabel(entry.options.label)).toBe('Memory')
    const face = entry.inject!() as unknown as MemoryCenterSectionInjected
    const request = { workspaceId: '/work', sessionId: 'session' }
    const selection = { ...request, id: 'm1' }
    expect(await face.list(request)).toBe(page)
    expect(await face.list(request)).toBe(page)
    expect(await face.read(selection)).toBe(detail)
    expect(await face.read(selection)).toBe(detail)
    expect(remote.list).toHaveBeenCalledTimes(1)
    expect(remote.read).toHaveBeenCalledTimes(1)
    ctx.emit('connection/reset')
    await face.list(request)
    await face.read(selection)
    expect(remote.list).toHaveBeenCalledTimes(2)
    expect(remote.read).toHaveBeenCalledTimes(2)
    await fork.dispose()
    expect(slots.entries('settings.section')).toEqual([])
  } finally { await ctx.fiber.dispose() }
})

it.each(['approve', 'reject', 'revise', 'tombstone'] as const)('forwards registered %s and invalidates successful governance reads', async (action) => {
  const { ctx, slots, remote } = await bench()
  const face = slots.entries('settings.section')[0]!.inject!() as unknown as MemoryCenterSectionInjected
  const request = { workspaceId: '/work', sessionId: 'session' }
  const selection = { ...request, id: 'm1' }
  const result = memory(action === 'reject' || action === 'tombstone' ? 'tombstoned' : 'active')
  const native = action === 'tombstone' ? remote.delete : remote[action]
  native.mockResolvedValue({ ok: true, value: result })
  const input = { content: '  revised text  ', summary: null, importance: 4, confidence: 0, validUntil: null }
  try {
    await face.list(request)
    await face.read(selection)
    const changed = action === 'approve' ? await face.approve('session', 'm1', 1)
      : action === 'reject' ? await face.reject('session', 'm1', 1, '  review reason  ')
        : action === 'revise' ? await face.revise('session', 'm1', 1, input)
          : await face.tombstone('session', 'm1', 1, '  review reason  ')
    expect(changed).toBe(result)
    expect(native).toHaveBeenCalledWith({
      sessionId: 'session', id: 'm1', expectedRevision: 1,
      ...(action === 'reject' || action === 'tombstone' ? { reason: '  review reason  ' } : {}),
      ...(action === 'revise' ? input : {}),
    })
    await face.list(request)
    await face.read(selection)
    expect(remote.list).toHaveBeenCalledTimes(2)
    expect(remote.read).toHaveBeenCalledTimes(2)
  } finally { await ctx.fiber.dispose() }
})

it('reports an unavailable governance service without discarding previously loaded reads', async () => {
  const { ctx, slots, remote, page, detail } = await bench()
  const face = slots.entries('settings.section')[0]!.inject!() as unknown as MemoryCenterSectionInjected
  const request = { workspaceId: '/work', sessionId: 'session' }
  const selection = { ...request, id: 'm1' }
  remote.approve.mockResolvedValue({ ok: false, error: { code: 'offline', message: 'service unavailable' } })
  try {
    await face.list(request)
    await face.read(selection)
    await expect(face.approve('session', 'm1', 1)).rejects.toThrow('memoryCenter.approve failed: offline: service unavailable')
    expect(await face.list(request)).toBe(page)
    expect(await face.read(selection)).toBe(detail)
    expect(remote.list).toHaveBeenCalledTimes(1)
    expect(remote.read).toHaveBeenCalledTimes(1)
  } finally { await ctx.fiber.dispose() }
})

it('keeps cache implementation and locale namespace out of public value exports', () => {
  expect(Object.keys(entrypoint).sort()).toEqual(['apply', 'inject'])
})
