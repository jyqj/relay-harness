/** Deterministic retrieval evaluation over the public code-index seam. */

import type CodeIndex from '@relay-harness/rlh-code-index'

/** One query and its file-level relevance judgments. */
export interface RetrievalEvalCase {
  readonly id: string
  readonly query: string
  readonly relevantPaths: readonly string[]
}

/** Per-query metrics and retained ranking evidence. */
export interface RetrievalEvalCaseResult {
  readonly id: string
  readonly recallAt5: number
  readonly reciprocalRank: number
  readonly retrievedPaths: readonly string[]
}

/** Aggregate report comparable across retrieval changes. */
export interface RetrievalEvalReport {
  readonly cases: readonly RetrievalEvalCaseResult[]
  readonly recallAt5: number
  readonly mrr: number
}

/** Executable quality/performance thresholds used by the checked-in eval gate. */
export interface RetrievalEvalThresholds {
  readonly minRecallAt5: number
  readonly minMrr: number
  readonly maxIncrementalP95Ms: number
}

/** Result of applying retrieval and incremental-latency thresholds. */
export interface RetrievalThresholdReport {
  readonly recallAt5: number
  readonly mrr: number
  readonly incrementalP95Ms: number
}

/**
 * Compute nearest-rank p95 over non-empty millisecond samples.
 * @param samples - observed non-negative durations.
 * @returns nearest-rank 95th percentile.
 */
export function percentile95(samples: readonly number[]): number {
  if (samples.length === 0) throw new Error('incremental latency samples must not be empty')
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * 0.95) - 1] as number
}

/**
 * Fail an executable eval gate when quality or incremental latency regresses.
 * @param report - retrieval corpus metrics.
 * @param incrementalDurationsMs - public refresh summary durations.
 * @param thresholds - minimum quality and maximum p95 latency.
 * @returns observed metrics when every threshold passes.
 */
export function assertRetrievalThresholds(
  report: RetrievalEvalReport,
  incrementalDurationsMs: readonly number[],
  thresholds: RetrievalEvalThresholds,
): RetrievalThresholdReport {
  const incrementalP95Ms = percentile95(incrementalDurationsMs)
  if (report.recallAt5 < thresholds.minRecallAt5) {
    throw new Error(`Recall@5 ${report.recallAt5.toFixed(4)} is below ${thresholds.minRecallAt5.toFixed(4)}`)
  }
  if (report.mrr < thresholds.minMrr) {
    throw new Error(`MRR ${report.mrr.toFixed(4)} is below ${thresholds.minMrr.toFixed(4)}`)
  }
  if (incrementalP95Ms > thresholds.maxIncrementalP95Ms) {
    throw new Error(`incremental p95 ${incrementalP95Ms}ms exceeds ${thresholds.maxIncrementalP95Ms}ms`)
  }
  return { recallAt5: report.recallAt5, mrr: report.mrr, incrementalP95Ms }
}

/**
 * Execute a corpus through the provider-neutral `search` operation and compute
 * file-level Recall@5 plus reciprocal rank.
 * @param index - public code-index search seam; no provider internals are read.
 * @param corpus - deterministic relevance judgments with at least one relevant path each.
 * @returns per-case rankings and macro-averaged Recall@5/MRR.
 */
export async function evaluateRetrieval(
  index: Pick<CodeIndex, 'search'>,
  corpus: readonly RetrievalEvalCase[],
): Promise<RetrievalEvalReport> {
  if (corpus.length === 0) throw new Error('retrieval eval corpus must not be empty')
  const cases: RetrievalEvalCaseResult[] = []
  for (const item of corpus) {
    const relevant = new Set(item.relevantPaths)
    if (relevant.size === 0) throw new Error(`retrieval eval case ${item.id} has no relevant paths`)
    const answer = await index.search({ query: item.query, topK: 5 })
    const retrievedPaths = answer.hits.map(hit => hit.filePath)
    const topFiveRelevant = new Set(retrievedPaths.slice(0, 5).filter(path => relevant.has(path)))
    const firstRelevant = retrievedPaths.findIndex(path => relevant.has(path))
    cases.push({
      id: item.id,
      recallAt5: topFiveRelevant.size / relevant.size,
      reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
      retrievedPaths,
    })
  }
  return {
    cases,
    recallAt5: cases.reduce((sum, item) => sum + item.recallAt5, 0) / cases.length,
    mrr: cases.reduce((sum, item) => sum + item.reciprocalRank, 0) / cases.length,
  }
}
