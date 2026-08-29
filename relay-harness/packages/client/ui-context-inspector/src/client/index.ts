/** Browser plugin mounting the Context Inspector into conversation chrome. */
import type { ClientContext } from '@relay-harness/rlh-client-runtime/client'
import type {} from '@relay-harness/rlh-client-ui-conversation/client'
import type {} from '@relay-harness/rlh-client-locale/client'
import type {} from '@relay-harness/rlh-context-inspector/client'
import { ContextInspectorAction } from './ContextInspectorAction.tsx'
import { en, zh, type ContextInspectorLocaleKey } from './locales.ts'
export type { ContextInspectorLocaleKey } from './locales.ts'
export { ContextInspectorAction } from './ContextInspectorAction.tsx'
declare module '@relay-harness/rlh-client-ui-slots' { interface LocaleNamespaceMap { contextInspector: ContextInspectorLocaleKey } }
export const inject = ['slots', 'locale', 'sessions']
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register('contextInspector', { zh, en }), 'ui-context-inspector: dictionaries')
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities', id: 'context-inspector', order: 10, locale: 'contextInspector',
  }, ContextInspectorAction))
}
