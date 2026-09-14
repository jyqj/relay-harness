/** Shared Chat / Work / Library product shell and Simple-mode visibility policy. */
import type { ConnectionHandle } from '@relay-harness/rlh-api-remotes/client'
import type { ClientContext, SessionId } from '@relay-harness/rlh-client-runtime/client'
import type {} from '@relay-harness/rlh-api-remotes/client'
import type {} from '@relay-harness/rlh-client-ui-sidebar/client'
import type {} from '@relay-harness/rlh-client-ui-settings/client'
import type {} from '@relay-harness/rlh-client-ui-settings-general/client'
import type {} from '@relay-harness/rlh-client-ui-conversation/client'
import type {} from '@relay-harness/rlh-client-locale/client'
import type {} from '@relay-harness/rlh-client-ui-layout/client'
import { ProductNavigation, type ProductNavigationInjected } from './ProductNavigation.tsx'
import { WorkActivity, type WorkActivityInjected } from './WorkActivity.tsx'
import { ProductShellService } from './mode.ts'
import { CurrentWorkProjection } from './work-projection.ts'
import { WorkPage, type WorkPageInjected } from './WorkPage.tsx'
import { LibraryPage, type LibraryPageInjected } from './LibraryPage.tsx'
import { ProductModeRow, type ProductModeRowInjected } from './ProductModeRow.tsx'
import { en, zh } from './locales.ts'

declare module '@relay-harness/rlh-client-ui-slots' {
  interface SlotMap {
    /** Execution relationships in the current Work main page. */
    'work.activity': { kind: 'single'; scope: 'root' }
  }
}

export type { ProductModeView } from './mode.ts'
export type { WorkSummary } from './work-projection.ts'

/** Advanced-only surfaces hidden by Simple Mode; provenance inspection deliberately remains visible. */
const SIMPLE_MODE_SUPPRESSIONS = [
  ['settings.section', 'models'],
  ['settings.section', 'agent-presets'],
  ['settings.section', 'plugins'],
  ['settings.general.item', 'agent-preset'],
  ['conversation.input.model', undefined],
  ['conversation.hero.agentPreset', undefined],
  ['conversation.session.header.actions', 'agent-preset'],
  ['conversation.view', 'trajectory'],
] as const

export const inject = ['layout', 'connection', 'slots', 'sessions', 'workspaces', 'remote', 'remote.productMode', 'remote.workResults', 'locale', 'settingsNavigation']

/** Install navigation pages, persisted mode control, and reversible advanced-entry suppression. */
export function apply(ctx: ClientContext): void {
  const product = new ProductShellService(ctx)
  const connection = ctx.get('connection') as ConnectionHandle
  const work = new CurrentWorkProjection(ctx.sessions, connection.readiness)
  ctx.effect(() => () => { work.dispose() }, 'ui-product-shell: Work projection')
  ctx.effect(() => ctx.locale.register('productShell', { zh, en }), 'ui-product-shell: dictionaries')
  const openConversation = (sessionId: SessionId): void => {
    const address = ctx.sessions.subagentAddress(sessionId)
    if (address === undefined) ctx.sessions.open(sessionId)
    else ctx.sessions.openSubagent(address)
    ctx.layout.openMain('conversation')
  }
  const openFiles = (): void => {
    const sessionId = ctx.sessions.list.getSnapshot().current
    if (sessionId === undefined) return
    window.dispatchEvent(new CustomEvent('rlhd-open-surface', { detail: { kind: 'files', sessionId } }))
  }
  ctx.slots.inject('sidebar.primary', () => ctx.slots.register({
    name: 'sidebar.primary', id: 'product', locale: 'productShell',
    inject: (): ProductNavigationInjected => ({
      hooks: { mainNavigation: ctx.layout.mainNavigation, work },
      openPage: page => { ctx.layout.openMain(page) },
    }),
  }, ProductNavigation))

  ctx.effect(() => {
    let releases: Array<() => void> = []
    const sync = (): void => {
      for (const release of releases) release()
      releases = []
      if (product.store.getSnapshot().mode !== 'simple') return
      releases = SIMPLE_MODE_SUPPRESSIONS.map(([slot, id]) => id === undefined
        ? ctx.slots.suppress(slot)
        : ctx.slots.suppress(slot, id))
    }
    sync()
    const off = product.store.subscribe(sync)
    return () => { off(); for (const release of releases) release() }
  }, 'ui-product-shell: advanced entry policy')

  ctx.effect(() => {
    const off = ctx.on('connection/reset', () => { void product.load() })
    void product.load()
    return off
  }, 'ui-product-shell: mode refresh')

  ctx.slots.inject('shell.page', () => [
    ctx.slots.register({
      name: 'shell.page', key: 'work', locale: 'productShell',
      children: { 'work.activity': { kind: 'single', scope: 'root' } },
      inject: (): WorkPageInjected => ({
        hooks: { work },
        openConversation: sessionId => { openConversation(sessionId as SessionId) },
        startWork: () => { ctx.layout.openMain('conversation'); ctx.workspaces.startSession() },
        openFiles,
        openDeliverable: async (sessionId, path) => {
          const result = await ctx.remote.workResults.open({ sessionId: sessionId as SessionId, path })
          if (!result.ok) throw new Error(result.error.message)
        },
        verifyWork: async (sessionId, signal) => {
          const result = await ctx.remote.workResults.get(sessionId as SessionId, signal)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        acceptWork: async (sessionId, reviewRevision) => {
          const result = await ctx.remote.workResults.accept(sessionId as SessionId, { reviewRevision })
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
      }),
    }, WorkPage),
    ctx.slots.register({
      name: 'shell.page', key: 'library', locale: 'productShell',
      inject: (): LibraryPageInjected => ({
        hooks: { connection: connection.readiness },
        openSource: entry => { openConversation(entry.sessionId) },
        openFiles,
        openSettings: (section) => { ctx.settingsNavigation.open(section) },
        queryLibrary: async (request, signal) => {
          const result = await ctx.remote.workResults.list(request, signal)
          if (!result.ok) throw new Error(result.error.message)
          return result.value
        },
        openLibraryOutput: async (entry) => {
          const result = await ctx.remote.workResults.open({ sessionId: entry.sessionId, path: entry.path })
          if (!result.ok) throw new Error(result.error.message)
        },
      }),
    }, LibraryPage),
  ])
  ctx.slots.inject('work.activity', () => ctx.slots.register({
    name: 'work.activity', locale: 'productShell',
    inject: (): WorkActivityInjected => ({ openConversation }),
  }, WorkActivity))
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item', id: 'product-mode', order: 30, locale: 'productShell',
    inject: (): ProductModeRowInjected => ({ hooks: { productMode: product.store }, setMode: mode => product.set(mode) }),
  }, ProductModeRow))
}
