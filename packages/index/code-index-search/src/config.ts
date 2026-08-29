/**
 * Default engine and scoring configuration — every numeric constant ported
 * verbatim from the reference implementation so retrieval behavior is
 * byte-identical. `SearchConfig` mirrors `SearchConfig::default()` and
 * `RankingConfig` mirrors `RankingConfig::default()`
 * (`crates/cc-model/src/config.rs`); changing any value changes ranking in
 * every phase.
 *
 * @module @relay-harness/rlh-code-index-search/config
 */

import type { FeatureGates, RankingConfig, SearchConfig } from './types.ts'

/** Lane candidate caps / RRF weights — reference `impl Default for SearchConfig`. */
export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  lexicalTopK: 24,
  grepTopK: 12,
  grepScanCap: 20_000,
  rrfK: 50,
  lexicalWeight: 1.1,
  grepWeight: 0.8,
  graphWeight: 0.6,
  graphTopK: 12,
  literalTopK: 12,
  literalWeight: 0.9,
  vectorWeight: 0.9,
  vectorTopK: 12,
  vectorMaxCandidates: 2_000,
  rerankWindow: 40,
}

/** Rerank bonus table + preselect layer scores — reference `impl Default for RankingConfig`. */
export const DEFAULT_RANKING_CONFIG: RankingConfig = {
  graphRerankWeight: 0.3,
  overlapWeight: 0.35,
  symbolExactBonus: 0.18,
  pathPrefixBonus: 0.05,
  docFileBonus: 0.08,
  workingSetBoost: 0.22,
  recentFileBoost: 0.12,
  pinnedContextBoost: 0.2,
  overlayNeighborBoost: 0.1,
  stageAWeight: 0.04,
  stageACap: 0.25,
  dslNameBonus: 0.25,

  preselectWorkingSetFloor: 2.0,
  preselectWorkingSetScale: 5.0,
  preselectRecentFloor: 1.2,
  preselectRecentScale: 3.5,
  preselectPinnedFloor: 2.2,
  preselectPinnedScale: 4.0,
  preselectOverlayFloor: 1.5,
  preselectOverlayScale: 3.0,
  preselectFtsBase: 1.4,
  preselectSymbolExactBonus: 2.0,
  preselectSymbolFuzzyBonus: 1.2,
  preselectPathTokenBonus: 1.0,
  preselectFallbackScore: 0.2,
  preselectExplicitScopeScore: 10.0,

  graphNeighborBase: 0.8,
  graphNeighborPerEdge: 0.1,
  graphNeighborCap: 1.2,
}

/**
 * P1 feature gates. `symbolExactEnabled` is the explicit off switch for the
 * `symbol-exact` rerank bonus. It ships ON: chunk detail rows carry a symbol
 * name, so the bonus acts on real data; callers whose adapters leave names
 * `null` never hit the branch and may switch it off explicitly.
 */
export const DEFAULT_FEATURE_GATES: FeatureGates = { symbolExactEnabled: true }

/**
 * Merge a partial config over {@link DEFAULT_SEARCH_CONFIG}; absent keys fall back verbatim.
 * @param partial - caller overrides; `undefined` yields an untouched default copy.
 * @returns the fully resolved engine configuration.
 */
export function resolveSearchConfig(partial?: Partial<SearchConfig>): SearchConfig {
  return { ...DEFAULT_SEARCH_CONFIG, ...partial }
}

/**
 * Merge a partial ranking table over {@link DEFAULT_RANKING_CONFIG}.
 * @param partial - caller overrides; `undefined` yields an untouched default copy.
 * @returns the fully resolved ranking constants.
 */
export function resolveRankingConfig(partial?: Partial<RankingConfig>): RankingConfig {
  return { ...DEFAULT_RANKING_CONFIG, ...partial }
}

/**
 * Merge partial gates over {@link DEFAULT_FEATURE_GATES}.
 * @param partial - caller overrides; `undefined` yields an untouched default copy.
 * @returns the fully resolved feature gates.
 */
export function resolveFeatureGates(partial?: Partial<FeatureGates>): FeatureGates {
  return { ...DEFAULT_FEATURE_GATES, ...partial }
}
