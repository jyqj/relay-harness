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
  HydrateChunksRequest,
  HydrateChunksResult,
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
   * Operator-oriented health projection; providers may enrich the basic status.
   * @returns bounded file/chunk/generation/build health for management clients.
   */
  async managementStatus(): Promise<import('./types.ts').CodeIndexManagementStatus> {
    const status = await this.status()
    return { ...status, chunkCount: 0, generations: [] }
  }

  /**
   * Reconcile provider-derived work without requiring a destructive rebuild.
   * @returns settled management status after reconciliation.
   */
  async reconcile(): Promise<import('./types.ts').CodeIndexManagementStatus> {
    await this.refresh({ reason: 'manual' })
    return this.managementStatus()
  }

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
   * Resolve full indexed source bodies for an ordered batch of chunk identities.
   * Providers revalidate each backing source against its indexed content hash;
   * stale or unavailable identities are returned only in `rejected`.
   * @param request - ordered chunk identities to hydrate.
   * @param signal - cancellation checked before and after the synchronous store read.
   * @returns resolved bodies, explicit misses, and the generation observed by the read.
   */
  abstract hydrateChunks(request: HydrateChunksRequest, signal?: AbortSignal): Promise<HydrateChunksResult>

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

  /**
   * Bind this capability to one caller-owned workspace root. Multi-workspace
   * providers override this method and route every operation to an isolated
   * derived store. The default adapter preserves existing single-workspace
   * providers and test doubles; production filesystem providers should
   * override it to verify that `workspaceRoot` is their configured root.
   * @param workspaceRoot - absolute workspace root selected by the caller's durable Session.
   * @returns a workspace-bound operation face which cannot be retargeted after construction.
   */
  forWorkspace(workspaceRoot: string): Promise<CodeIndexWorkspace> {
    return Promise.resolve(bindCodeIndexWorkspace(workspaceRoot, this))
  }
}

/** Workspace-bound Code Index operations used by Agent, Tool, and Remote callers. */
export interface CodeIndexWorkspace {
  /** Canonical workspace root that owns every result and mutation through this face. */
  readonly workspaceRoot: string
  /** @returns current model-facing health for this workspace only. */
  status(): Promise<IndexStatusReport>
  /** @returns bounded operator health for this workspace only. */
  managementStatus(): Promise<import('./types.ts').CodeIndexManagementStatus>
  /** @returns settled status after reconciling this workspace only. */
  reconcile(): Promise<import('./types.ts').CodeIndexManagementStatus>
  /** @param options - workspace-local refresh options. @returns committed workspace-local summary. */
  refresh(options?: RefreshOptions): Promise<RefreshSummary>
  /** @param request - workspace-local retrieval request. @param signal - cancellation. @returns ranked workspace-local hits. */
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult>
  /** @param request - workspace-local chunk ids. @param signal - cancellation. @returns source-verified workspace-local bodies. */
  hydrateChunks(request: HydrateChunksRequest, signal?: AbortSignal): Promise<HydrateChunksResult>
  /** @param request - workspace-local graph question. @param signal - cancellation. @returns workspace-local graph answer. */
  exploreGraph(request: GraphExploreRequest, signal?: AbortSignal): Promise<GraphExploreResult>
}

/**
 * Adapt one legacy/single-workspace provider to the bound face.
 * @param workspaceRoot - identity exposed to the caller.
 * @param provider - fixed provider receiving all operations.
 * @returns immutable delegating face.
 */
export function bindCodeIndexWorkspace(workspaceRoot: string, provider: CodeIndex): CodeIndexWorkspace {
  return Object.freeze({
    workspaceRoot,
    status: () => provider.status(),
    managementStatus: () => provider.managementStatus(),
    reconcile: () => provider.reconcile(),
    refresh: (options?: RefreshOptions) => provider.refresh(options),
    search: (request: SearchRequest, signal?: AbortSignal) => provider.search(request, signal),
    hydrateChunks: (request: HydrateChunksRequest, signal?: AbortSignal) => provider.hydrateChunks(request, signal),
    exploreGraph: (request: GraphExploreRequest, signal?: AbortSignal) => provider.exploreGraph(request, signal),
  })
}

export default CodeIndex
