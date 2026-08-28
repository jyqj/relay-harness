/**
 * Lexical lane: FTS5 (`chunks_fts`) MATCH, bm25-ordered candidates.
 *
 * Ported from the reference implementation
 * (`crates/cc-search/src/lanes.rs::LexicalLane`). Sanitization lives in
 * `text.ts`; ranking decoration lives in the shared skeleton (`fusion.ts`),
 * so this module carries only what differs from other lanes.
 *
 * @module @relay-harness/rlh-code-index-search/lanes.lexical
 */

import { sanitizeFtsQuery } from './text.ts'
import { LANE_LEXICAL_ID, rankScored } from './fusion.ts'
import { defineRetrievalLane } from './registry.ts'
import type { LaneContext, LaneRankedHit, RetrievalLane } from './types.ts'

function run(context: LaneContext): LaneRankedHit[] {
  const ftsQuery = sanitizeFtsQuery(context.plan.lexicalQuery())
  // A sanitized-empty query must not degenerate into a full-table MATCH.
  if (ftsQuery === '""') {
    return []
  }
  const candidates = context.port.ftsChunkCandidates(ftsQuery, context.plan.chunkScope(), context.plan.limits().lexical)
  const results: string[] = []
  for (const candidate of candidates) {
    if (!context.plan.passesFilters(candidate.filePath)) {
      continue
    }
    results.push(candidate.chunkId)
  }
  return rankScored(results)
}

/**
 * The lexical retrieval lane (weight `search.lexical_weight`, default 1.1).
 * @returns the frozen lexical lane definition, annotating hits under the `lexical` slot.
 */
export const createLexicalLane = (): RetrievalLane =>
  defineRetrievalLane({
    laneId: LANE_LEXICAL_ID,
    weight: config => config.lexicalWeight,
    isEnabled: () => true,
    annotatesHits: () => true,
    scoreSlot: () => 'lexical',
    run,
  })
