/**
 * Deliverables plugin, node half. Registers response-format guidance while the Host work-results capability owns
 * the whole-log inventory over execution-captured mutation paths. The browser
 * half ships via exports["./client"], discovered through the package.json
 * rlh.client declaration.
 */

import type { Context } from '@relay-harness/cordis'
import type {} from '@relay-harness/rlh-system-prompt'

/** Services required for the model guidance paired with the browser renderer. */
export const inject = ['systemPrompt']

/** Stable final-response guidance owned by the matching renderer. */
const FILE_REFERENCE_PROMPT = 'When you successfully create or modify files, mention the primary outputs in your final response. '
  + 'To make those and any other changed-file references clickable in Web, format them as Markdown inline code using the exact file-tool path, or a basename when unique among the files changed in that turn.'

/**
 * Register model guidance paired with the turn-local browser renderer.
 * @param ctx - host context carrying the system-prompt registry.
 */
export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'ui:deliverable-file-references',
    order: 190,
    text: FILE_REFERENCE_PROMPT,
  })
}
