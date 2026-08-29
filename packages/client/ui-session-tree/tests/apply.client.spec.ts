/** Session Tree native slot registration and private controller handoff. */
import { Context } from '@relay-harness/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@relay-harness/rlh-client-runtime/client'
import { LocaleRuntime } from '@relay-harness/rlh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { apply as applyNode } from '../src/index.ts'
import { SessionTreeAction } from '../src/client/SessionTreeAction.tsx'
import type { SessionTreeActionInjected } from '../src/client/SessionTreeAction.tsx'
import { SessionTreeCanvas } from '../src/client/SessionTreeCanvas.tsx'
import type { SessionTreeCanvasInjected } from '../src/client/SessionTreeCanvas.tsx'
import { SessionTreeTitlebarAction } from '../src/client/SessionTreeTitlebarAction.tsx'
import type { SessionTreeTitlebarActionInjected } from '../src/client/SessionTreeTitlebarAction.tsx'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.slots.register({
    name: 'root',
    children: {
      'shell.overlay': { kind: 'list', scope: 'root' },
      'shell.titlebar.trailing': { kind: 'list', scope: 'root' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    },
  } as never, () => null)
  const open = vi.fn()
  const fork = vi.fn(() => Promise.resolve('child'))
  const prompt = vi.fn(() => Promise.resolve({ ok: true }))
  const sessionOf = vi.fn((_scope: Context): { prompt: typeof prompt } | undefined => ({ prompt }))
  const scope = vi.fn((_id: string): Context | undefined => ctx)
  const archiveSession = vi.fn(() => Promise.resolve())
  const startSession = vi.fn()
  ctx.provide('sessions', { open, fork, scope, sessionOf } as never)
  ctx.provide('workspaces', { startSession, archiveSession } as never)
  ctx.provide('connection', {
    api: { sessions: { history: vi.fn(() => Promise.resolve({ result: { ok: true, value: { events: [], hasMore: false } } })) } },
  } as never)
  ctx.provide('locale', new LocaleRuntime(ctx))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, fiber, open, fork, prompt, scope, sessionOf, archiveSession, startSession }
}

describe('ui-session-tree apply', () => {
  it('declares only the services it consumes', () => {
    expect(inject).toEqual(['connection', 'locale', 'sessions', 'slots', 'workspaces'])
  })

  it('registers the native opener and overlay, shares transient open state, and disposes both', async () => {
    const b = await bench()
    const overlay = b.ctx.slots.entries('shell.overlay')[0]!
    const action = b.ctx.slots.entries('conversation.session.header.actions')[0]!
    const titlebar = b.ctx.slots.entries('shell.titlebar.trailing')[0]!
    expect(overlay.component).toBe(SessionTreeCanvas)
    expect(overlay.options).toMatchObject({ id: 'session-tree', order: 10 })
    expect(action.component).toBe(SessionTreeAction)
    expect(action.options).toMatchObject({ id: 'session-tree', order: 15 })
    expect(titlebar.component).toBe(SessionTreeTitlebarAction)
    expect(titlebar.options).toMatchObject({ id: 'session-tree', order: 15 })

    const overlayFace = (overlay.inject as unknown as () => SessionTreeCanvasInjected)()
    const actionFace = (action.inject as unknown as (id: string) => SessionTreeActionInjected)('parent')
    const titlebarFace = (titlebar.inject as unknown as () => SessionTreeTitlebarActionInjected)()
    expect(overlayFace.hooks.treeOpen.getSnapshot()).toEqual({ open: false })
    actionFace.openTree()
    expect(overlayFace.hooks.treeOpen.getSnapshot()).toEqual({ open: true, anchorSessionId: 'parent' })
    overlayFace.closeTree()
    expect(overlayFace.hooks.treeOpen.getSnapshot()).toEqual({ open: false, anchorSessionId: 'parent' })
    titlebarFace.openTree('other' as never)
    expect(overlayFace.hooks.treeOpen.getSnapshot()).toEqual({ open: true, anchorSessionId: 'other' })
    overlayFace.closeTree()

    await overlayFace.forkSession({ sessionId: 'parent' as never, atSeq: 9 })
    expect(b.fork).toHaveBeenCalledWith({ sessionId: 'parent', atSeq: 9, increaseTitle: true })
    overlayFace.openSession('parent' as never)
    expect(b.open).toHaveBeenCalledWith('parent')
    await expect(overlayFace.loadHistory('parent' as never)).resolves.toEqual([])
    await expect(overlayFace.sendMessage('parent' as never, 'hello')).resolves.toBeUndefined()
    expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'hello' }], 'queue')
    overlayFace.startSession('workspace' as never)
    expect(b.startSession).toHaveBeenCalledWith('workspace')
    await overlayFace.archiveSession('parent' as never)
    expect(b.archiveSession).toHaveBeenCalledWith('parent')

    b.sessionOf.mockReturnValueOnce(undefined)
    await expect(overlayFace.sendMessage('missing' as never, 'hello')).rejects.toThrow('unavailable')
    b.scope.mockReturnValueOnce(undefined)
    await expect(overlayFace.sendMessage('missing-scope' as never, 'hello')).rejects.toThrow('unavailable')
    b.prompt.mockResolvedValueOnce({ ok: false, error: { code: 'internal', message: 'nope' } } as never)
    await expect(overlayFace.sendMessage('parent' as never, 'hello')).rejects.toThrow('internal: nope')

    await b.fiber.dispose()
    expect(b.ctx.slots.entries('shell.overlay')).toHaveLength(0)
    expect(b.ctx.slots.entries('shell.titlebar.trailing')).toHaveLength(0)
    expect(b.ctx.slots.entries('conversation.session.header.actions')).toHaveLength(0)
  })

  it('keeps the Host half inert', () => {
    expect(applyNode).not.toThrow()
  })
})
