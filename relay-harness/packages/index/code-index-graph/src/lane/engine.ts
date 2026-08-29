/**
 * Graph-aware search path — `searchWithGraphContext`: core search, connectivity
 * rerank from graph enrichment, and the epoch-pair-keyed graph result cache.
 *
 * Ported from the reference implementation
 * (`crates/cc-search/src/engine_graph.rs::search_with_graph_context`). The
 * enrichment itself lives in `enrich.ts`; this module owns how the engine
 * drives it and caches the final pair.
 *
 * INVARIANT: this is the only place the graph contribution is applied — hit
 * scores and order are final on return, and exactly one final sort runs after
 * the boost. Degraded results (the merged base-plus-enrichment `readErrors`
 * non-empty) are returned but never cached, so a transient store failure is
 * retried on the next call instead of being pinned to the epoch pair.
 *
 * @module @relay-harness/rlh-code-index-graph/lane/engine
 */

import {
  repoSizeTierSearchTopK,
  type EpochPair,
  type GraphEnrichLimits,
  type SearchHit,
  type SearchResult,
} from '@relay-harness/rlh-code-index'
import {
  compareStrings,
  fingerprintVector,
  resolveRankingConfig,
} from '@relay-harness/rlh-code-index-search'
import type {
  EngineSearchRequest,
  RankingConfig,
  RetrievalPort,
} from '@relay-harness/rlh-code-index-search'
import { graphEnrich } from './enrich.ts'
import type { GraphEnrichNodeView } from './enrich.ts'
import type { GraphExplain } from './explain.ts'

/** Reason token appended to every hit the graph boost moved. */
export const GRAPH_RERANK_REASON = 'boost:graph-rerank'

/**
 * Default LRU capacity of the graph result cache, ported verbatim from the
 * reference's `GRAPH_RESULT_CACHE_CAPACITY` (32; entries are heavier than
 * plain search results because they carry the enrichment context nodes).
 */
export const DEFAULT_GRAPH_RESULT_CACHE_CAPACITY = 32

/** Enrichment outputs that ride beside the search result, without score state. */
export interface GraphEnrichment {
  /** Neighbor and test context nodes in collection order. */
  readonly nodes: readonly GraphEnrichNodeView[]
  /** Distinct hit symbols resolved to uids. */
  readonly symbolsResolved: number
  /** Caller nodes collected. */
  readonly callersAdded: number
  /** Callee nodes collected. */
  readonly calleesAdded: number
  /** Test nodes collected. */
  readonly testsFound: number
  /** Degradation envelope; `isEmpty` when the run completed cleanly. */
  readonly explain: GraphExplain
}

/** One graph-aware search outcome: the finalized result plus its enrichment. */
export interface GraphSearchOutcome {
  /** Final search result; hits carry `graphScore` and the applied boost. */
  readonly result: SearchResult
  /** The enrichment that produced the graph contribution. */
  readonly enrichment: GraphEnrichment
}

/** LRU store of graph search outcomes keyed by the full cache key. */
export interface GraphResultCache {
  /** @param key - cache key; @returns the cached outcome, or `undefined` on miss. */
  get(key: string): GraphSearchOutcome | undefined
  /** @param key - cache key. @param value - outcome to store, evicting the least-recent entry past capacity. */
  set(key: string, value: GraphSearchOutcome): void
  /** Current entry count. */
  readonly size: number
}

/**
 * Create the graph result cache.
 * @param capacity - maximum entries; the least-recently used entry evicts first
 *   (defaults to {@link DEFAULT_GRAPH_RESULT_CACHE_CAPACITY}).
 * @returns the LRU cache.
 */
export function createGraphResultCache(capacity: number = DEFAULT_GRAPH_RESULT_CACHE_CAPACITY): GraphResultCache {
  const entries = new Map<string, GraphSearchOutcome>()
  return {
    get(key: string): GraphSearchOutcome | undefined {
      const value = entries.get(key)
      if (value !== undefined) {
        // Re-insert to mark the entry most recently used.
        entries.delete(key)
        entries.set(key, value)
      }
      return value
    },
    set(key: string, value: GraphSearchOutcome): void {
      entries.delete(key)
      entries.set(key, value)
      // The map is non-empty under this condition, so the first key exists.
      while (entries.size > capacity) {
        entries.delete(entries.keys().next().value as string)
      }
    },
    get size(): number {
      return entries.size
    },
  }
}

/** Deterministic JSON with recursively sorted object keys, for stable cache keys. */
function stableSerialize(value: unknown): string {
  if (value === undefined) return 'null'
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(entry => stableSerialize(entry)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => compareStrings(left, right))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`).join(',')}}`
}

/** Order-insensitive list copy — list order must not split the cache (the reference hashes lists unordered). */
function sortedCopy(paths: readonly string[] | undefined): readonly string[] | undefined {
  return paths === undefined ? undefined : [...paths].sort(compareStrings)
}

/**
 * Build the cache key: both epochs, the request hash, every enrichment limit,
 * the token budget, and the ranking fingerprint. A request's query vector
 * enters as its `fingerprintVector` short digest — the vector lane's
 * contribution is content, not text, so two calls sharing a query string but
 * not the embedding must not share an entry, while byte-equal vectors must.
 * The engine's own search config is intentionally absent — a cache instance
 * belongs to one bound engine, so those knobs cannot vary within a cache.
 * @param input - the graph search input.
 * @param ranking - resolved ranking whose stable serialization fingerprints the boost weight.
 * @returns the deterministic cache key.
 */
function graphCacheKey(input: SearchWithGraphContextInput, ranking: RankingConfig): string {
  const request = input.request
  return stableSerialize({
    epochs: input.epochs,
    request: {
      query: request.query,
      topK: request.topK,
      pathPrefix: request.pathPrefix,
      paths: sortedCopy(request.paths),
      recentPaths: sortedCopy(request.recentPaths),
      boostFilePaths: sortedCopy(request.boostFilePaths),
      pinnedFilePaths: sortedCopy(request.pinnedFilePaths),
      overlayFilePaths: sortedCopy(request.overlayFilePaths),
      // Conversation order is semantic: newest-first selection depends on it.
      conversationQueries: request.conversationQueries,
      includeGrep: request.includeGrep,
      queryVectorFingerprint: request.queryVector === undefined ? null : fingerprintVector(request.queryVector),
    },
    limits: {
      maxResolve: input.limits.maxResolve,
      callersPerSym: input.limits.callersPerSym,
      calleesPerSym: input.limits.calleesPerSym,
      maxTests: input.limits.maxTests,
      maxRoutes: input.limits.maxRoutes,
      graphBudgetPct: input.limits.graphBudgetPct,
    },
    tokenBudget: input.tokenBudget,
    ranking,
  })
}

/** Everything the graph-aware path needs: the bound engine, the port it reads, and the enrichment knobs. */
export interface SearchWithGraphContextInput {
  /** Bound search engine whose `search` produces the base result. */
  readonly engine: { readonly search: (request: EngineSearchRequest) => SearchResult }
  /** Retrieval port whose graph facet answers the enrichment reads. */
  readonly port: RetrievalPort
  /** Caller request, passed to the engine verbatim. */
  readonly request: EngineSearchRequest
  /** Epoch pair observed at answer time; keys the cache alongside the request. */
  readonly epochs: EpochPair
  /** Tier enrichment caps. */
  readonly limits: Readonly<GraphEnrichLimits>
  /** Operation token budget the graph section claims its percentage of. */
  readonly tokenBudget: number
  /** Partial ranking override; defaults verbatim so the boost weight matches the engine's table. */
  readonly ranking?: Partial<RankingConfig>
  /** Result cache; omit to run uncached. */
  readonly cache?: GraphResultCache
}

/**
 * Search with graph-aware reranking, for context assembly.
 *
 * Runs the base search, computes the connectivity graph score for the top
 * `limits.maxResolve` hits, folds it into each hit's score via
 * `ranking.graphRerankWeight` (appending the {@link GRAPH_RERANK_REASON}
 * token), then performs the single final sort (score desc, chunkId asc) and
 * truncates to the request's top-K (`undefined` → tier default, `0` → 10).
 * Re-ranked hits get their `rank` reassigned to the final order.
 *
 * Results are cached under the epoch pair + request hash + limits + token
 * budget + ranking fingerprint, so a bump of either epoch simply misses.
 * Degraded results (the merged base-plus-enrichment `readErrors` non-empty)
 * are never cached.
 * @param input - engine, port, request, epochs, enrichment knobs, and optional cache.
 * @returns the finalized result plus the enrichment's nodes and counters.
 */
export function searchWithGraphContext(input: SearchWithGraphContextInput): GraphSearchOutcome {
  const ranking = resolveRankingConfig(input.ranking)
  const cacheKey = graphCacheKey(input, ranking)
  const cached = input.cache?.get(cacheKey)
  if (cached !== undefined) return cached

  const base = input.engine.search(input.request)
  const enrichment = graphEnrich({
    hits: base.hits,
    port: input.port,
    limits: input.limits,
    tokenBudget: input.tokenBudget,
  })

  const weight = ranking.graphRerankWeight
  const boosted = base.hits.map((hit): SearchHit => {
    const graphScore = enrichment.assignments.get(hit.chunkId)
    if (graphScore === undefined) return hit
    const boost = graphScore * weight
    return {
      ...hit,
      graphScore,
      ...(boost === 0 ? {} : {
        score: hit.score + boost,
        scoreTrace: [...hit.scoreTrace, { label: GRAPH_RERANK_REASON, value: boost }],
        reasons: [...hit.reasons, GRAPH_RERANK_REASON],
      }),
    }
  })

  // Single final sort + truncation: hit scores are immutable after this.
  const topK = input.request.topK === undefined
    ? repoSizeTierSearchTopK(base.tier)
    : input.request.topK > 0
      ? input.request.topK
      : 10
  const hits = boosted
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : compareStrings(a.chunkId, b.chunkId)))
    .slice(0, topK)
    .map((hit, index) => hit.rank === index + 1 ? hit : { ...hit, rank: index + 1 })

  const readErrors = [...base.readErrors, ...enrichment.explain.readErrors]
  const result: SearchResult = {
    query: base.query,
    tier: base.tier,
    hits,
    candidateCount: base.candidateCount,
    epochs: input.epochs,
    truncated: base.truncated,
    degraded: readErrors.length > 0,
    readErrors,
  }
  const outcome: GraphSearchOutcome = {
    result,
    enrichment: {
      nodes: enrichment.nodes,
      symbolsResolved: enrichment.symbolsResolved,
      callersAdded: enrichment.callersAdded,
      calleesAdded: enrichment.calleesAdded,
      testsFound: enrichment.testsFound,
      explain: enrichment.explain,
    },
  }
  // Degraded-not-cached: a transient read failure — enrichment-side or in the
  // base engine's lanes — produced a partial answer. Serve it for THIS call,
  // but let the next call retry the reads instead of pinning the epoch pair.
  if (readErrors.length === 0) {
    input.cache?.set(cacheKey, outcome)
  }
  return outcome
}
