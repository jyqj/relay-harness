/**
 * The fixed system-prompt section positioning `search_code_index` against raw
 * text scanning (`grep`/`glob`) and explaining staleness handling. Shipped
 * verbatim through `ctx.systemPrompt.section`; the README quotes it under its
 * Model Experience block.
 *
 * @module @relay-harness/rlh-tool-code-index/system-prompt
 */

import type { Context } from '@relay-harness/cordis'
import type {} from '@relay-harness/rlh-system-prompt'

/** Cordis prompt-section name for the code-index guidance. */
export const CODE_INDEX_PROMPT_SECTION_NAME = 'tool:code-index'

/**
 * Prompt order. The shipped per-tool band is dense (read 100 … cordis 115), so
 * this sits directly after the filesystem discovery pair (glob 103, grep 104)
 * and before shell tools (bash/pwsh 105) — no shipped package claims 107.
 */
export const CODE_INDEX_PROMPT_SECTION_ORDER = 107

/** The exact section text; also quoted in the package README. */
export const CODE_INDEX_PROMPT_TEXT =
  'Prefer search_code_index over grep/glob when locating the symbols, declarations, or chunks relevant to '
  + 'a change question: it ranks indexed spans with explanations and costs far less than raw scanning. Once you know '
  + 'the symbols involved, use explore_code_graph for cross-file structure questions: it walks callers and callees of '
  + 'a symbol, sweeps what a change would break together with its impacted tests, maps files to the tests that '
  + 'cover them, and surfaces circular import cycles and never-called symbols. Use grep/glob '
  + 'instead for exact literals and formats the index may not cover, or when you need every occurrence. If results '
  + 'look stale after edits, check code_index_status for the current epoch and call refresh_code_index (force only '
  + 'to rebuild from scratch) before blaming the index for a miss.'

/**
 * Register the fixed guidance section. Registration is an effect scoped to the
 * plugin context, so disposing the plugin fiber removes the section.
 *
 * @param ctx - the plugin context carrying the system-prompt service.
 */
export function registerSystemPromptSection(ctx: Context): void {
  ctx.systemPrompt.section({
    name: CODE_INDEX_PROMPT_SECTION_NAME,
    order: CODE_INDEX_PROMPT_SECTION_ORDER,
    text: CODE_INDEX_PROMPT_TEXT,
  })
}
