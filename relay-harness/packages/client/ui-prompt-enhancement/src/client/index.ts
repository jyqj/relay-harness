/** Prompt Enhancement browser plugin over the generated Remote namespace. */

import type { PromptEnhancementOutcome } from '@relay-harness/rlh-api-remotes/client'
import type {} from '@relay-harness/rlh-api-remotes/client'
import type {} from '@relay-harness/rlh-client-locale/client'
import type { ClientContext, SessionId } from '@relay-harness/rlh-client-runtime/client'
import type {} from '@relay-harness/rlh-client-ui-conversation/client'
import { EnhanceControl } from './EnhanceControl.tsx'
import { en, zh, type PromptEnhancementKey } from './locales.ts'

export type { PromptEnhancementKey } from './locales.ts'

declare module '@relay-harness/rlh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Prompt Enhancement composer-control copy. */
    promptEnhancement: PromptEnhancementKey
  }
}

const NS = 'promptEnhancement'

/** Host-backed actions injected into the composer control. */
export interface PromptEnhancementInjected {
  /** Run one cancellable enhancement through the generated Remote. */
  readonly enhance: (draft: string, signal: AbortSignal) => Promise<PromptEnhancementOutcome>
}

/** Required services: input slot, Prompt Enhancement Remote, and locale. */
export const inject = [
  'slots', 'remote', 'remote.promptEnhancement', 'locale',
]

/** Register the Enhance control without modifying InputBar. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-prompt-enhancement: dictionaries')
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'prompt-enhancement',
    order: 10,
    locale: NS,
    inject: (sessionId: SessionId): PromptEnhancementInjected => ({
      enhance: async (draft, signal) => {
        const response = await ctx.remote.promptEnhancement.enhance(sessionId, draft, signal)
        if (!response.ok) throw new Error(`${response.error.message} (${response.error.code})`)
        return response.value
      },
    }),
  }, EnhanceControl))
}
