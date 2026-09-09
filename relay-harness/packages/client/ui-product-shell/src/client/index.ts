/** Shared Chat / Work / Library product shell and Simple-mode visibility policy. */
import type { ClientContext, SessionId } from '@relay-harness/rlh-client-runtime/client'
import type {} from '@relay-harness/rlh-api-remotes/client'
import type {} from '@relay-harness/rlh-client-ui-sidebar/client'
import type {} from '@relay-harness/rlh-client-ui-settings/client'
import type {} from '@relay-harness/rlh-client-ui-settings-general/client'
import type {} from '@relay-harness/rlh-client-ui-conversation/client'
import type {} from '@relay-harness/rlh-client-locale/client'
import type { PropsLocale, PropsRuntime } from '@relay-harness/rlh-client-ui-slots'
import { ProductShellService } from './mode.ts'
import { CurrentWorkProjection } from './work-projection.ts'
import { WorkPage, type WorkPageInjected } from './WorkPage.tsx'
import { LibraryPage, type LibraryPageInjected } from './LibraryPage.tsx'
import { ProductModeRow, type ProductModeRowInjected } from './ProductModeRow.tsx'
import { en, zh } from './locales.ts'

/** Product copy occupant for the sidebar's built-in session-browser tab. */
function ChatLabel({ t }: PropsRuntime<'sidebar.chat.label'> & PropsLocale<'productShell'>) { return t('nav.chat') }

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

export const inject = ['slots', 'sessions', 'workspaces', 'remote', 'remote.productMode', 'remote.workResults', 'locale', 'settingsNavigation']

/** Install navigation pages, persisted mode control, and reversible advanced-entry suppression. */
export function apply(ctx: ClientContext): void {
  const product = new ProductShellService(ctx)
  const work = new CurrentWorkProjection(ctx.sessions)
  ctx.effect(() => () => { work.dispose() }, 'ui-product-shell: Work projection')
  ctx.effect(() => ctx.locale.register('productShell', { zh, en }), 'ui-product-shell: dictionaries')
  const t = ctx.locale.bind('productShell')

  ctx.slots.inject('sidebar.chat.label', () => ctx.slots.register({
    name: 'sidebar.chat.label', locale: 'productShell',
  }, ChatLabel))

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

  ctx.slots.inject('sidebar.nav.tab', () => [
    ctx.slots.register({ name: 'sidebar.nav.tab', id: 'work', order: 10, label: () => t('nav.work'), locale: 'productShell' }, () => null),
    ctx.slots.register({ name: 'sidebar.nav.tab', id: 'library', order: 20, label: () => t('nav.library'), locale: 'productShell' }, () => null),
  ])
  ctx.slots.inject('sidebar.page', () => [
    ctx.slots.register({
      name: 'sidebar.page', key: 'work', locale: 'productShell',
      inject: (): WorkPageInjected => ({
        hooks: { work },
        openFiles: () => { window.dispatchEvent(new CustomEvent('rlhd-open-surface', { detail: { kind: 'files' } })) },
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
      name: 'sidebar.page', key: 'library', locale: 'productShell',
      inject: (): LibraryPageInjected => ({
        openFiles: () => { window.dispatchEvent(new CustomEvent('rlhd-open-surface', { detail: { kind: 'files' } })) },
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
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item', id: 'product-mode', order: 30, locale: 'productShell',
    inject: (): ProductModeRowInjected => ({ hooks: { productMode: product.store }, setMode: mode => product.set(mode) }),
  }, ProductModeRow))
}
