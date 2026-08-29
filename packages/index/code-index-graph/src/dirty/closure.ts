/**
 * Fixpoint dirty-closure policy for incremental dirty propagation.
 *
 * Ported from the reference implementation's `dirty_closure.rs`: given the
 * files whose export fingerprint changed in the current build, repeatedly
 * find their importers, promote the promotable ones, and re-check whether
 * each promoted file's *effective* export surface changed (re-export chains)
 * so their importers get promoted too. Iterates until convergence, a global
 * file budget, or a hard round cap. Graph lookups and surface checks are
 * injected as hooks, so the policy is unit-testable without a store.
 *
 * @module @relay-harness/rlh-code-index-graph/dirty/closure
 */

/** Hard safety cap on fixpoint rounds; each round promotes at least one file or the loop has converged. */
export const DIRTY_CLOSURE_MAX_ROUNDS = 16

/**
 * How the incremental dirty-propagation phase ended, surfaced on the pass
 * report so callers can tell a complete closure from a degraded one instead
 * of inferring it from log output. The values pin the reference's
 * `snake_case` wire spelling.
 */
export type DirtyPropagationStatus = 'normal' | 'partial_closure' | 'budget_exceeded' | 'disabled'

/** Outcome of the fixpoint dirty closure. */
export interface DirtyClosureResult {
  /** Files to promote, in promotion order; deterministic (sorted per round). */
  readonly promoted: readonly string[]
  /** Convenience count of {@link DirtyClosureResult.promoted}. */
  readonly marked: number
  /** Number of importer-expansion rounds actually run. */
  readonly roundsRun: number
  /**
   * Round-1 direct importers alone exceeded the budget; propagation degraded
   * to a budget-sized deterministic prefix of round 1 (strictly less
   * staleness than promoting nothing).
   */
  readonly budgetExceeded: boolean
  /**
   * The closure stopped early (round cap hit, or the budget was exceeded
   * after round 1 and later rounds dropped); {@link DirtyClosureResult.promoted}
   * is a valid complete-round prefix of the full closure.
   */
  readonly partial: boolean
  /** Classification of the closure outcome for the pass report. */
  readonly status: DirtyPropagationStatus
}

/** Hooks and bounds of {@link computeDirtyClosure}. */
export interface DirtyClosureInput {
  /** Files whose export fingerprint changed vs the store; never promoted themselves. */
  readonly seeds: readonly string[]
  /** GLOBAL promotion budget across all rounds, enforced strictly-greater-than. */
  readonly maxFiles: number
  /** Hard round cap; defaults to {@link DIRTY_CLOSURE_MAX_ROUNDS}. */
  readonly maxRounds?: number
  /** Resolves the importers of a set of files (set-ordered results are re-sorted here). */
  readonly findImportersOf: (files: readonly string[]) => readonly string[]
  /** Whether a candidate may be promoted (only content-unchanged files qualify). */
  readonly isPromotable: (path: string) => boolean
  /**
   * Per-pass batch hook: the subset of `files` (promoted files) whose
   * effective export surface changed given everything changed so far; those
   * files' importers are expanded in the next round.
   */
  readonly promotedExportSurfacesChanged: (
    files: readonly string[],
    changedSoFar: ReadonlySet<string>,
  ) => readonly string[]
}

/**
 * Classify a closure outcome; `budgetExceeded` and `partial` are mutually
 * exclusive by construction (the round-1 bail returns `partial: false`).
 * @param budgetExceeded - whether the round-1 budget bail fired.
 * @param partial - whether the closure stopped before convergence otherwise.
 * @returns the status for the pass report.
 */
export function closureStatusOf(budgetExceeded: boolean, partial: boolean): DirtyPropagationStatus {
  if (budgetExceeded) return 'budget_exceeded'
  return partial ? 'partial_closure' : 'normal'
}

/**
 * Compute the transitive dirty closure as a fixpoint iteration.
 *
 * The budget is global across rounds and strictly-greater-than: round 1 alone
 * over budget keeps a budget-sized deterministic prefix of the sorted
 * round-1 importers and reports `budget_exceeded`; a later round over budget
 * truncates at the last completed round boundary and reports `partial`.
 * Promoted files whose surface did not change are re-evaluated whenever the
 * changed set grows (same-round sibling re-export chains), inside an inner
 * fixpoint; each file flips at most once, so convergence stays bounded.
 * @param input - seeds, bounds, and the injected graph/surface hooks.
 * @returns the promotions plus the closure classification.
 */
export function computeDirtyClosure(input: DirtyClosureInput): DirtyClosureResult {
  const maxRounds = input.maxRounds ?? DIRTY_CLOSURE_MAX_ROUNDS
  // Everything whose export surface is known to have changed so far; surface
  // checks run against the full set, not just the current frontier.
  const changedSoFar = new Set<string>(input.seeds)
  // Files whose importers still need expanding in the next round.
  let frontier: string[] = [...input.seeds]
  const promoted: string[] = []
  const promotedSet = new Set<string>()
  // Promoted files whose surface has not (yet) changed; re-checked whenever
  // `changedSoFar` grows so sibling re-export chains are seen.
  let promotedUnchanged: string[] = []
  let roundsRun = 0
  let partial = false

  while (frontier.length > 0) {
    if (roundsRun >= maxRounds) {
      partial = true
      break
    }
    roundsRun += 1

    const newlyPromoted = [...new Set(input.findImportersOf(frontier))]
      .filter(path => !promotedSet.has(path) && !changedSoFar.has(path) && input.isPromotable(path))
      .sort()

    if (promoted.length + newlyPromoted.length > input.maxFiles) {
      if (roundsRun === 1) {
        // Round 1 alone over budget: promote a deterministic prefix of the
        // sorted direct importers instead of nothing, and stop expanding.
        const truncated = newlyPromoted.slice(0, input.maxFiles)
        return {
          promoted: truncated,
          marked: truncated.length,
          roundsRun,
          budgetExceeded: true,
          partial: false,
          status: 'budget_exceeded',
        }
      }
      // Later rounds over budget: keep the completed-round boundary.
      partial = true
      break
    }

    for (const path of newlyPromoted) promotedSet.add(path)
    promoted.push(...newlyPromoted)

    // Surface evaluation: this round's promotions plus every previously
    // promoted-but-unchanged file, re-checked until no more flips. A file
    // promoted alongside a sibling it re-exports from only flips after the
    // sibling enters `changedSoFar`, hence the inner fixpoint.
    const nextFrontier: string[] = []
    let candidates = [...newlyPromoted, ...promotedUnchanged]
    while (candidates.length > 0) {
      const flipped = input.promotedExportSurfacesChanged(candidates, changedSoFar)
      if (flipped.length === 0) break
      const flippedSet = new Set(flipped)
      const before = candidates.length
      const surviving = candidates.filter(path => !flippedSet.has(path))
      if (surviving.length === before) break
      candidates = surviving
      for (const path of flipped) {
        changedSoFar.add(path)
        nextFrontier.push(path)
      }
    }
    promotedUnchanged = candidates
    frontier = nextFrontier
  }

  return {
    promoted,
    marked: promoted.length,
    roundsRun,
    budgetExceeded: false,
    partial,
    status: closureStatusOf(false, partial),
  }
}
