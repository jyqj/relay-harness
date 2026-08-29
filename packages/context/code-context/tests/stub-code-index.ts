/**
 * Scripted `ctx.codeIndex` provider for the code-context specs: the unit
 * harness registers it directly, and the real-composition spec maps it behind
 * the provider entry name so the Loader boots the seam without SQLite.
 */

import CodeIndex from '@relay-harness/rlh-code-index'
import type {
  GraphExploreRequest,
  GraphExploreResult,
  HydrateChunksRequest,
  HydrateChunksResult,
  IndexStatusReport,
  RefreshOptions,
  RefreshSummary,
  SearchHit,
  SearchRequest,
  SearchResult,
} from '@relay-harness/rlh-code-index'

/** Mutable scripted answer slot; each case points this at its fixture. */
export const scripted: {
  search?: SearchResult | Error | undefined
  hydrate?: HydrateChunksResult | Error | undefined
  throwValue?: unknown
} = {}

/** Every search request the stub received, in call order. */
export const searchRequests: SearchRequest[] = []
/** Every hydration request the stub received, in call order. */
export const hydrateRequests: HydrateChunksRequest[] = []
/** Every caller-selected workspace root, in bind order. */
export const workspaceRequests: string[] = []

/** Reset the scripted slot and the recorded requests. */
export function resetStub(): void {
  scripted.search = undefined
  scripted.hydrate = undefined
  scripted.throwValue = undefined
  searchRequests.length = 0
  hydrateRequests.length = 0
  workspaceRequests.length = 0
}

/**
 * Build a complete healthy {@link SearchResult} over the given hits.
 * @param hits - the ranked hits the answer carries.
 * @param overrides - field-level replacements for the answer defaults.
 * @returns the complete search answer.
 */
export function searchResult(
  hits: SearchHit[],
  overrides: Partial<SearchResult> = {},
): SearchResult {
  return {
    query: 'q',
    tier: 'tiny',
    hits,
    candidateCount: hits.length,
    epochs: { indexEpoch: 7, evidenceEpoch: 0 },
    truncated: false,
    degraded: false,
    readErrors: [],
    ...overrides,
  }
}

/**
 * Build one ranked {@link SearchHit}.
 * @param overrides - field-level replacements for the hit defaults.
 * @returns the complete hit.
 */
export function searchHit(overrides: Partial<SearchHit> = {}): SearchHit {
  const index = overrides.rank ?? 1
  return {
    chunkId: `chunk:src/file.ts:${index}`,
    filePath: 'src/file.ts',
    language: 'typescript',
    contentHash: 'file-hash-v1',
    startLine: 1,
    endLine: 3,
    score: 42,
    rank: index,
    reasons: ['lexical:fts'],
    scoreTrace: [{ label: 'rrf:lexical', value: 42 }],
    parserTier: 'tree-sitter',
    parserConfidence: 0.9,
    ...overrides,
  }
}

/** Stand-in provider implementing the `codeIndex` seam over the scripted slot. */
export default class StubCodeIndex extends CodeIndex {
  override forWorkspace(workspaceRoot: string) {
    workspaceRequests.push(workspaceRoot)
    return Promise.resolve({
      workspaceRoot,
      status: () => this.status(),
      managementStatus: () => this.managementStatus(),
      reconcile: () => this.reconcile(),
      refresh: (options?: RefreshOptions) => this.refresh(options),
      search: (request: SearchRequest, _signal?: AbortSignal) => this.search(request),
      hydrateChunks: (request: HydrateChunksRequest, _signal?: AbortSignal) => this.hydrateChunks(request),
      exploreGraph: (request: GraphExploreRequest, _signal?: AbortSignal) => this.exploreGraph(request),
    })
  }
  status(): Promise<IndexStatusReport> {
    return Promise.reject(new Error('stub: status is not scripted'))
  }

  refresh(_options?: RefreshOptions): Promise<RefreshSummary> {
    return Promise.reject(new Error('stub: refresh is not scripted'))
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    searchRequests.push(request)
    if (scripted.throwValue !== undefined) throw scripted.throwValue
    const answer = scripted.search
    if (answer === undefined) throw new Error('stub: no scripted search answer')
    if (answer instanceof Error) throw answer
    return answer
  }

  async hydrateChunks(request: HydrateChunksRequest): Promise<HydrateChunksResult> {
    hydrateRequests.push(request)
    const answer = scripted.hydrate
    if (answer instanceof Error) throw answer
    if (answer !== undefined) return answer
    const search = scripted.search
    if (search === undefined || search instanceof Error) throw new Error('stub: no search answer to hydrate')
    const byId = new Map(search.hits.map(hit => [hit.chunkId, hit]))
    const chunks = request.chunkIds.flatMap((chunkId) => {
      const hit = byId.get(chunkId)
      return hit === undefined ? [] : [{
        chunkId,
        filePath: hit.filePath,
        language: hit.language,
        contentHash: hit.contentHash,
        startLine: hit.startLine,
        endLine: hit.endLine,
        text: `export const ${hit.symbolName ?? 'spoolMarker'} = true`,
        parserTier: hit.parserTier,
        parserConfidence: hit.parserConfidence,
        verification: 'source-verified' as const,
      }]
    })
    const found = new Set(chunks.map(chunk => chunk.chunkId))
    return {
      chunks,
      rejected: request.chunkIds.filter(chunkId => !found.has(chunkId)).map(chunkId => ({
        chunkId,
        state: 'unavailable' as const,
        reason: 'not-indexed' as const,
      })),
      epochs: search.epochs,
    }
  }

  exploreGraph(_request: GraphExploreRequest): Promise<GraphExploreResult> {
    return Promise.reject(new Error('stub: exploreGraph is not scripted'))
  }
}

export { StubCodeIndex }
