// @vitest-environment jsdom
import { createElement, type ComponentType } from 'react'
import { cleanup, render } from '@testing-library/react'
import { Context } from '@relay-harness/cordis'
import { SlotRegistry } from '@relay-harness/rlh-client-runtime/client'
import { LocaleRuntime } from '@relay-harness/rlh-client-locale/client'
import { afterEach, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.ts'
import * as entrypoint from '../src/client/index.ts'
import { resolveSlotLabel } from '@relay-harness/rlh-client-ui-slots'
import type { ProductModeRowInjected } from '../src/client/ProductModeRow.tsx'
import type { WorkPageInjected } from '../src/client/WorkPage.tsx'
import type { LibraryPageInjected } from '../src/client/LibraryPage.tsx'
import type { WorkVerifiedReview, WorkAcceptReceipt, WorkLibraryEntry, WorkLibraryPage } from '@relay-harness/rlh-host-work-results/types'

afterEach(cleanup)

async function bench(install = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('en')
  ctx.provide('locale', locale)
  const listeners = new Set<() => void>()
  ctx.provide('sessions', { list: {
    getSnapshot: () => ({ current: undefined }),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  } } as never)
  const workResults = { open: vi.fn(), get: vi.fn(), accept: vi.fn(), list: vi.fn() }
  const getMode = vi.fn(async () => ({ ok: true, value: { mode: 'simple' } }))
  const openSettings = vi.fn()
  ctx.provide('settingsNavigation', { open: openSettings } as never)
  const productMode = {
    get: getMode,
    set: vi.fn(async ({ mode }: { mode: string }) => ({ ok: true, value: { mode } })),
  }
  ctx.provide('remote', { workResults, productMode } as never)
  ctx.provide('remote.productMode', productMode)
  ctx.provide('remote.workResults', workResults)
  ctx.provide('workspaces', {} as never)
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({ name: 'root', children: {
    'sidebar.chat.label': { kind: 'single', scope: 'root' },
    'sidebar.nav.tab': { kind: 'list', scope: 'root' },
    'sidebar.page': { kind: 'keyed', scope: 'root' },
    'settings.general.item': { kind: 'list', scope: 'root' },
    'settings.section': { kind: 'list', scope: 'root' },
    'conversation.session.header.utilities': { kind: 'list', scope: 'session' },
    'conversation.view': { kind: 'list', scope: 'session' },
  } } as never, () => null)
  const Provenance = () => null
  const Trajectory = () => null
  slots.register({ name: 'conversation.session.header.utilities', id: 'context-inspector' } as never, Provenance)
  slots.register({ name: 'conversation.view', id: 'trajectory' } as never, Trajectory)
  const Advanced = () => null
  slots.register({ name: 'settings.section', id: 'models' } as never, Advanced)
  // Real plugin admission/effect ownership; assembled browser tests additionally cover the shipped Loader tree.
  if (install) await ctx.plugin({ inject: [...entrypoint.inject], apply }).await()
  return { ctx, slots, listeners, Advanced, workResults, getMode, openSettings, locale, Provenance, Trajectory }
}

it('registers product navigation, switches suppression, and releases subscriptions on unload', async () => {
  const { ctx, slots, listeners, Advanced, Provenance, Trajectory } = await bench()
  try {
    await vi.waitFor(() => { expect(ctx.productShell.store.getSnapshot().status).toBe('ready') })
    expect(slots.entries('sidebar.nav.tab').map(entry => entry.options.id)).toEqual(['work', 'library'])
    expect(slots.entries('sidebar.page').map(entry => entry.options.key)).toEqual(['work', 'library'])
    expect(slots.entries('settings.general.item').map(entry => entry.options.id)).toEqual(['product-mode'])
    expect(slots.entriesOfSlot('settings.section')).toEqual([])
    expect(slots.entries('settings.section')).toHaveLength(1)
    expect(slots.entriesOfSlot('conversation.session.header.utilities').map(entry => entry.component)).toEqual([Provenance])
    expect(slots.entriesOfSlot('conversation.view')).toEqual([])
    expect(listeners.size).toBe(1)
    await ctx.productShell.set('developer')
    expect(slots.entriesOfSlot('settings.section').map(entry => entry.component)).toEqual([Advanced])
    expect(slots.entriesOfSlot('conversation.view').map(entry => entry.component)).toEqual([Trajectory])
    await ctx.productShell.set('simple')
    expect(slots.entriesOfSlot('settings.section')).toEqual([])
  } finally { await ctx.fiber.dispose() }
  expect(listeners.size).toBe(0)
})

it.each([false, true])('forwards registered Work and Library callbacks; remote failure=%s', async (fails) => {
  const { ctx, slots, workResults } = await bench()
  const work = slots.entries('sidebar.page').find(entry => entry.options.key === 'work')!.inject!() as unknown as WorkPageInjected
  const library = slots.entries('sidebar.page').find(entry => entry.options.key === 'library')!.inject!() as unknown as LibraryPageInjected
  const verified: WorkVerifiedReview = {
    reviewRevision: 7, acceptedRevision: null, reviewable: true, verifiedThroughSeq: 8, current: true,
  }
  const receipt: WorkAcceptReceipt = { reviewedThroughSeq: 7, recordedSeq: 8, current: true }
  const entry: WorkLibraryEntry = { sessionId: 'source-session' as WorkLibraryEntry['sessionId'], path: 'result.md' }
  const page: WorkLibraryPage = {
    entries: [entry], scannedSessions: 1, totalSessions: 1, unindexedResults: 0, unavailableSessions: 0, next: null,
  }
  const denied = { ok: false, error: { code: 'denied', message: 'fixture operation denied' } }
  workResults.open.mockResolvedValue(fails ? denied : { ok: true, value: undefined })
  workResults.get.mockResolvedValue(fails ? denied : { ok: true, value: verified })
  workResults.accept.mockResolvedValue(fails ? denied : { ok: true, value: receipt })
  workResults.list.mockResolvedValue(fails ? denied : { ok: true, value: page })
  const controller = new AbortController()
  const request = { query: 'result', sessionOffset: 3, pathOffset: 2, limit: 5 }
  try {
    const calls = [
      work.openDeliverable('work-session', 'result.md'),
      work.verifyWork('work-session', controller.signal),
      work.acceptWork('work-session', 7),
      library.queryLibrary(request, controller.signal),
      library.openLibraryOutput(entry),
    ]
    if (fails) {
      const outcomes = await Promise.allSettled(calls)
      for (const outcome of outcomes) {
        expect(outcome).toMatchObject({ status: 'rejected', reason: { message: 'fixture operation denied' } })
      }
    } else {
      expect(await Promise.all(calls)).toEqual([undefined, verified, receipt, page, undefined])
    }
    expect(workResults.open.mock.calls).toEqual([
      [{ sessionId: 'work-session', path: 'result.md' }], [{ sessionId: 'source-session', path: 'result.md' }],
    ])
    expect(workResults.get).toHaveBeenCalledWith('work-session', controller.signal)
    expect(workResults.accept).toHaveBeenCalledWith('work-session', { reviewRevision: 7 })
    expect(workResults.list).toHaveBeenCalledWith(request, controller.signal)
  } finally { await ctx.fiber.dispose() }
})

it('connects registered file/settings actions and reloads mode on connection reset', async () => {
  const { ctx, slots, getMode, openSettings, locale } = await bench()
  const target = window
  const events: unknown[] = []
  const onFiles = (event: Event): void => { events.push((event as CustomEvent<unknown>).detail) }
  target.addEventListener('rlhd-open-surface', onFiles)
  const work = slots.entries('sidebar.page').find(entry => entry.options.key === 'work')!.inject!() as unknown as WorkPageInjected
  const library = slots.entries('sidebar.page').find(entry => entry.options.key === 'library')!.inject!() as unknown as LibraryPageInjected
  const mode = slots.entries('settings.general.item').find(entry => entry.options.id === 'product-mode')!.inject!() as unknown as ProductModeRowInjected
  try {
    await vi.waitFor(() => { expect(ctx.productShell.store.getSnapshot().status).toBe('ready') })
    work.openFiles()
    library.openFiles()
    expect(events).toEqual([{ kind: 'files' }, { kind: 'files' }])
    for (const section of ['memory', 'skills', 'mcp', 'code-index'] as const) library.openSettings(section)
    expect(openSettings.mock.calls).toEqual([['memory'], ['skills'], ['mcp'], ['code-index']])
    expect(slots.entries('sidebar.nav.tab').map(entry => resolveSlotLabel(entry.options.label))).toEqual(['Work', 'Library'])
    for (const entry of slots.entries('sidebar.nav.tab')) {
      expect(render(createElement(entry.component as ComponentType)).container.innerHTML).toBe('')
    }
    const chat = slots.entries('sidebar.chat.label')[0]!.component as (props: { t: ReturnType<typeof locale.bind> }) => string
    expect(chat({ t: locale.bind('productShell') })).toBe('Chat')
    await mode.setMode('developer')
    expect(mode.hooks.productMode.getSnapshot().mode).toBe('developer')
    ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(mode.hooks.productMode.getSnapshot().mode).toBe('simple') })
    expect(getMode).toHaveBeenCalledTimes(2)
    await ctx.fiber.dispose()
    ctx.emit('connection/reset')
    expect(getMode).toHaveBeenCalledTimes(2)
  } finally {
    await ctx.fiber.dispose()
    target.removeEventListener('rlhd-open-surface', onFiles)
  }
})

it('exports only the public plugin loading values', () => {
  expect(Object.keys(entrypoint).sort()).toEqual(['apply', 'inject'])
})

it('removes scoped registrations and restores parent controls across plugin reload', async () => {
  const { ctx, slots, listeners, Advanced, Trajectory, Provenance } = await bench(false)
  const plugin = { inject: [...entrypoint.inject], apply }
  let fork = ctx.plugin(plugin)
  try {
    await fork.await()
    await vi.waitFor(() => { expect(ctx.productShell.store.getSnapshot().status).toBe('ready') })
    expect(listeners.size).toBe(1)
    expect(slots.entriesOfSlot('settings.section')).toEqual([])
    await fork.dispose()
    expect(listeners.size).toBe(0)
    expect(slots.entries('sidebar.nav.tab')).toEqual([])
    expect(slots.entries('sidebar.page')).toEqual([])
    expect(slots.entries('settings.general.item')).toEqual([])
    expect(slots.entriesOfSlot('settings.section').map(entry => entry.component)).toEqual([Advanced])
    expect(slots.entriesOfSlot('conversation.view').map(entry => entry.component)).toEqual([Trajectory])
    expect(slots.entriesOfSlot('conversation.session.header.utilities').map(entry => entry.component)).toEqual([Provenance])
    fork = ctx.plugin(plugin)
    await fork.await()
    await vi.waitFor(() => { expect(ctx.productShell.store.getSnapshot().status).toBe('ready') })
    expect(listeners.size).toBe(1)
    expect(slots.entries('sidebar.nav.tab').map(entry => entry.options.id)).toEqual(['work', 'library'])
    expect(slots.entriesOfSlot('settings.section')).toEqual([])
  } finally { await ctx.fiber.dispose() }
  expect(listeners.size).toBe(0)
})
