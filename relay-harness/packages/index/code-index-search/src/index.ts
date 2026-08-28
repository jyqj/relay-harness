/**
 * Retrieval-domain search engine for the local code index.
 *
 * This package is the ranking brain behind `ctx.codeIndex.search()`: file
 * preselection layers, retrieval lanes (lexical FTS, grep, classified
 * literals), RRF fusion, and
 * the deterministic rerank/finalize pipeline — all pure logic over a
 * {@link RetrievalPort} implemented by an index store adapter.
 *
 * @module @relay-harness/rlh-code-index-search
 */

export {
  DEFAULT_FEATURE_GATES,
  DEFAULT_RANKING_CONFIG,
  DEFAULT_SEARCH_CONFIG,
  resolveFeatureGates,
  resolveRankingConfig,
  resolveSearchConfig,
} from './config.ts'
export { SearchEngineError } from './errors.ts'
export {
  SEARCH_PORT_READ_FAILED,
  SEARCH_REGISTRY_INVALID,
  SEARCH_REQUEST_INVALID,
} from './errors.ts'
export {
  createSearchEngine,
  defaultPreselectLayersForEngine,
  defaultRetrievalLanes,
} from './engine.ts'
export type { SearchEngineOptions } from './engine.ts'
export {
  LANE_GREP_ID,
  LANE_LEXICAL_ID,
  LANE_LITERAL_ID,
  LANE_VECTOR_ID,
  compareFusedEntries,
  fuseOutcomes,
  overlapScore,
  rankScored,
  rrfAccumulate,
} from './fusion.ts'
export { createGrepLane, grepPrefilterPhrase } from './lanes.grep.ts'
export { createLexicalLane } from './lanes.lexical.ts'
export { chunkOwningLine, createLiteralLane } from './lanes.literal.ts'
export { createVectorLane, runVectorLane } from './lanes.vector.ts'
export type { VectorLaneOptions } from './lanes.vector.ts'
export {
  LaneRanks,
  SearchPlan,
  compareStrings,
  defaultPreselectLimit,
  laneStatsOf,
  languageFromName,
  matchesKind,
  parseDslLite,
} from './plan.ts'
export type { FinalizableResult, LaneLimits, MaterializedFilters, ParsedDslLite, SearchPlanView } from './plan.ts'
export type {
  AnalysisSymbolRow,
  CalleeEdgeRow,
  CallerEdgeRow,
  ChunkDetailRow,
  ChunkScope,
  ChunkScanVisitor,
  ChunkSpanRow,
  CatalogSymbolRow,
  ExportFingerprintRow,
  FileSummaryHit,
  GraphReadFacet,
  GrepChunkRow,
  ImpactedTestRow,
  ImportRow,
  InternalImportEdgeRow,
  LexicalCandidateRow,
  LiteralCandidateRow,
  LiteralRow,
  RetrievalPort,
  StoredCallEdgeRow,
  StoredSymbolRefRow,
  SymbolDegreeRow,
  SymbolRowLite,
  SymbolSeedHit,
  SymbolTokenHit,
  VectorCoverage,
  VectorReadFacet,
  VectorRow,
} from './port.ts'
export {
  LAYER_EXPLICIT_SCOPE,
  LAYER_FALLBACK,
  LAYER_FTS_SUMMARY,
  LAYER_OVERLAY,
  LAYER_PINNED,
  LAYER_RECENT,
  LAYER_TOKEN_SEARCH,
  LAYER_WORKING_SET,
  defaultPreselectLayers,
  preselect,
} from './preselect.layers.ts'
export type { PreselectRequest } from './preselect.layers.ts'
export { assembleRetrievalRegistry, definePreselectLayer, defineRetrievalLane } from './registry.ts'
export type { RetrievalRegistry } from './registry.ts'
export { ScoreTrace, dedupeReasons, isProjectDoc, rerankCandidate } from './rerank.ts'
export type { RerankInput, RerankOutcome } from './rerank.ts'
export { expandQueryText, sanitizeFtsQuery, splitCamelCase, tokenizeCodeish } from './text.ts'
export {
  cosineQuantized,
  dequantizeInt8,
  fingerprintVector,
  quantizeInt8,
} from './vector-math.ts'
export type { QuantizedVectorInt8 } from './vector-math.ts'
export type {
  EngineSearchRequest,
  FeatureGates,
  FusedScore,
  LaneContribution,
  LaneContext,
  LaneOutcome,
  LaneRankedHit,
  LaneStats,
  LayerHit,
  PreselectContext,
  PreselectLayer,
  PreselectResult,
  RankingConfig,
  ReadErrorCollector,
  RetrievalLane,
  ScoreSlot,
  SearchConfig,
} from './types.ts'
