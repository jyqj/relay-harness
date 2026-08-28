/**
 * Vocabulary types for the retrieval-domain search engine. This module is types-only.
 *
 * The engine mirrors the reference implementation's `cc-search` decomposition:
 * retrieval lanes (`RetrievalLane`) feed RRF fusion, preselect layers
 * (`PreselectLayer`) narrow candidate files before chunk-level search, and a
 * search plan materializes caller semantics into lane limits and rerank inputs.
 *
 * @module @relay-harness/rlh-code-index-search/types
 */

import type { SearchRequest } from '@relay-harness/rlh-code-index'
import type { RetrievalPort } from './port.ts'
import type { SearchPlanView } from './plan.ts'

/** Dedicated per-lane score slot a lane claims when it annotates hits.
 *
 * A *closed* set mirroring the fixed output schema of the reference
 * implementation (`lexical` / `grep` / `graph`) plus the harness-side literal
 * and vector lanes. The current harness hit shape (`SearchHit` from
 * `@relay-harness/rlh-code-index`) carries no per-lane score fields, so slots
 * are declarative metadata in P1: they document which lane owns which future
 * field, and lanes surface through their `{laneId}@{rank}` reason strings.
 */
export type ScoreSlot = 'lexical' | 'grep' | 'graph' | 'literal' | 'vector'

/** One `(chunkId, laneLocalScore)` pair, ranked best-first by a lane. */
export interface LaneRankedHit {
  readonly chunkId: string
  /** Lane-local diagnostic score; only rank position feeds RRF fusion. */
  readonly score: number
}

/** Request extension consumed by the engine beyond the seam vocabulary. */
export interface EngineSearchRequest extends SearchRequest {
  /** Files in the caller's active working set; boosts their preselect and rerank score. */
  readonly boostFilePaths?: readonly string[]
  /** Caller-pinned context files; boosts their preselect and rerank score. */
  readonly pinnedFilePaths?: readonly string[]
  /** Overlay / dirty-buffer neighbor files; boosts their preselect and rerank score. */
  readonly overlayFilePaths?: readonly string[]
  /**
   * Whether the grep lane executes for this request. Defaults to `true`;
   * callers narrow retrieval (for example, path-only lookups) by passing `false`.
   */
  readonly includeGrep?: boolean
  /**
   * Embedding of the query text, produced by the caller's embedding tier.
   * Engine-internal (the seam `SearchRequest` stays untouched): only callers
   * that run an embedding tier supply it, and the vector lane skips itself
   * when absent.
   */
  readonly queryVector?: Float32Array
}

/** Engine knobs carried into every lane context. Defaults are ported verbatim from the reference implementation (`SearchConfig`). */
export interface SearchConfig {
  /** Lexical lane candidate cap before RRF (`search.lexical_top_k`, default 24). */
  readonly lexicalTopK: number
  /** Grep lane candidate cap before RRF (`search.grep_top_k`, default 12). */
  readonly grepTopK: number
  /** Chunk rows the grep lane may decode per search (`search.grep_scan_cap`, default 20000). */
  readonly grepScanCap: number
  /** RRF normalization constant k (`search.rrf_k`, default 50). */
  readonly rrfK: number
  /** Lexical lane RRF weight (`search.lexical_weight`, default 1.1). */
  readonly lexicalWeight: number
  /** Grep lane RRF weight (`search.grep_weight`, default 0.8). */
  readonly grepWeight: number
  /** Graph lane RRF weight (`search.graph_weight`, default 0.6); `0` disables the lane. */
  readonly graphWeight: number
  /** Graph lane candidate cap before RRF (`search.graph_top_k`, default 12). */
  readonly graphTopK: number
  /** Literal lane candidate cap before RRF (`search.literal_top_k`, default 12). */
  readonly literalTopK: number
  /** Literal lane RRF weight (`search.literal_weight`, default 0.9). */
  readonly literalWeight: number
  /** Vector lane RRF weight (`search.vector_weight`, default 0.9). */
  readonly vectorWeight: number
  /** Vector lane candidate cap before RRF (`search.vector_top_k`, default 12). */
  readonly vectorTopK: number
  /**
   * Candidate-pool ceiling the engine hands the vector lane through
   * `LaneContext.priorCandidates` (`search.vector_max_candidates`, default
   * 2000): the cosine pass is O(pool) decodes, so the pool is capped
   * independently of the rerank window.
   */
  readonly vectorMaxCandidates: number
  /** Candidates considered after fusion (`search.rerank_window`, default 40). */
  readonly rerankWindow: number
}

/** Scoring constants for rerank bonuses and every preselect layer; defaults
 * ported verbatim from the reference implementation's `RankingConfig`. */
export interface RankingConfig {
  // ── Chunk rerank (plan.rs::hit_from_chunk addition order) ──
  /** Weight of the graph connectivity score applied by the enrich stage (`ranking.graph_rerank_weight`, default 0.3; `0` disables it). */
  readonly graphRerankWeight: number
  /** Weight of query-token overlap added to the fused score (default 0.35). */
  readonly overlapWeight: number
  /** Bonus when a query token exactly matches the chunk's symbol name (default 0.18); gated by `FeatureGates.symbolExactEnabled`. */
  readonly symbolExactBonus: number
  /** Bonus when the file path starts with the requested prefix (default 0.05). */
  readonly pathPrefixBonus: number
  /** Bonus for project documentation files (default 0.08). */
  readonly docFileBonus: number
  /** Bonus for working-set files (default 0.22). */
  readonly workingSetBoost: number
  /** Bonus for recently-edited files (default 0.12). */
  readonly recentFileBoost: number
  /** Bonus for pinned context files (default 0.20). */
  readonly pinnedContextBoost: number
  /** Bonus for overlay neighbor files (default 0.10). */
  readonly overlayNeighborBoost: number
  /** Multiplier mapping the preselect file score into rerank (default 0.04). */
  readonly stageAWeight: number
  /** Cap on the preselect file-score contribution (default 0.25). */
  readonly stageACap: number
  /** Bonus for candidates whose symbol name contains the `name:` DSL filter (default 0.25). */
  readonly dslNameBonus: number

  // ── File preselection layers ──
  /** Working-set layer floor (default 2.0); score is `max(floor, scale / rank)`. */
  readonly preselectWorkingSetFloor: number
  /** Working-set layer scale (default 5.0). */
  readonly preselectWorkingSetScale: number
  /** Recent-files layer floor (default 1.2). */
  readonly preselectRecentFloor: number
  /** Recent-files layer scale (default 3.5). */
  readonly preselectRecentScale: number
  /** Pinned layer floor (default 2.2). */
  readonly preselectPinnedFloor: number
  /** Pinned layer scale (default 4.0). */
  readonly preselectPinnedScale: number
  /** Overlay layer floor (default 1.5). */
  readonly preselectOverlayFloor: number
  /** Overlay layer scale (default 3.0). */
  readonly preselectOverlayScale: number
  /** FTS summary layer base (default 1.4); score is `base + 1/(1+|bm25|)`. */
  readonly preselectFtsBase: number
  /** Per-token symbol exact-name bonus (default 2.0). */
  readonly preselectSymbolExactBonus: number
  /** Per-token symbol substring bonus (default 1.2). */
  readonly preselectSymbolFuzzyBonus: number
  /** Per-token path-component bonus (default 1.0). */
  readonly preselectPathTokenBonus: number
  /** Fallback layer score for recently-indexed files (default 0.2). */
  readonly preselectFallbackScore: number
  /** Score assigned to explicit file scopes via short circuit (default 10.0). */
  readonly preselectExplicitScopeScore: number

  // ── Graph-neighbor preselect layer ──
  /** First-seen score for a 1-hop call-graph neighbor file (default 0.8); clamped to `graphNeighborCap`. */
  readonly graphNeighborBase: number
  /** Score increment per additional call-edge sighting of the same neighbor file (default 0.1). */
  readonly graphNeighborPerEdge: number
  /** Accumulation ceiling for a neighbor file's layer score (default 1.2). */
  readonly graphNeighborCap: number
}

/** Whether an explicitly gated behavior is on. Carries the implementation
 * position of behaviors whose data does not exist yet (see each gate). */
export interface FeatureGates {
  /**
   * `symbol-exact` rerank bonus (+`ranking.symbolExactBonus`, reason
   * `symbol-exact`). ON by default: candidate detail rows carry a symbol
   * name, so the comparison acts on real data. The gate stays as the explicit
   * off switch for adapters that index without symbol names.
   */
  readonly symbolExactEnabled: boolean
}

/**
 * Shared outlet for recoverable store failures observed mid-search. Pushed
 * entries surface verbatim on `SearchResult.readErrors` and flip `degraded`.
 */
export interface ReadErrorCollector {
  /** Record one recovered failure message. */
  push(message: string): void
}

/** Per-search context handed to every retrieval lane. Deliberately narrow: plan + port + config, nothing else of the engine. */
export interface LaneContext {
  readonly port: RetrievalPort
  readonly plan: SearchPlanView
  readonly config: SearchConfig
  readonly ranking: RankingConfig
  readonly gates: FeatureGates
  readonly readErrors: ReadErrorCollector
  /**
   * Chunk ids the engine's earlier lanes ranked this search, in registration
   * order and deduplicated, capped at `search.vector_max_candidates`.
   * `undefined` before the first lane ran. Ranking-only lanes (the vector
   * lane) re-score this pool instead of issuing their own candidate queries;
   * candidate lanes ignore it.
   */
  readonly priorCandidates?: readonly string[] | undefined
}

/** A retrieval lane: one ranked candidate source feeding RRF fusion.
 *
 * Contract (mirrors the reference `RetrievalLane`):
 * - `run` returns hits ranked **best-first**; only rank position feeds RRF —
 *   the score is lane-local and purely diagnostic.
 * - `isEnabled` must be cheap; when false the lane is skipped before any work.
 * - Throwing aborts the lane's contribution and degrades the result into
 *   `readErrors` (`degraded=true`); recoverable sub-steps should be swallowed
 *   inside `run` exactly like the reference graph/prefilter fallbacks.
 */
export interface RetrievalLane {
  /** Stable lane identifier used to key rank maps, reasons, and stats. */
  readonly laneId: string
  /** RRF weight for this lane. */
  readonly weight: (config: SearchConfig) => number
  /** Whether the lane should execute for this search. */
  readonly isEnabled: (context: LaneContext) => boolean
  /** Whether every hit the lane ranked carries a `{laneId}@{rank}` reason. */
  readonly annotatesHits: () => boolean
  /** Dedicated output-schema score field the lane claims, if any. */
  readonly scoreSlot: () => ScoreSlot | null
  /** Execute retrieval and return the lane's ranked hits. */
  readonly run: (context: LaneContext) => readonly LaneRankedHit[]
}

/** One file scored by one preselect layer. */
export interface LayerHit {
  readonly filePath: string
  readonly score: number
  /** Human-readable provenance token (e.g. `symbol:getUserById`). */
  readonly reason: string
}

/** Per-call context handed to every preselect layer. */
export interface PreselectContext {
  readonly port: RetrievalPort
  readonly query: string
  readonly pathPrefix: string | null
  /** Overall preselect budget (files). */
  readonly limit: number
  readonly ranking: RankingConfig
  readonly boostFilePaths: readonly string[] | null
  readonly recentFilePaths: readonly string[] | null
  readonly pinnedFilePaths: readonly string[] | null
  readonly overlayFilePaths: readonly string[] | null
  /** Scores accumulated by earlier layers, read-only; merging is the driver's job. */
  readonly currentScores: ReadonlyMap<string, number>
}

/** A preselect scoring layer: one candidate-file source merged additively into the shared score map.
 *
 * Emitting the same file twice adds up (the token layer relies on this).
 * Layers that must not re-score existing candidates filter against
 * {@link PreselectContext.currentScores} themselves.
 */
export interface PreselectLayer {
  /** Stable layer identifier used in reasons, the per-layer bill, and stats. */
  readonly name: string
  /** Whether `score` reads {@link PreselectContext.currentScores}. */
  readonly readsPriorScores: () => boolean
  /** Score candidate files for this layer. */
  readonly score: (ctx: PreselectContext) => readonly LayerHit[]
}

/** Statistics about which scoring layers fired during preselection. */
export interface LaneStats {
  readonly ftsHits: number
  readonly tokenHits: number
  readonly usedFallback: boolean
}

/** Result of file preselection: ordered files + per-file scores/reasons/bills. */
export interface PreselectResult {
  /** Ordered file paths, best first. */
  readonly files: readonly string[]
  readonly scores: ReadonlyMap<string, number>
  readonly reasons: ReadonlyMap<string, readonly string[]>
  readonly laneStats: LaneStats
  /** Per-file score bill `file -> [(layer name, layer total)]`; each list sums to `scores[file]`. */
  readonly layerScores: ReadonlyMap<string, readonly (readonly [string, number])[]>
}

/** Outcome of executing one lane: identity plus its ranked hits, ready for fusion. */
export interface LaneOutcome {
  readonly laneId: string
  readonly weight: number
  readonly annotatesHits: boolean
  readonly scoreSlot: ScoreSlot | null
  readonly hits: readonly LaneRankedHit[]
}

/** Fused contribution breakdown recorded per candidate in accumulation order. */
export interface LaneContribution {
  readonly laneId: string
  readonly score: number
}

/** One candidate's RRF fusion result. Summing `byLane` left-to-right reproduces `total` bit-for-bit. */
export interface FusedScore {
  total: number
  readonly byLane: LaneContribution[]
}
