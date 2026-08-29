/** Explicit draft-only Context provider for Prompt Enhancement. */

import type { Context } from '@relay-harness/cordis'
import type { PromptEnhancementContextProvider } from '@relay-harness/rlh-prompt-enhancement'

export const name = 'prompt-enhancement-context-none'
export const inject = ['promptEnhancement']

/**
 * Register the deployment's explicit choice to enhance only the supplied draft.
 * @param ctx - context exposing the Prompt Enhancement service.
 */
export function apply(ctx: Context): void {
  const provider: PromptEnhancementContextProvider = {
    id: name,
    prepare: () => Promise.resolve({ messages: [] }),
  }
  ctx.promptEnhancement.registerContextProvider(provider)
}
