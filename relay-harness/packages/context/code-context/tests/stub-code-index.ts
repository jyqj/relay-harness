/**
 * Scripted `ctx.codeIndex` provider for the code-context specs: the unit
 * harness registers it directly, and the real-composition spec maps it behind
 * the provider entry name so the Loader boots the seam without SQLite.
 */

import CodeIndex from '@relay-harness/rlh-code-index'
import type {
  GraphExploreRequest,
  GraphExploreResult,
  IndexStatusReport,
  RefreshOptions,
  RefreshSummary,
  SearchHit,
  SearchRequest,
  SearchResult,
} from '@relay-harness/rlh-code-index'

/** Mutable scripted answer slot; each case points this at its fixture. */
export const scripted: { search?: SearchResult | Error | undefined; throwValue?: unknown } = {}

/** Every search request the stub received, in call order. */
export const searchRequests: SearchRequest[] = []

/** Reset the scripted slot and the recorded requests. */
export function resetStub(): void {
  scripted.search = undefined
  scripted.throwValue = undefined
  searchRequests.length = 0
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
    startLine: 1,
    endLine: 3,
    score: 42,
    rank: index,
    reasons: ['lexical:fts'],
    parserTier: 'tree-sitter',
    parserConfidence: 0.9,
    ...overrides,
  }
}

/** Stand-in provider implementing the `codeIndex` seam over the scripted slot. */
export default class StubCodeIndex extends CodeIndex {
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

  exploreGraph(_request: GraphExploreRequest): Promise<GraphExploreResult> {
    return Promise.reject(new Error('stub: exploreGraph is not scripted'))
  }
}

export { StubCodeIndex }
