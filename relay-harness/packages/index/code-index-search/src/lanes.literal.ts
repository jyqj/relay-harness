/**
 * Literal lane: FTS5 (`literal_fts`) MATCH over classified `literal_index`
 * rows, bm25-ordered, attributed to the chunks whose line spans cover each
 * hit — the fusion pipeline only knows chunk identities, so a literal ranks
 * the chunk containing it.
 *
 * The lane shares the lexical lane's skeleton (`sanitizeFtsQuery` → MATCH →
 * plan filtering → rank decoration); what differs is the port query and the
 * line-to-chunk attribution, so only that lives here. It requires a port with
 * the optional literal mirror (`RetrievalPort.literalFtsCandidates`) and
 * disables itself otherwise, keeping pre-literal adapters working unchanged.
 *
 * @module @relay-harness/rlh-code-index-search/lanes.literal
 */

import { LANE_LITERAL_ID, rankScored } from './fusion.ts'
import type { ChunkSpanRow } from './port.ts'
import type { LaneContext, LaneRankedHit, RetrievalLane } from './types.ts'
import { sanitizeFtsQuery } from './text.ts'
import { defineRetrievalLane } from './registry.ts'

/**
 * Attribute one literal line to its chunk: the last span starting at or
 * before the line (spans may leave gaps between chunks; the earlier chunk is
 * the honest owner), `null` before the first span starts.
 * @param spans - the file's chunk spans in store order.
 * @param line - the literal's 1-based line.
 * @returns the owning chunk id, or `null` when no span can take the line.
 */
export function chunkOwningLine(spans: readonly ChunkSpanRow[], line: number): string | null {
  const ordered = [...spans].sort((a, b) => a.startLine - b.startLine)
  let chosen: ChunkSpanRow | undefined
  for (const span of ordered) {
    if (span.startLine > line) break
    chosen = span
  }
  return chosen?.chunkId ?? null
}

function run(context: LaneContext): LaneRankedHit[] {
  const ftsQuery = sanitizeFtsQuery(context.plan.lexicalQuery())
  // A sanitized-empty query must not degenerate into a full-table MATCH.
  if (ftsQuery === '""') {
    return []
  }
  const limit = context.plan.limits().literal
  const candidates = context.port.literalFtsCandidates?.(ftsQuery, context.plan.chunkScope(), limit) ?? []
  const inPlan = candidates.filter(candidate => context.plan.passesFilters(candidate.filePath))
  if (inPlan.length === 0) {
    return []
  }
  const spansByFile = new Map<string, readonly ChunkSpanRow[]>()
  for (const span of context.port.graph.chunkSpansForFiles([...new Set(inPlan.map(candidate => candidate.filePath))])) {
    const existing = spansByFile.get(span.filePath)
    spansByFile.set(span.filePath, existing === undefined ? [span] : [...existing, span])
  }
  // bm25 order is best-first; a chunk holding several matching literals keeps
  // the rank of its best literal, and the lane reports at most `limit` chunks.
  const rankedChunks: string[] = []
  const seen = new Set<string>()
  for (const candidate of inPlan) {
    if (candidate.line === null) continue
    const chunkId = chunkOwningLine(spansByFile.get(candidate.filePath) ?? [], candidate.line)
    if (chunkId === null || seen.has(chunkId)) continue
    seen.add(chunkId)
    rankedChunks.push(chunkId)
    if (rankedChunks.length >= limit) break
  }
  return rankScored(rankedChunks)
}

/**
 * The literal retrieval lane (weight `search.literal_weight`, default 0.9),
 * enabled only on ports that expose the literal FTS mirror.
 * @returns the frozen literal lane definition, annotating hits under the `literal` slot.
 */
export const createLiteralLane = (): RetrievalLane =>
  defineRetrievalLane({
    laneId: LANE_LITERAL_ID,
    weight: config => config.literalWeight,
    isEnabled: context => typeof context.port.literalFtsCandidates === 'function',
    annotatesHits: () => true,
    scoreSlot: () => 'literal',
    run,
  })
