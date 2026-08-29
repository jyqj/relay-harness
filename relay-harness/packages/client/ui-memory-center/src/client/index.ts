/** Memory Center settings plugin, browser half. */
import type { ClientContext } from '@relay-harness/rlh-client-runtime/client'
import type {} from '@relay-harness/rlh-client-ui-settings/client'
import type {} from '@relay-harness/rlh-client-locale/client'
import type {} from '@relay-harness/rlh-api-remotes/client'
import { MemoryCenterSection } from './MemoryCenterSection.tsx'
import type { MemoryCenterSectionInjected } from './MemoryCenterSection.tsx'
import { MemoryCenterStore } from './store.ts'
import { en, zh, type MemoryCenterLocaleKey } from './locales.ts'

export type { MemoryCenterSectionInjected, MemoryCenterSectionProps } from './MemoryCenterSection.tsx'
export type { MemoryCenterLocaleKey } from './locales.ts'
export { MemoryCenterStore } from './store.ts'

declare module '@relay-harness/rlh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.memory': MemoryCenterLocaleKey
  }
}

/** Memory Center dictionary namespace. */
export const NS = 'settings.memory'
export const inject = ['slots', 'locale', 'remote', 'remote.memoryCenter', 'sessions']

/** Register the Memory Center settings section and its scoped Client cache. */
export function apply(ctx: ClientContext): void {
  const store = new MemoryCenterStore(ctx)
  ctx.effect(() => {
    const dispose = ctx.on('connection/reset', () => { store.invalidate() })
    return dispose
  }, 'ui-memory-center: cache reset')
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-memory-center: dictionaries')
  const t = ctx.locale.bind(NS) as MemoryCenterSectionInjected['t']
  const injected = (): MemoryCenterSectionInjected => ({
    t,
    list: (request, fresh) => store.list(request, fresh),
    read: (request, fresh) => store.read(request, fresh),
    approve: (sessionId, id, revision) => store.approve(sessionId, id, revision),
    reject: (sessionId, id, revision, reason) => store.reject(sessionId, id, revision, reason),
    revise: (sessionId, id, revision, input) => store.revise(sessionId, id, revision, input),
    tombstone: (sessionId, id, revision, reason) => store.tombstone(sessionId, id, revision, reason),
  })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'memory',
    order: 17,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, MemoryCenterSection))
}
