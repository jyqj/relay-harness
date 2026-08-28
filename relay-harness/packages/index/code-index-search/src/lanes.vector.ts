/**
 * Vector lane: quantized-cosine ranking of the candidates earlier lanes found.
 *
 * The lane issues no candidate query of its own. It re-scores the engine's
 * accumulated `LaneContext.priorCandidates` pool against the caller's query
 * embedding (`EngineSearchRequest.queryVector`) through
 * `cosineQuantized` over the store's `chunks_vec` rows (see
 * `@relay-harness/rlh-code-index-search/vector-math`), so semantic neighbors
 * that no lexical/grep/graph term caught can still enter fusion. It requires
 * a port with the optional vector facet and a request carrying a query
 * vector, and disables itself otherwise — deployments without an embedding
 * tier keep their pre-vector behavior unchanged.
 *
 * @module @relay-harness/rlh-code-index-search/lanes.vector
 */

import { LANE_VECTOR_ID, rankScored } from './fusion.ts'
import type { LaneContext, LaneRankedHit, RetrievalLane } from './types.ts'
import { cosineQuantized } from './vector-math.ts'
import { compareStrings } from './text.ts'
import { defineRetrievalLane } from './registry.ts'

/** Construction options for the vector lane. */
export interface VectorLaneOptions {
  /**
   * `chunks_vec` model identity this lane reads vectors from. It must match
   * the embedder that produced the query vector: vectors of other models
   * coexist in the store and comparing across them would be meaningless.
   */
  readonly model: string
}

/**
 * Score one candidate pool against the query vector: rows the store holds are
 * cosine-scored without dequantizing, non-positive similarities drop (an
 * orthogonal or opposite vector is no evidence of relevance), the order is
 * similarity descending with chunk id as the deterministic tie-break, and the
 * lane reports at most `max(search.vector_top_k, the tier's base top-K)` chunks.
 *
 * A stored row whose component count differs from the query vector (the
 * embedder's dimensionality changed under an unchanged model name) makes
 * every score meaningless, so `cosineQuantized`'s mismatch throw aborts the
 * lane and degrades the search instead of ranking noise.
 * @param context - the lane context carrying the pool, query vector, and port.
 * @param model - the `chunks_vec` model identity to read.
 * @returns the lane's ranked hits, best first.
 */
export function runVectorLane(context: LaneContext, model: string): LaneRankedHit[] {
  const queryVector = context.plan.request.queryVector
  const vectorPort = context.port.vector
  // `isEnabled` gates both; the re-check keeps `run` total for direct callers.
  if (queryVector === undefined || vectorPort === undefined) return []
  const pool = context.priorCandidates ?? []
  if (pool.length === 0) return []
  const scored: LaneRankedHit[] = []
  for (const row of vectorPort.vectorsByChunkIds(pool, model)) {
    const similarity = cosineQuantized(queryVector, row.q, row.scale, row.norm)
    if (similarity <= 0) continue
    scored.push({ chunkId: row.chunkId, score: similarity })
  }
  scored.sort((a, b) => b.score - a.score || compareStrings(a.chunkId, b.chunkId))
  const limit = context.plan.limits().vector
  return rankScored(scored.slice(0, limit).map(hit => hit.chunkId))
}

/**
 * The vector retrieval lane (weight `search.vector_weight`, default 0.9),
 * enabled only when the port exposes the vector facet and the request carries
 * a query embedding.
 * @param options - the `chunks_vec` model identity to read.
 * @returns the frozen vector lane definition, annotating hits under the `vector` slot.
 */
export const createVectorLane = (options: VectorLaneOptions): RetrievalLane =>
  defineRetrievalLane({
    laneId: LANE_VECTOR_ID,
    weight: config => config.vectorWeight,
    isEnabled: context =>
      context.port.vector !== undefined && context.plan.request.queryVector !== undefined,
    annotatesHits: () => true,
    scoreSlot: () => 'vector',
    run: context => runVectorLane(context, options.model),
  })
