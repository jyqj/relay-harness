/**
 * Grep lane: case-insensitive literal match over decoded chunk text with a
 * shared row-scan budget, executed through the {@link RetrievalPort} scan
 * callbacks (the store owns row ordering + scope; this side owns budget
 * accounting and the two-stage merge — see `port.ts`).
 *
 * Ported from the reference implementation (`crates/cc-search/src/lanes.rs`,
 * `GrepLane` / `grep_prefilter_phrase` / `GrepScanState::process_row`).
 *
 * Unscoped scans run in two stages: stage 1 pulls candidates from a
 * `chunks_fts` MATCH prefilter derived from the grep literal (matches at
 * token boundaries are a superset of the FTS phrase hits); stage 2 falls back
 * to the full recency-ordered scan for matches the tokenizer cannot see
 * (mid-token substrings), skipping rows stage 1 already visited. Matches from
 * both stages merge in recency (rowid-descending) order, so when the budget
 * covers the scope the result equals a single-pass scan exactly; under budget
 * pressure the prefilter finds more matches sooner. File-scoped scans are
 * cardinality-bounded and keep the single-pass behavior.
 *
 * @module @relay-harness/rlh-code-index-search/lanes.grep
 */

import { LANE_GREP_ID, rankScored } from './fusion.ts'
import type { ChunkScanVisitor } from './port.ts'
import { defineRetrievalLane } from './registry.ts'
import type { LaneContext, LaneRankedHit, ReadErrorCollector, RetrievalLane } from './types.ts'

/** Mutable scan state shared by both stages: rows decoded so far (the budget),
 * whether the budget ran out, and matches as `(rowid, chunkId)` pairs. */
interface GrepScanState {
  scanned: number
  truncated: boolean
  matches: Array<readonly [number, string]>
}

/**
 * Build the `chunks_fts` MATCH phrase for the grep literal, or `null` when the
 * literal has no tokenizable content worth prefiltering (all punctuation, or
 * only single-character tokens).
 *
 * The literal's alphanumeric runs appear as adjacent tokens in any text
 * containing the literal at a token boundary, so a quoted phrase of those runs
 * — with a trailing `*` when the literal ends mid-token — selects a candidate
 * superset of all token-boundary matches. Mid-token starts (querying
 * `UserById` against `getUserById`) are invisible to the tokenizer; stage 2
 * exists for those.
 * @param query - raw grep literal to translate into a quoted MATCH phrase.
 * @returns the `chunks_fts` phrase (trailing `*` when the literal ends
 * mid-token), or `null` when prefiltering cannot help.
 */
export function grepPrefilterPhrase(query: string): string | null {
  const tokens = query.split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 0)
  if (!tokens.some(token => Array.from(token).length >= 2)) {
    return null
  }
  const endsAlphanumeric = /[\p{L}\p{N}]$/u.test(query)
  return `"${tokens.join(' ')}"${endsAlphanumeric ? '*' : ''}`
}

/** Escape a query literal into a plain case-insensitive substring regex. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function createVisitor(
  context: LaneContext,
  re: RegExp,
  limit: number,
  scanCap: number,
  seenOut: Set<string> | null,
  scan: GrepScanState,
): ChunkScanVisitor {
  const plan = context.plan
  return (row) => {
    if (scan.scanned >= scanCap) {
      scan.truncated = true
      return false
    }
    scan.scanned++
    seenOut?.add(row.chunkId)
    // File-level filtering is done by the store's scope; kept here as the
    // reference does, so scope and filter can never disagree.
    if (!plan.passesFilters(row.filePath)) {
      return true
    }
    if (re.test(row.text)) {
      scan.matches.push([row.rowid, row.chunkId])
      if (scan.matches.length >= limit) {
        return false
      }
    }
    return true
  }
}

function run(context: LaneContext, readErrors: ReadErrorCollector): LaneRankedHit[] {
  const plan = context.plan
  const limit = plan.limits().grep
  // A plain escaped literal under case-insensitive matching; the constructor
  // cannot reject an all-literal pattern.
  const regex = new RegExp(escapeRegExp(plan.grepQuery()), 'i')

  // Every visited row costs a decode on the store side, so the shared budget
  // caps rows pulled across BOTH stages instead of scanning the whole scope.
  const scanCap = context.config.grepScanCap
  const scan: GrepScanState = { scanned: 0, truncated: false, matches: [] }
  const prefetchedChunkIds = new Set<string>()

  const hasFileScope = plan.hasFileScope()
  const prefilterPhrase = hasFileScope ? null : grepPrefilterPhrase(plan.grepQuery())

  // Stage 1 — FTS prefilter (unscoped scans only). A MATCH the tokenizer
  // rejects must not fail the lane: reset state and fall back to the full scan.
  if (prefilterPhrase !== null) {
    try {
      context.port.scanChunksForGrepPrefiltered(
        prefilterPhrase,
        scanCap,
        plan.chunkScope(),
        createVisitor(context, regex, limit, scanCap, prefetchedChunkIds, scan),
      )
    } catch (error) {
      readErrors.push(`grep lane: FTS prefilter failed (${String(error)}); fell back to full scan`)
      prefetchedChunkIds.clear()
      scan.scanned = 0
      scan.truncated = false
      scan.matches = []
    }
  }

  // Stage 2 — full scoped scan for mid-token matches, skipping stage-1 rows.
  if (scan.matches.length < limit && !scan.truncated) {
    try {
      context.port.scanChunksForGrep(
        plan.chunkScope(),
        prefetchedChunkIds.size > 0 ? prefetchedChunkIds : null,
        createVisitor(context, regex, limit, scanCap, null, scan),
      )
    } catch (error) {
      readErrors.push(`grep lane: chunk scan failed (${String(error)})`)
      return []
    }
  }

  // Merge the stages in recency order. Unscoped single-stage results are
  // already rowid-descending so this is a stable no-op there; scoped scans
  // never ran stage 1 and keep the store's natural probe order untouched.
  if (prefilterPhrase !== null) {
    scan.matches.sort((a, b) => b[0] - a[0])
    scan.matches = scan.matches.slice(0, limit)
  }
  return rankScored(scan.matches.map(([, chunkId]) => chunkId))
}

/**
 * The grep retrieval lane (weight `search.grep_weight`, default 0.8), gated per request by `includeGrep` (default `true`).
 * @returns the frozen grep lane definition, annotating hits under the `grep` slot.
 */
export const createGrepLane = (): RetrievalLane =>
  defineRetrievalLane({
    laneId: LANE_GREP_ID,
    weight: config => config.grepWeight,
    isEnabled: context => context.plan.request.includeGrep !== false,
    annotatesHits: () => true,
    scoreSlot: () => 'grep',
    run: context => run(context, context.readErrors),
  })
