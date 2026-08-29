/**
 * Repository-size tiers and their adaptive constants — the single source of truth for
 * every tier-scaled value in the code-index capability. Constants are ported verbatim from
 * the reference implementation (`RepoSizeTier` in codecortex `cc-model/src/config.rs`);
 * changing one changes retrieval behavior in every phase.
 *
 * @module @relay-harness/rlh-code-index/tiers
 */

import type { GraphEnrichLimits, RepoSizeTier } from './types.ts'

/** File-count upper bounds (exclusive) per tier, checked in ascending order. */
const TIER_FILE_COUNT_BOUNDS: ReadonlyArray<readonly [number, RepoSizeTier]> = [
  [500, 'tiny'],
  [5000, 'small'],
  [25000, 'medium'],
]

const TIER_SEARCH_TOP_K: Record<RepoSizeTier, number> = { tiny: 5, small: 10, medium: 15, large: 20 }

const TIER_MAX_OUTPUT_CHARS: Record<RepoSizeTier, number> = {
  tiny: 18_000,
  small: 24_000,
  medium: 32_000,
  large: 38_000,
}

const TIER_TOKEN_BUDGET: Record<RepoSizeTier, number> = {
  tiny: 4_000,
  small: 6_000,
  medium: 8_000,
  large: 12_000,
}

/**
 * Graph-enrichment caps per tier, ported verbatim from the reference
 * implementation (`RepoSizeTier::graph_enrich_limits` in codecortex
 * `cc-model/src/config.rs`). Entries are frozen: consumers must copy before
 * mutating instead of retuning the shared table.
 */
const TIER_GRAPH_ENRICH_LIMITS: Readonly<Record<RepoSizeTier, Readonly<GraphEnrichLimits>>> = {
  tiny: Object.freeze({ maxResolve: 3, callersPerSym: 2, calleesPerSym: 2, maxTests: 2, maxRoutes: 1, graphBudgetPct: 20 }),
  small: Object.freeze({ maxResolve: 5, callersPerSym: 3, calleesPerSym: 3, maxTests: 3, maxRoutes: 2, graphBudgetPct: 25 }),
  medium: Object.freeze({ maxResolve: 7, callersPerSym: 3, calleesPerSym: 3, maxTests: 4, maxRoutes: 2, graphBudgetPct: 25 }),
  large: Object.freeze({ maxResolve: 8, callersPerSym: 4, calleesPerSym: 4, maxTests: 5, maxRoutes: 3, graphBudgetPct: 30 }),
}

/**
 * Classify a workspace by indexed file count.
 * @param fileCount - number of files present in (or candidates for) the index.
 * @returns the adaptive tier governing budgets and limits.
 */
export function repoSizeTierFromFileCount(fileCount: number): RepoSizeTier {
  for (const [bound, tier] of TIER_FILE_COUNT_BOUNDS) {
    if (fileCount < bound) return tier
  }
  return 'large'
}

/**
 * Default result cap for search on this tier.
 * @param tier - repository-size class.
 * @returns default top-K (5/10/15/20).
 */
export function repoSizeTierSearchTopK(tier: RepoSizeTier): number {
  return TIER_SEARCH_TOP_K[tier]
}

/**
 * Byte cap applied to any model-facing envelope produced for this tier.
 * @param tier - repository-size class.
 * @returns maximum output characters (18000/24000/32000/38000).
 */
export function repoSizeTierMaxOutputChars(tier: RepoSizeTier): number {
  return TIER_MAX_OUTPUT_CHARS[tier]
}

/**
 * Truncate an output budget to one third of this tier's character budget; consumers embed
 * snippets inside larger envelopes and must fit with room for their wrapper metadata.
 * @param tier - repository-size class.
 * @returns maxOutputChars(tier) / 3, floored.
 */
export function repoSizeTierMaxSnippetChars(tier: RepoSizeTier): number {
  return Math.floor(TIER_MAX_OUTPUT_CHARS[tier] / 3)
}

/**
 * Graph-enrichment caps for this tier.
 * @param tier - repository-size class.
 * @returns the frozen limits table entry (resolve/caller/callee/test/route caps and the
 *   graph output-budget percentage).
 */
export function repoSizeTierGraphEnrichLimits(tier: RepoSizeTier): Readonly<GraphEnrichLimits> {
  return TIER_GRAPH_ENRICH_LIMITS[tier]
}

/**
 * Default model-facing token budget for this tier.
 * @param tier - repository-size class.
 * @returns default token budget (4000/6000/8000/12000); graph enrichment claims
 *   its `graphBudgetPct` share of this value.
 */
export function repoSizeTierTokenBudget(tier: RepoSizeTier): number {
  return TIER_TOKEN_BUDGET[tier]
}
