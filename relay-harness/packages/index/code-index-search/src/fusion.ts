/**
 * Reciprocal Rank Fusion and the shared lane-output skeleton.
 *
 * Ported from the reference implementation (`crates/cc-search/src/rrf.rs` for
 * the formulas, `lanes.rs::fuse_outcomes` / `rank_scored` for the shared
 * skeleton so the two built-in lanes cannot drift apart — their only
 * lane-specific code is candidate retrieval).
 *
 * @module @relay-harness/rlh-code-index-search/fusion
 */

import { tokenizeCodeish } from './text.ts'
import type { FusedScore, LaneOutcome, LaneRankedHit } from './types.ts'

/** Stable lane id of the FTS5 lexical lane. */
export const LANE_LEXICAL_ID = 'lexical'
/** Stable lane id of the substring/grep lane. */
export const LANE_GREP_ID = 'grep'
/** Stable lane id of the classified-literal lane. */
export const LANE_LITERAL_ID = 'literal'
/** Stable lane id of the quantized-vector lane. */
export const LANE_VECTOR_ID = 'vector'

/**
 * Accumulate RRF scores into `scores` from a ranked list:
 * `score(d) += weight / (k + rank + 1)` with 0-based positions.
 * @param scores - accumulator mutated in place, keyed by chunk id.
 * @param rankedIds - chunk ids in best-first order (rank = array position).
 * @param weight - lane weight applied to every contribution.
 * @param k - RRF dampening constant (`search.rrf_k`, default 50).
 */
export function rrfAccumulate(
  scores: Map<string, number>,
  rankedIds: readonly string[],
  weight: number,
  k: number,
): void {
  for (const [position, id] of rankedIds.entries()) {
    const score = weight / (k + position + 1)
    const existing = scores.get(id)
    if (existing === undefined) {
      scores.set(id, score)
    } else {
      scores.set(id, existing + score)
    }
  }
}

/**
 * Attach the shared rank-position score (`1/(i+1)`) to an ordered chunk-id list; purely diagnostic.
 * @param ids - chunk ids in best-first order.
 * @returns ordered hits carrying rank scores aligned to the input order.
 */
export function rankScored(ids: readonly string[]): LaneRankedHit[] {
  return ids.map((chunkId, position) => ({ chunkId, score: 1 / (position + 1) }))
}

/**
 * RRF-fuse lane outcomes in registration order, keeping each candidate's per-lane breakdown.
 * @param outcomes - lane outcomes in registry (fusion) order.
 * @param rrfK - RRF dampening constant (`search.rrf_k`, default 50).
 * @returns fused totals keyed by chunk id, each with its ordered per-lane contributions.
 */
export function fuseOutcomes(outcomes: readonly LaneOutcome[], rrfK: number): Map<string, FusedScore> {
  const fused = new Map<string, FusedScore>()
  for (const outcome of outcomes) {
    outcome.hits.forEach((hit, position) => {
      const score = outcome.weight / (rrfK + position + 1)
      let entry = fused.get(hit.chunkId)
      if (entry === undefined) {
        entry = { total: 0, byLane: [] }
        fused.set(hit.chunkId, entry)
      }
      entry.total += score
      entry.byLane.push({ laneId: outcome.laneId, score })
    })
  }
  return fused
}

/**
 * Compute overlap between query tokens and text tokens: matched fraction of the query vocabulary.
 * @param queryTokens - case-folded query vocabulary (see `tokenizeCodeish`).
 * @param text - text tokenized and matched against that vocabulary.
 * @returns hits / query-token count in `[0, 1]`; 0 when either side is empty.
 */
export function overlapScore(queryTokens: readonly string[], text: string): number {
  const haystack = new Set(tokenizeCodeish(text))
  if (haystack.size === 0 || queryTokens.length === 0) {
    return 0
  }
  let hits = 0
  for (const token of queryTokens) {
    if (haystack.has(token)) hits++
  }
  return hits / Math.max(1, queryTokens.length)
}

type FusedEntry = readonly [string, FusedScore]

/**
 * Deterministic fused-candidate ordering: total desc, chunkId asc on ties.
 * Extracted so the exact three-way comparison is unit-pinned and the engine's
 * windowing cannot drift from it.
 * @param a - first `[chunkId, FusedScore]` entry.
 * @param b - second `[chunkId, FusedScore]` entry.
 * @returns negative when `a` sorts first, positive when `b` sorts first, 0 on full ties.
 */
export function compareFusedEntries(a: FusedEntry, b: FusedEntry): number {
  if (a[1].total !== b[1].total) {
    return b[1].total - a[1].total
  }
  if (a[0] < b[0]) return -1
  if (a[0] > b[0]) return 1
  return 0
}
