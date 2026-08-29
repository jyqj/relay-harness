/** Browser Code Index Center settings plugin. */
import type { ClientContext } from '@relay-harness/rlh-client-runtime/client'
import type {} from '@relay-harness/rlh-api-remotes/client'
import type {} from '@relay-harness/rlh-client-ui-settings/client'
import type {} from '@relay-harness/rlh-client-locale/client'
import { CodeIndexCenterSection } from './CodeIndexCenterSection.tsx'
import type { CodeIndexCenterInjected } from './CodeIndexCenterSection.tsx'
import { CodeIndexCenterStore } from './store.ts'
import { en, zh, type CodeIndexCenterLocaleKey } from './locales.ts'

export { CodeIndexCenterSection } from './CodeIndexCenterSection.tsx'
export { CodeIndexCenterStore } from './store.ts'
export type { CodeIndexCenterLocaleKey } from './locales.ts'

declare module '@relay-harness/rlh-client-ui-slots' {
  interface LocaleNamespaceMap { 'settings.codeIndex': CodeIndexCenterLocaleKey }
}

export const inject = ['slots', 'locale', 'remote', 'remote.codeIndexCenter', 'sessions']

export function apply(ctx: ClientContext): void {
  const store = new CodeIndexCenterStore(ctx)
  ctx.effect(() => ctx.on('connection/reset', () => {
    store.invalidate()
  }), 'ui-code-index-center: reset')
  ctx.effect(
    () => ctx.locale.register('settings.codeIndex', { zh, en }),
    'ui-code-index-center: dictionaries',
  )
  const t = ctx.locale.bind('settings.codeIndex') as CodeIndexCenterInjected['t']
  const currentSessionId = () => ctx.sessions.list.getSnapshot().current
  const subscribeSession = (listener: () => void) => ctx.sessions.list.subscribe(listener)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'code-index',
    order: 19,
    label: () => t('nav'),
    locale: 'settings.codeIndex',
    inject: (): CodeIndexCenterInjected => ({
      t,
      currentSessionId,
      subscribeSession,
      status: (sessionId, fresh) => store.status(sessionId, fresh),
      refresh: sessionId => store.refresh(sessionId),
      reconcile: sessionId => store.reconcile(sessionId),
      rebuild: sessionId => store.rebuild(sessionId),
      search: (sessionId, query) => store.search({ sessionId, query, topK: 10 }),
    }),
  }, CodeIndexCenterSection))
}
