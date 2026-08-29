/**
 * The model-facing consumer of the local code-index capability:
 * `search_code_index`, `explore_code_graph`, `code_index_status`, and
 * `refresh_code_index` over the optional `ctx.codeIndex` seam.
 *
 * ## Consumer, not provider
 *
 * This package owns schemas, argument validation, exit-side output budgeting
 * ({@link module:@relay-harness/rlh-tool-code-index/envelope}), prompt guidance,
 * and presentation; storage, scanning, ranking, and folding semantics stay in
 * whichever provider supplies `ctx.codeIndex`. The seam is resolved at
 * EXECUTION time through `ctx.get('codeIndex')` — deliberately not declared in
 * `inject` — because deployment compositions without an index provider must
 * still load cleanly for their other tools; a call without a provider fails as
 * structured `INDEX_TOOL_UNAVAILABLE` instead of blocking composition or
 * crashing the loop.
 *
 * Function plugin (named exports, no default export).
 *
 * @module @relay-harness/rlh-tool-code-index
 */

import type { Context } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import type {} from '@relay-harness/rlh-system-prompt'
import { applyExploreTool } from './explore-tool.ts'
import { applySearchTool } from './search-tool.ts'
import { applyStatusTool } from './status-tool.ts'
import { applyRefreshTool } from './refresh-tool.ts'
import { registerSystemPromptSection } from './system-prompt.ts'

export {
  TRUNCATION_ENVELOPE_RESERVE_BYTES,
  applyExitPolicy,
  safeJsonPrefixParse,
  utf8SafePrefix,
} from './envelope.ts'
export type { ExitPolicy, OutputTruncationEnvelope } from './envelope.ts'
export {
  CODE_INDEX_PROMPT_SECTION_NAME,
  CODE_INDEX_PROMPT_SECTION_ORDER,
  CODE_INDEX_PROMPT_TEXT,
  registerSystemPromptSection,
} from './system-prompt.ts'
export {
  INDEX_TOOL_FAILED,
  INDEX_TOOL_REFRESH_IN_PROGRESS,
  INDEX_TOOL_UNAVAILABLE,
  CodeIndexToolError,
  normalizeCodeIndexFailure,
} from './errors.ts'
export type { CodeIndexToolErrorCode } from './errors.ts'
export {
  formatSearchHit,
  isTruncationEnvelope,
  parseSearchArgs,
  presentSearchCall,
  presentSearchResult,
  renderSearchOutput,
  toPlainSearchResult,
  toSearchRequest,
} from './search-tool.ts'
export type { SearchCodeIndexArgs, SearchHitView, SearchToolCaps, SearchToolOutput, SearchToolResult } from './search-tool.ts'
export {
  formatCycleComponent,
  formatDeadCode,
  formatGraphEdge,
  formatGraphNode,
  formatTestPair,
  parseExploreArgs,
  presentExploreCall,
  presentExploreResult,
  renderExploreOutput,
  toExploreRequest,
  toPlainGraphResult,
} from './explore-tool.ts'
export type {
  ExploreCodeGraphArgs,
  ExploreCodeGraphOp,
  ExploreToolOutput,
  GraphToolCycleView,
  GraphToolDeadCodeView,
  GraphToolEdgeView,
  GraphToolExplainView,
  GraphToolNodeView,
  GraphToolResult,
  GraphToolTestPairView,
} from './explore-tool.ts'
export { presentStatusCall, presentStatusResult, renderStatusOutput } from './status-tool.ts'
export type { StatusReportView } from './status-tool.ts'
export { presentRefreshCall, presentRefreshResult, renderRefreshOutput } from './refresh-tool.ts'
export type { RefreshCodeIndexArgs } from './refresh-tool.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-code-index'

/**
 * Services required at registration. `codeIndex` stays OPTIONAL: it is read
 * through `ctx.get()` inside every execute, so a deployment without a provider
 * loads fine and fails individual calls with `INDEX_TOOL_UNAVAILABLE`.
 */
export const inject = ['tools', 'systemPrompt']

/** Plugin configuration. */
export interface Config {
  /**
   * Remove the model-facing `top_k` lever so the engine's repository-size-tier
   * cap always decides hit count (default false keeps the model lever).
   */
  clampTopKToTier?: boolean
}

export const Config: z<Config> = z.object({
  clampTopKToTier: z.boolean().default(false),
})

/**
 * Register the four code-index tools plus their fixed prompt guidance.
 *
 * @param ctx - plugin context; registrations are effects scoped to this plugin.
 * @param config - resolved plugin configuration (defaults applied by Cordis from `Config`).
 */
// oxlint-disable-next-line typescript/require-await -- async keeps a load-time config rejection a rejection, not a synchronous throw
export async function apply(ctx: Context, config?: Config): Promise<void> {
  const clampTopKToTier = config?.clampTopKToTier === true
  registerSystemPromptSection(ctx)
  applySearchTool(ctx, { clampTopKToTier })
  applyExploreTool(ctx)
  applyStatusTool(ctx)
  applyRefreshTool(ctx)
}
