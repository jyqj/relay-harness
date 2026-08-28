/**
 * Rerank: the additive bonus table applied inside the rerank window, plus the
 * reason vocabulary that explains every component.
 *
 * Ported from the reference implementation (`crates/cc-search/src/plan.rs`
 * `hit_from_chunk` + `is_project_doc`, and `score_trace.rs` for the traced
 * total). The addition order below is the historical order — RRF lane
 * contributions, overlap, symbol-exact, boosts, stage-A — so float results
 * match the reference bit-for-bit, and the final score IS the trace total.
 *
 * P1 delta from the reference, kept as an explicit gate:
 * - `symbol-exact` (+`ranking.symbolExactBonus`, default 0.18) runs only when
 *   `FeatureGates.symbolExactEnabled` is on (the default) and the candidate
 *   carries a symbol name; adapters indexing without symbol names can switch
 *   it off explicitly.
 *
 * @module @relay-harness/rlh-code-index-search/rerank
 */

import { overlapScore } from './fusion.ts'
import type { LaneRanks } from './plan.ts'
import type { FusedScore, FeatureGates, PreselectResult, RankingConfig } from './types.ts'

/** Ordered additive components of a rerank score; summing in order reproduces the total bit-for-bit. */
export class ScoreTrace {
  private readonly components: Array<{ label: string; value: number }> = []

  /**
   * Bill one component under a stable label (e.g. `rrf:lexical`, `overlap`, `boost:stage-a`).
   * @param label - stable component identifier used in score explanations.
   * @param value - additive contribution; summed left-to-right into the total.
   */
  push(label: string, value: number): void {
    this.components.push({ label, value })
  }

  /**
   * Total exactly as accumulated (left-to-right float addition).
   * @returns the bit-exact sum of every pushed component.
   */
  total(): number {
    let sum = 0
    for (const component of this.components) {
      sum += component.value
    }
    return sum
  }
}

/** Inputs to the per-candidate rerank step. */
export interface RerankInput {
  readonly chunkId: string
  readonly filePath: string
  readonly breadcrumb: string
  readonly symbolName: string | null
  readonly text: string
  readonly fused: FusedScore
  readonly queryTokens: readonly string[]
  readonly laneRanks: LaneRanks
  readonly ranking: RankingConfig
  readonly gates: FeatureGates
  readonly filtersPathPrefix: string | null
  /** Working-set / recent / pinned / overlay path sets driving the boost table. */
  readonly boostFiles: ReadonlySet<string>
  readonly recentFiles: ReadonlySet<string>
  readonly pinnedFiles: ReadonlySet<string>
  readonly overlayFiles: ReadonlySet<string>
  readonly preselectResult: PreselectResult
}

/** One candidate's rerank outcome before result-level finalization. */
export interface RerankOutcome {
  readonly rerankScore: number
  /** Deterministic reason tokens explaining every additive score component (deduplicated, first occurrence kept). */
  readonly reasons: readonly string[]
}

/**
 * Apply the full additive rerank table to one candidate.
 *
 * Reason emission order mirrors the reference: annotating-lane ranks
 * (`{laneId}@{rank}`) first, then reason-bearing boosts (`doc-file`,
 * `working-set-boost`, `recent-file`, `pinned-context`, `overlay-neighbor`),
 * then up to three preselect file reasons, then one `preselect:{layer}:+score`
 * bill entry per contributing layer. Duplicates drop keeping first occurrences.
 * @param input - the candidate, its fused score, lane ranks, and ranking context.
 * @returns the trace-total rerank score plus deduplicated reason tokens in emission order.
 */
export function rerankCandidate(input: RerankInput): RerankOutcome {
  const { ranking } = input

  // Overlap sees "path breadcrumb symbol" plus the chunk body, exactly like
  // the reference's `format!("{path_text}\n{text}")`.
  const pathText = `${input.filePath} ${input.breadcrumb} ${input.symbolName ?? ''}`
  const overlap = overlapScore(input.queryTokens, `${pathText}\n${input.text}`)

  const trace = new ScoreTrace()
  if (input.fused.byLane.length === 0) {
    trace.push('rrf', input.fused.total)
  } else {
    for (const contribution of input.fused.byLane) {
      trace.push(`rrf:${contribution.laneId}`, contribution.score)
    }
  }
  trace.push('overlap', overlap * ranking.overlapWeight)

  const reasons: string[] = []

  // Per-hit annotation is lane-driven: every lane that opted in contributes a
  // `{laneId}@{rank}` reason, iterated in lane-collection order.
  for (const { laneId } of input.laneRanks.annotatingLanes) {
    const rank = input.laneRanks.rank(laneId, input.chunkId)
    if (rank === undefined) continue
    reasons.push(`${laneId}@${rank}`)
  }

  // Case-insensitive exact comparison against the full symbol name; the gate
  // is the explicit off switch for symbol-less adapters (see module docs).
  if (input.gates.symbolExactEnabled && input.symbolName !== null) {
    const symbolLower = input.symbolName.toLowerCase()
    if (input.queryTokens.includes(symbolLower)) {
      trace.push('boost:symbol-exact', ranking.symbolExactBonus)
      reasons.push('symbol-exact')
    }
  }

  if (input.filtersPathPrefix !== null && input.filePath.startsWith(input.filtersPathPrefix)) {
    trace.push('boost:path-prefix', ranking.pathPrefixBonus)
  }

  if (isProjectDoc(input.filePath)) {
    trace.push('boost:doc-file', ranking.docFileBonus)
    reasons.push('doc-file')
  }
  if (input.boostFiles.has(input.filePath)) {
    trace.push('boost:working-set-boost', ranking.workingSetBoost)
    reasons.push('working-set-boost')
  }
  if (input.recentFiles.has(input.filePath)) {
    trace.push('boost:recent-file', ranking.recentFileBoost)
    reasons.push('recent-file')
  }
  if (input.pinnedFiles.has(input.filePath)) {
    trace.push('boost:pinned-context', ranking.pinnedContextBoost)
    reasons.push('pinned-context')
  }
  if (input.overlayFiles.has(input.filePath)) {
    trace.push('boost:overlay-neighbor', ranking.overlayNeighborBoost)
    reasons.push('overlay-neighbor')
  }

  const stageAScore = input.preselectResult.scores.get(input.filePath) ?? 0
  if (stageAScore > 0) {
    trace.push('boost:stage-a', Math.min(stageAScore * ranking.stageAWeight, ranking.stageACap))
    const fileReasons = input.preselectResult.reasons.get(input.filePath)
    if (fileReasons !== undefined) {
      for (const reason of fileReasons.slice(0, 3)) {
        reasons.push(reason)
      }
    }
    const bill = input.preselectResult.layerScores.get(input.filePath)
    if (bill !== undefined) {
      for (const [layer, layerScore] of bill) {
        reasons.push(`preselect:${layer}:+${layerScore.toFixed(2)}`)
      }
    }
  }

  return { rerankScore: trace.total(), reasons: dedupeReasons(reasons) }
}

/**
 * Return true if the file path looks like project documentation:
 * top-level README/DESIGN/CHANGELOG-style markdown, files under `docs/`
 * or `doc/`, or anything inside an ADR directory. Matches the reference
 * heuristic (`plan.rs::is_project_doc`) exactly.
 * @param filePath - slash-separated path to classify.
 * @returns `true` when the path qualifies for the `doc-file` bonus.
 */
export function isProjectDoc(filePath: string): boolean {
  const lower = filePath.toLowerCase()
  if (!lower.endsWith('.md')) {
    return false
  }
  const segments = filePath.split('/')
  if (segments.length <= 2) {
    // Same segment as above without index bounds drama: take everything after
    // the final separator (the whole path when it has none).
    const name = filePath.slice(filePath.lastIndexOf('/') + 1).toUpperCase()
    if (
      [
        'README',
        'DESIGN',
        'ARCHITECTURE',
        'CHANGELOG',
        'CONTRIBUTING',
        'LICENSE',
        'ADR',
        'DECISIONS',
      ].includes(name.replace(/\.MD$/, '').replace(/\.md$/, ''))
    ) {
      return true
    }
  }
  if (lower.startsWith('docs/') || lower.startsWith('doc/')) {
    return true
  }
  return lower.includes('/adr/') || lower.includes('/adrs/')
}

/**
 * Keep first occurrences only, preserving emission order (`dedupe_reasons`).
 * @param reasons - reason tokens possibly containing repeats.
 * @returns a fresh array with duplicates dropped, first occurrence kept.
 */
export function dedupeReasons(reasons: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const reason of reasons) {
    if (!seen.has(reason)) {
      seen.add(reason)
      result.push(reason)
    }
  }
  return result
}
