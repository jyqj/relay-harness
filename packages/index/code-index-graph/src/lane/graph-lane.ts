/**
 * Graph retrieval lane: chunks connected to query-matching symbols through
 * 1-hop call edges (callers + callees), mapped back to their smallest
 * containing chunks.
 *
 * Ported from the reference implementation
 * (`crates/cc-search/src/lanes.rs:567-787`, `GraphLane` +
 * `find_seed_symbol_uids`). Fusion-only by design: the lane feeds RRF through
 * its rank positions but annotates no hits and emits no reason tokens, and
 * the graph chunk scores stay lane-local (`LaneRankedHit.score`) until the
 * enrich stage surfaces them.
 *
 * Constants ported verbatim from the reference `RankingConfig`: seed tokens
 * cap at 5, seeds cap at 20, neighbor decay 0.5, exact seed score 1.0, fuzzy
 * seed score 0.5, and per-direction edge fetches cap at 10 rows per seed. The
 * candidate cut uses `SearchConfig.graphTopK` through the plan's graph limit;
 * the lane weight reads `SearchConfig.graphWeight`.
 *
 * Failure semantics mirror the reference: the seed and chunk-mapping reads
 * throw out of `run`, where the engine's lane guard records the failure into
 * `readErrors` and drops the lane's contribution; the per-direction edge
 * fetches degrade to no expansion instead of failing the lane.
 *
 * @module @relay-harness/rlh-code-index-graph/lane/graph-lane
 */

import { defineRetrievalLane } from '@relay-harness/rlh-code-index-search'
import type {
  ChunkSpanRow,
  LaneContext,
  LaneRankedHit,
  RetrievalLane,
  SymbolRowLite,
} from '@relay-harness/rlh-code-index-search'
import { edgesBySeed, edgesOrEmpty } from './edges.ts'

/** Stable lane id of the graph lane (the reference's `LANE_GRAPH`). */
export const LANE_GRAPH_ID = 'graph'

/** Per-direction edge fetch cap (`symbol_seed_hits` / `symbol_uids_by_exact_names` / edge-row limits). */
const LOOKUP_CAP = 10
/** Query tokens considered for seeding. */
const SEED_TOKENS = 5
/** Seed symbol cap after the score-descending sort. */
const SEED_CAP = 20
/** Case-insensitive exact name match. */
const SEED_EXACT_SCORE = 1.0
/** Substring (non-exact) name match. */
const SEED_FUZZY_SCORE = 0.5
/** 1-hop neighbor score decay applied to the seed's score. */
const NEIGHBOR_DECAY = 0.5

/** Merge `uid -> score` keeping the maximum (`and_modify(max).or_insert`). */
function upsertMax(map: Map<string, number>, uid: string, score: number): void {
  const existing = map.get(uid)
  if (existing === undefined || score > existing) {
    map.set(uid, score)
  }
}

/**
 * Find seed symbols for the query tokens: sub-3-character tokens resolve
 * through exact-name equality on both common casings (a substring match at
 * that length would be pure noise), longer tokens through the substring seed
 * lookup with exact matches scored above partial hits. Scores merge by
 * maximum, and the field is cut to the 20 best seeds.
 * @param context - lane context carrying the port facet and the plan's query tokens.
 * @returns seed `(uid, score)` pairs, best-first.
 */
function findSeedSymbolUids(context: LaneContext): Array<readonly [string, number]> {
  const results = new Map<string, number>()
  for (const token of context.plan.queryTokens().slice(0, SEED_TOKENS)) {
    if (token.length < 3) {
      const capitalized = token.charAt(0).toUpperCase() + token.slice(1)
      for (const row of context.port.graph.symbolUidsByExactNames([token, capitalized], LOOKUP_CAP)) {
        if (row.symbolUid !== null) {
          upsertMax(results, row.symbolUid, SEED_EXACT_SCORE)
        }
      }
      continue
    }
    for (const hit of context.port.graph.symbolSeedHits(token, LOOKUP_CAP)) {
      const relevance = hit.name.toLowerCase() === token ? SEED_EXACT_SCORE : SEED_FUZZY_SCORE
      upsertMax(results, hit.symbolUid, relevance)
    }
  }
  return [...results.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEED_CAP)
}

/**
 * Collect the 1-hop neighbor uids of every seed with their best scores: the
 * seed itself at distance 0, and callers/callees at `seedScore * 0.5`.
 * @param context - lane context carrying the port facet.
 * @param seeds - seed `(uid, score)` pairs.
 * @returns neighbor uids mapped to their best score, insertion-ordered.
 */
function expandNeighbors(context: LaneContext, seeds: Array<readonly [string, number]>): Map<string, number> {
  const seedUids = seeds.map(([uid]) => uid)
  // Rows where the seeds are the callers → their callees are the neighbors.
  const callersBySeed = edgesBySeed(edgesOrEmpty(() => context.port.graph.callerRowsByUids(seedUids, LOOKUP_CAP)))
  // Rows where the seeds are the callees → their callers are the neighbors.
  const calleesBySeed = edgesBySeed(edgesOrEmpty(() => context.port.graph.calleeRowsByUids(seedUids, LOOKUP_CAP)))

  const neighbors = new Map<string, number>()
  for (const [uid, seedScore] of seeds) {
    upsertMax(neighbors, uid, seedScore)
    const decayed = seedScore * NEIGHBOR_DECAY
    for (const edge of callersBySeed.get(uid) ?? []) {
      if (edge.calleeSymbolUid !== null) {
        upsertMax(neighbors, edge.calleeSymbolUid, decayed)
      }
    }
    for (const edge of calleesBySeed.get(uid) ?? []) {
      if (edge.callerSymbolUid !== null) {
        upsertMax(neighbors, edge.callerSymbolUid, decayed)
      }
    }
  }
  return neighbors
}

/**
 * Map symbol rows back to their smallest containing chunk, keeping the best
 * score per chunk. `SymbolRowLite` carries no language column: scope
 * enforcement is the plan's prefix/file filter, which is what the reference's
 * extension-inferred language check collapses to under the P1 request
 * vocabulary (no language filter exists to compare against).
 * @param context - lane context providing the plan filters.
 * @param neighbors - `uid -> score` accumulation.
 * @returns `(chunkId, graph score)` pairs, best-first.
 */
function chunkScoresForNeighbors(context: LaneContext, neighbors: ReadonlyMap<string, number>): Array<readonly [string, number]> {
  const rowsByUid = new Map<string, SymbolRowLite>()
  for (const row of context.port.graph.symbolRowsByUids([...neighbors.keys()])) {
    if (row.symbolUid !== null) {
      rowsByUid.set(row.symbolUid, row)
    }
  }

  const candidates: Array<{ filePath: string; startLine: number; endLine: number; score: number }> = []
  for (const [uid, score] of neighbors) {
    const row = rowsByUid.get(uid)
    if (row === undefined || !context.plan.passesFilters(row.filePath)) {
      continue
    }
    candidates.push({ filePath: row.filePath, startLine: row.startLine, endLine: row.endLine, score })
  }

  const spansByFile = new Map<string, ChunkSpanRow[]>()
  for (const span of context.port.graph.chunkSpansForFiles([...new Set(candidates.map(entry => entry.filePath))])) {
    const kept = spansByFile.get(span.filePath)
    if (kept === undefined) {
      spansByFile.set(span.filePath, [span])
    } else {
      kept.push(span)
    }
  }

  const bestPerChunk = new Map<string, number>()
  for (const candidate of candidates) {
    let smallest: ChunkSpanRow | undefined
    for (const span of spansByFile.get(candidate.filePath) ?? []) {
      const contains = span.startLine <= candidate.startLine && span.endLine >= candidate.endLine
      if (!contains) continue
      if (smallest === undefined || span.endLine - span.startLine < smallest.endLine - smallest.startLine) {
        smallest = span
      }
    }
    if (smallest !== undefined) {
      upsertMax(bestPerChunk, smallest.chunkId, candidate.score)
    }
  }
  return [...bestPerChunk.entries()]
    .sort((a, b) => b[1] - a[1])
}

function run(context: LaneContext): LaneRankedHit[] {
  const seeds = findSeedSymbolUids(context)
  if (seeds.length === 0) {
    return []
  }
  // Every seed enters the neighbor accumulation at distance 0, so the field
  // is non-empty whenever the seeds are.
  const neighbors = expandNeighbors(context, seeds)
  // The graph score rides on the hit (the lane's declarative `graph` score
  // slot); only the rank position feeds RRF, and being fusion-only the lane
  // never annotates hits with it.
  return chunkScoresForNeighbors(context, neighbors)
    .slice(0, context.plan.limits().graph)
    .map(([chunkId, score]) => ({ chunkId, score }))
}

/**
 * The graph retrieval lane (weight `SearchConfig.graphWeight`, default 0.6;
 * disabled when the weight is `0`).
 * @returns the frozen graph lane definition — fusion-only: no hit annotation,
 * no reason tokens, and the `graph` score slot stays declarative.
 */
export const createGraphLane = (): RetrievalLane =>
  defineRetrievalLane({
    laneId: LANE_GRAPH_ID,
    weight: config => config.graphWeight,
    isEnabled: context => context.config.graphWeight > 0,
    annotatesHits: () => false,
    scoreSlot: () => 'graph',
    run,
  })
