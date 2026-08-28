/**
 * Provider-neutral local code-index capability.
 *
 * The `CodeIndex` seam (`ctx.codeIndex`) owns the retrieval vocabulary — status, refresh,
 * and ranked chunk-level search over an on-disk derived index of the current workspace.
 * It owns no storage, scanning, or ranking mechanics: those live in the provider
 * (`@relay-harness/rlh-code-index-local`) and its collaborators.
 * @module @relay-harness/rlh-code-index
 */

import { Context, Service } from '@relay-harness/cordis'
import type {
  GraphExploreRequest,
  GraphExploreResult,
  IndexStatusReport,
  RefreshOptions,
  RefreshSummary,
  SearchRequest,
  SearchResult,
} from './types.ts'

export { CodeIndexError } from './errors.ts'
export {
  CODE_INDEX_DB_FOREIGN_APPLICATION,
  CODE_INDEX_NOT_INDEXED,
  CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED,
  CODE_INDEX_VECTOR_ROW_INVALID,
} from './errors.ts'
export {
  repoSizeTierFromFileCount,
  repoSizeTierGraphEnrichLimits,
  repoSizeTierMaxOutputChars,
  repoSizeTierMaxSnippetChars,
  repoSizeTierSearchTopK,
  repoSizeTierTokenBudget,
} from './tiers.ts'
export type * from './types.ts'
export type { EpochPair } from './types.ts'

declare module '@relay-harness/cordis' {
  interface Context {
    codeIndex: CodeIndex
  }
}

/** Service Definition for the local code-index capability (`ctx.codeIndex`). */
export abstract class CodeIndex extends Service {
  constructor(ctx: Context) {
    super(ctx, 'codeIndex')
  }

  /**
   * Report index health without side effects.
   * @returns current file count, resolved tier, epoch pair, last refresh summary, and degraded flag.
   */
  abstract status(): Promise<IndexStatusReport>

  /**
   * Bring the derived index up to date with the workspace tree (or rebuild it).
   * Concurrent calls fold into the single in-flight pass; refresh summaries are emitted only
   * after that pass commits, never speculatively.
   * @param options - trigger reason, forced full rebuild, or explicit path subset.
   * @returns what changed and the epoch pair after the final commit.
   */
  abstract refresh(options?: RefreshOptions): Promise<RefreshSummary>

  /**
   * Run deterministic hybrid retrieval over the indexed chunks.
   * @param request - query plus optional scope, recency, prefix filter, and requested size.
   * @param signal - cancellation for the active step.
   * @returns ranked hits with epoch pairing; `degraded=true` when a lane failed partially.
   */
  abstract search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult>

  /**
   * Answer one structured graph question over the derived call graph.
   * @param request - the `relations` / `impact` / `tests` / `cycles` / `dead_code` question
   *   with its per-op options.
   * @param signal - cancellation for the active step.
   * @returns nodes, edges, optional test pairs, cycle components, or dead-code candidates,
   *   plus the explain envelope under the epoch pair they were read at; every rendered
   *   edge's endpoints resolve inside the answer's `nodes`.
   */
  abstract exploreGraph(request: GraphExploreRequest, signal?: AbortSignal): Promise<GraphExploreResult>
}

export default CodeIndex
