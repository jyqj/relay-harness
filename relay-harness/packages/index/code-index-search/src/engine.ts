/**
 * Retrieval-domain search engine: preselect → lanes → RRF fusion → rerank →
 * hits. Pure logic over a {@link RetrievalPort}; the engine never touches fs,
 * SQL, or clocks (`epochs` are injected by the caller).
 *
 * Pipeline order mirrors the reference implementation
 * (`crates/cc-search/src/engine.rs::search_internal`): plan build runs the
 * preselect fold, lanes execute serially in registry order (= deterministic
 * fusion order), fused candidates are windowed to the rerank window,
 * batch-fetched through the port, reranked, finalized deterministically, and
 * cut to the tier-normalized top-K under this tier's output-character budget.
 *
 * @module @relay-harness/rlh-code-index-search/engine
 */

import {
  repoSizeTierFromFileCount,
  repoSizeTierMaxOutputChars,
  type EpochPair,
  type RepoSizeTier,
  type SearchHit,
  type SearchResult,
} from '@relay-harness/rlh-code-index'
import {
  resolveFeatureGates,
  resolveRankingConfig,
  resolveSearchConfig,
} from './config.ts'
import { SearchEngineError, SEARCH_PORT_READ_FAILED, SEARCH_REQUEST_INVALID } from './errors.ts'
import { compareFusedEntries, fuseOutcomes } from './fusion.ts'
import { createGrepLane } from './lanes.grep.ts'
import { createLexicalLane } from './lanes.lexical.ts'
import { createLiteralLane } from './lanes.literal.ts'
import { SearchPlan } from './plan.ts'
import type { ChunkDetailRow, RetrievalPort } from './port.ts'
import { defaultPreselectLayers } from './preselect.layers.ts'
import { assembleRetrievalRegistry, type RetrievalRegistry } from './registry.ts'
import { dedupeReasons, rerankCandidate } from './rerank.ts'
import type {
  EngineSearchRequest,
  FeatureGates,
  LaneContext,
  LaneOutcome,
  LaneRankedHit,
  PreselectLayer,
  RankingConfig,
  ReadErrorCollector,
  RetrievalLane,
  SearchConfig,
} from './types.ts'

/** Engine construction options; every knob except the port defaults verbatim. */
export interface SearchEngineOptions {
  readonly port: RetrievalPort
  /** Partial override merged over {@link DEFAULT_SEARCH_CONFIG}. */
  readonly cfg?: Partial<SearchConfig>
  /** Partial override merged over {@link DEFAULT_RANKING_CONFIG}. */
  readonly ranking?: Partial<RankingConfig>
  /** Partial override merged over {@link DEFAULT_FEATURE_GATES}. */
  readonly gates?: Partial<FeatureGates>
  /** Lane registry in fusion order; defaults to lexical + grep (`defaultRetrievalLanes`). */
  readonly lanes?: readonly RetrievalLane[]
  /**
   * Preselect layer registry in execution order; defaults to the built-in
   * layers (`defaultPreselectLayersForEngine`). The validated list is what the
   * plan's preselect fold runs, so composition and execution cannot disagree.
   */
  readonly layers?: readonly PreselectLayer[]
  /**
   * Caller-injected epoch reader. The engine never reads the store itself;
   * whatever pair this returns lands verbatim on `SearchResult.epochs`.
   * Returning `undefined` (or omitting the hook) yields zeroed epochs.
   */
  readonly resolveEpochs?: () => EpochPair | undefined
  /**
   * Output-character budget applied to the serialized hit list. Defaults to
   * `repoSizeTierMaxOutputChars(tier)` — the reference envelope cap. Adapters
   * that render chunk snippets above this engine may tighten it; nothing may
   * raise it beyond the tier constant without owning a new tier table.
   */
  readonly outputBudgetChars?: (tier: RepoSizeTier) => number
}

/** Per-hit carry between rerank and finalization; `rank` is assigned last. */
interface RankedInterim {
  chunkId: string
  filePath: string
  startLine: number
  endLine: number
  breadcrumb: string | undefined
  symbolName: string | undefined
  symbolKind: string | undefined
  score: number
  reasons: readonly string[]
  parserTier: 'generic'
  parserConfidence: number
}

/** Project an interim onto the seam `SearchHit`, assigning its 1-based rank. */
function toSearchHit(interim: RankedInterim, rank: number): SearchHit {
  return {
    chunkId: interim.chunkId,
    filePath: interim.filePath,
    startLine: interim.startLine,
    endLine: interim.endLine,
    ...(interim.breadcrumb === undefined ? {} : { breadcrumb: interim.breadcrumb }),
    ...(interim.symbolName === undefined ? {} : { symbolName: interim.symbolName }),
    score: interim.score,
    reasons: interim.reasons,
    parserTier: interim.parserTier,
    parserConfidence: interim.parserConfidence,
    rank,
  }
}

function defaultReadErrors(): ReadErrorCollector & { entries(): string[] } {
  const entries: string[] = []
  return {
    push(message: string): void {
      entries.push(message)
    },
    entries(): string[] {
      return entries
    },
  }
}

/**
 * Build a search engine bound to one {@link RetrievalPort}. Registry problems
 * fail here (never mid-search); see `assembleRetrievalRegistry`.
 * @param options - port, optional config/ranking/gates overrides, lane and
 * layer sets, output budget, and epoch resolver.
 * @returns the bound `search` function plus its validated {@link RetrievalRegistry}.
 */
export function createSearchEngine(options: SearchEngineOptions): {
  search: (request: EngineSearchRequest) => SearchResult
  registry: RetrievalRegistry
} {
  if (typeof options.port.countFiles !== 'function') {
    throw new SearchEngineError('search engine requires a RetrievalPort with countFiles()', SEARCH_REQUEST_INVALID)
  }
  const config = resolveSearchConfig(options.cfg)
  const ranking = resolveRankingConfig(options.ranking)
  const gates = resolveFeatureGates(options.gates)
  const registry = assembleRetrievalRegistry(
    options.lanes ?? defaultRetrievalLanes(),
    options.layers ?? defaultPreselectLayersForEngine(),
  )

  function search(request: EngineSearchRequest): SearchResult {
    if (typeof request.query !== 'string') {
      throw new SearchEngineError('search request requires a string query', SEARCH_REQUEST_INVALID)
    }

    let fileCount: number
    try {
      fileCount = options.port.countFiles()
    } catch (error) {
      throw new SearchEngineError(`countFiles() failed: ${String(error)}`, SEARCH_PORT_READ_FAILED)
    }
    const tier: RepoSizeTier = repoSizeTierFromFileCount(fileCount)

    // Plan build runs the preselect fold against the port, over the validated
    // layer registry so custom layer sets actually execute.
    const plan = SearchPlan.build({
      port: options.port,
      request,
      searchConfig: config,
      ranking,
      tier,
      layers: registry.layers,
    })
    const readErrors = defaultReadErrors()
    // The context is per-search and its `priorCandidates` slot is rewritten
    // before each lane runs, so the loop needs the writable projection.
    const context: { -readonly [K in keyof LaneContext]: LaneContext[K] } = {
      port: options.port,
      plan,
      config,
      ranking,
      gates,
      readErrors,
    }

    // Lanes run serially in registry order — the deterministic fusion order.
    // Candidate ids already ranked by earlier lanes accumulate alongside, so a
    // later ranking-only lane (the vector lane) re-scores the pool instead of
    // issuing its own candidate query.
    const priorChunkIds: string[] = []
    const seenPrior = new Set<string>()
    const outcomes: LaneOutcome[] = []
    for (const lane of registry.lanes) {
      context.priorCandidates = priorChunkIds.length === 0
        ? undefined
        : Object.freeze(priorChunkIds.slice(0, config.vectorMaxCandidates))
      if (!lane.isEnabled(context)) {
        continue
      }
      let hits: readonly LaneRankedHit[]
      try {
        hits = lane.run(context)
      } catch (error) {
        readErrors.push(`${lane.laneId} lane failed (${String(error)}); contributed nothing`)
        hits = []
      }
      for (const hit of hits) {
        if (!seenPrior.has(hit.chunkId)) {
          seenPrior.add(hit.chunkId)
          priorChunkIds.push(hit.chunkId)
        }
      }
      outcomes.push({
        laneId: lane.laneId,
        weight: lane.weight(config),
        annotatesHits: lane.annotatesHits(),
        scoreSlot: lane.scoreSlot(),
        hits,
      })
    }

    // RRF fusion across outcomes, each candidate keeping its per-lane bill.
    const fused = fuseOutcomes(outcomes, config.rrfK)
    const candidateCount = fused.size

    // Deterministic windowing: total desc, chunkId asc lexicographic.
    const candidates = [...fused.entries()]
      .sort(compareFusedEntries)
      .slice(0, plan.limits().rerankWindow)

    // Batch-fetch surviving candidates in one port call.
    let detailRows: readonly ChunkDetailRow[] = []
    if (candidates.length > 0) {
      try {
        detailRows = options.port.chunkRowsByIds(candidates.map(([chunkId]) => chunkId))
      } catch (error) {
        readErrors.push(`chunk detail fetch failed (${String(error)})`)
      }
    }
    const detailsById = new Map(detailRows.map(row => [row.chunkId, row]))

    const laneRanks = plan.laneRanks(outcomes)
    const boostFiles = new Set(request.boostFilePaths ?? [])
    const recentFiles = new Set(request.recentPaths ?? [])
    const pinnedFiles = new Set(request.pinnedFilePaths ?? [])
    const overlayFiles = new Set(request.overlayFilePaths ?? [])

    const ranked: RankedInterim[] = []
    for (const [chunkId, fusedScore] of candidates) {
      const detail = detailsById.get(chunkId)
      if (detail === undefined) continue
      if (!plan.passesFilters(detail.filePath)) continue
      const { rerankScore, reasons } = rerankCandidate({
        chunkId,
        filePath: detail.filePath,
        breadcrumb: detail.breadcrumb,
        symbolName: detail.symbolName,
        text: detail.text,
        fused: fusedScore,
        queryTokens: plan.queryTokens(),
        laneRanks,
        ranking,
        gates,
        filtersPathPrefix: plan.filters.pathPrefix,
        boostFiles,
        recentFiles,
        pinnedFiles,
        overlayFiles,
        preselectResult: plan.preselectResult,
      })
      ranked.push({
        chunkId,
        filePath: detail.filePath,
        startLine: detail.startLine,
        endLine: detail.endLine,
        breadcrumb: detail.breadcrumb.length > 0 ? detail.breadcrumb : undefined,
        symbolName: detail.symbolName ?? undefined,
        symbolKind: detail.symbolKind ?? undefined,
        score: rerankScore,
        reasons: dedupeReasons(reasons),
        parserTier: 'generic',
        parserConfidence: 0,
      })
    }

    // Finalize: score desc / chunkId asc, cut to top-K, then fit the tier's
    // output-character budget — the engine-side analogue of the reference's
    // envelope truncation.
    const finalized = plan.finalizeResults(ranked)
    const budget = options.outputBudgetChars?.(tier) ?? repoSizeTierMaxOutputChars(tier)
    const hits: SearchHit[] = []
    let usedChars = 0
    for (const [position, interim] of finalized.entries()) {
      const hit = toSearchHit(interim, position + 1)
      const cost = JSON.stringify(hit).length
      if (hits.length > 0 && usedChars + cost > budget) break
      usedChars += cost
      hits.push(hit)
    }

    const degraded = readErrors.entries().length > 0
    const epochs: EpochPair = options.resolveEpochs?.() ?? { indexEpoch: 0, evidenceEpoch: 0 }

    return {
      query: request.query,
      tier,
      hits,
      candidateCount,
      epochs,
      truncated: hits.length < ranked.length,
      degraded,
      readErrors: [...readErrors.entries()],
    }
  }

  return { search, registry }
}

/**
 * Built-in lane set in fusion order: lexical, then grep, then the optional
 * graph lane in its reserved position, then the literal lane, then the
 * optional vector lane last (it re-scores the pool every earlier lane built).
 *
 * The graph lane's concrete implementation lives in
 * `@relay-harness/rlh-code-index-graph` (`createGraphLane`): the graph package
 * depends on this one, so this side cannot import it back without the
 * dependency cycle the workspace graph forbids. Composed assemblies pass it
 * in — the graph package ships `defaultRetrievalLanesWithGraph()` for exactly
 * that — and the registration order lexical → grep → graph → literal → vector
 * stays owned here so fusion order remains deterministic across compositions.
 * The literal lane disables itself on ports without the literal FTS mirror,
 * so adapters predating it keep their pre-literal behavior; the vector lane
 * is constructed by the deployment that runs an embedding tier (it must name
 * the `chunks_vec` model) and disables itself whenever the request carries no
 * query vector.
 * @param graphLane - the graph lane to register before the literal lane, or
 * omitted for the built-in three-lane set.
 * @param vectorLane - the vector lane to register last, or omitted for the
 * four-lane set.
 * @returns the lane list in fusion order.
 */
export function defaultRetrievalLanes(graphLane?: RetrievalLane, vectorLane?: RetrievalLane): RetrievalLane[] {
  const base = graphLane === undefined
    ? [createLexicalLane(), createGrepLane(), createLiteralLane()]
    : [createLexicalLane(), createGrepLane(), graphLane, createLiteralLane()]
  return vectorLane === undefined ? base : [...base, vectorLane]
}

/**
 * Built-in layer set in execution order with the optional graph-neighbor layer
 * appended after fallback (same dependency direction as
 * {@link defaultRetrievalLanes}: the concrete layer is
 * `@relay-harness/rlh-code-index-graph`'s `createGraphNeighborLayer`, composed
 * in via `defaultPreselectLayersWithGraphNeighbor()`).
 * @param graphNeighborLayer - the graph-neighbor layer to append last, or
 * omitted for the built-in seven-layer set.
 * @returns the preselect layer list in execution order.
 */
export function defaultPreselectLayersForEngine(graphNeighborLayer?: PreselectLayer): PreselectLayer[] {
  return graphNeighborLayer === undefined
    ? defaultPreselectLayers()
    : [...defaultPreselectLayers(), graphNeighborLayer]
}
