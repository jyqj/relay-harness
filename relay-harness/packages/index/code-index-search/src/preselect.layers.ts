/**
 * File preselection — narrows candidate files before chunk-level search.
 *
 * Ported from the reference implementation (`crates/cc-search/src/preselect.rs`)
 * as a layer registry plus a uniform fold:
 *
 * Layers, in registry (= execution) order; constants live in `RankingConfig`,
 * defaults from `crates/cc-model/src/config.rs`:
 *   1. working-set boost   max(2.0, 5.0 / rank)
 *   2. recent files        max(1.2, 3.5 / rank)
 *   3. pinned files        max(2.2, 4.0 / rank)
 *   4. overlay (dirty)     max(1.5, 3.0 / rank)
 *   5. FTS summary search  1.4 + 1.0 / (1.0 + |score|)
 *   6. per-token           symbol match (exact=2.0, fuzzy=1.2) + path token hit (1.0)
 *   F. fallback            recently-indexed files (0.2), gated on zero prior scores
 *   8. graph-neighbor      composed on top by `@relay-harness/rlh-code-index-graph`
 *                          (`createGraphNeighborLayer`); this package cannot
 *                          register it in the built-in list because the graph
 *                          package depends on this one. The fold runs whatever
 *                          list `PreselectRequest.layers` carries, and the
 *                          engine threads its validated layer registry through,
 *                          so composition and execution cannot disagree.
 *
 * Rust concurrency groups (`reads_prior_scores`) collapse into plain serial
 * iteration here: JS execution is already serial and registry order IS the
 * merge order, producing byte-identical scores/reasons/bills.
 *
 * @module @relay-harness/rlh-code-index-search/preselect.layers
 */

import { compareStrings, sanitizeFtsQuery, tokenizeCodeish } from './text.ts'
import type { RetrievalPort } from './port.ts'
import type { LayerHit, PreselectContext, PreselectLayer, PreselectResult } from './types.ts'

/** Layer name for the working-set rank-decay layer (layer 1). */
export const LAYER_WORKING_SET = 'working-set'
/** Layer name for the recent-files rank-decay layer (layer 2). */
export const LAYER_RECENT = 'recent'
/** Layer name for the pinned-files rank-decay layer (layer 3). */
export const LAYER_PINNED = 'pinned'
/** Layer name for the overlay (dirty-buffer) rank-decay layer (layer 4). */
export const LAYER_OVERLAY = 'dirty-buffer'
/** Layer name for the FTS file-summary layer (layer 5). */
export const LAYER_FTS_SUMMARY = 'fts-summary'
/** Layer name for the per-token symbol/path layer (layer 6). */
export const LAYER_TOKEN_SEARCH = 'token-search'
/** Layer name for the gated fallback layer (recently-indexed files). */
export const LAYER_FALLBACK = 'fallback-indexed'
/** Pseudo-layer name used by the explicit-scope short circuit. */
export const LAYER_EXPLICIT_SCOPE = 'explicit-scope'

/** Which context path list a {@link RankDecayLayer} instance scores. */
type RankDecaySource = 'workingSet' | 'recent' | 'pinned' | 'overlay'

interface RankDecayLayerDef extends PreselectLayer {
  readonly source: RankDecaySource
}

const RANK_DECAY_PATHS: Record<RankDecaySource, (ctx: PreselectContext) => readonly string[] | null> = {
  workingSet: ctx => ctx.boostFilePaths,
  recent: ctx => ctx.recentFilePaths,
  pinned: ctx => ctx.pinnedFilePaths,
  overlay: ctx => ctx.overlayFilePaths,
}

const RANK_DECAY_PARAMS: Record<RankDecaySource, (ranking: PreselectContext['ranking']) => readonly [number, number]> = {
  workingSet: ranking => [ranking.preselectWorkingSetFloor, ranking.preselectWorkingSetScale],
  recent: ranking => [ranking.preselectRecentFloor, ranking.preselectRecentScale],
  pinned: ranking => [ranking.preselectPinnedFloor, ranking.preselectPinnedScale],
  overlay: ranking => [ranking.preselectOverlayFloor, ranking.preselectOverlayScale],
}

const RANK_DECAY_NAMES: Record<RankDecaySource, string> = {
  workingSet: LAYER_WORKING_SET,
  recent: LAYER_RECENT,
  pinned: LAYER_PINNED,
  overlay: LAYER_OVERLAY,
}

/**
 * Layers 1-4 (working-set / recent / pinned / overlay) share the shape
 * `max(floor, scale / rank)`; one factory, four registry instances.
 */
function defineRankDecayLayer(source: RankDecaySource): RankDecayLayerDef {
  return {
    source,
    name: RANK_DECAY_NAMES[source],
    readsPriorScores: () => false,
    score(ctx) {
      const paths = RANK_DECAY_PATHS[source](ctx)
      if (paths === null) return []
      const [floor, scale] = RANK_DECAY_PARAMS[source](ctx.ranking)
      return paths.map((filePath, rank) => ({
        filePath,
        score: Math.max(floor, scale / (rank + 1)),
        reason: this.name,
      }))
    },
  }
}

/** Layer 5: FTS summary search over `files_fts`. */
const FTS_SUMMARY_LAYER: PreselectLayer = {
  name: LAYER_FTS_SUMMARY,
  readsPriorScores: () => false,
  score(ctx): LayerHit[] {
    const ftsQuery = sanitizeFtsQuery(ctx.query)
    if (ftsQuery === '""' || ftsQuery.length === 0) {
      return []
    }
    const ftsLimit = ctx.limit <= 120
      ? Math.min(ctx.limit, 80)
      : 80 + Math.floor((ctx.limit - 120) / 3)
    let rows
    try {
      rows = ctx.port.ftsFileSummaries(ftsQuery, ctx.pathPrefix, ftsLimit)
    } catch {
      // Recoverable DB failure: swallow like the reference's warn-and-return-empty layers.
      return []
    }
    return rows.map(row => ({
      filePath: row.filePath,
      score: ctx.ranking.preselectFtsBase + 1 / (1 + Math.abs(row.rawScore)),
      reason: LAYER_FTS_SUMMARY,
    }))
  },
}

/**
 * Layer 6: per-token symbol-name match (exact=2.0, fuzzy=1.2) + path token
 * hit (1.0). Tokens of length ≥ 3 only, first 8; both lookups run per token
 * against substring (trigram/mirror) lookups so mid-identifier tokens recall.
 */
const TOKEN_SEARCH_LAYER: PreselectLayer = {
  name: LAYER_TOKEN_SEARCH,
  readsPriorScores: () => false,
  score(ctx): LayerHit[] {
    const queryTokens = tokenizeCodeish(ctx.query)
    const candidateTokens = queryTokens.filter(token => token.length >= 3).slice(0, 8)
    if (candidateTokens.length === 0) return []

    const hits: LayerHit[] = []
    for (const token of candidateTokens) {
      let filePaths: readonly string[]
      try {
        filePaths = ctx.port.filePathCandidatesBySubstring(token, ctx.pathPrefix, 20)
      } catch {
        continue
      }
      for (const filePath of filePaths) {
        hits.push({ filePath, score: ctx.ranking.preselectPathTokenBonus, reason: `path-token:${token}` })
      }
    }
    for (const token of candidateTokens) {
      let symbolHits
      try {
        symbolHits = ctx.port.symbolNamesByTokenSubstring(token, ctx.pathPrefix, 24)
      } catch {
        continue
      }
      for (const { filePath, name } of symbolHits) {
        const bonus = name.toLowerCase() === token
          ? ctx.ranking.preselectSymbolExactBonus
          : ctx.ranking.preselectSymbolFuzzyBonus
        hits.push({ filePath, score: bonus, reason: `symbol:${name}` })
      }
    }
    return hits
  },
}

/**
 * Gated fallback layer: recently-indexed files when nothing scored. Fires iff
 * every layer before it produced zero scores (read off `currentScores`).
 */
const FALLBACK_LAYER: PreselectLayer = {
  name: LAYER_FALLBACK,
  readsPriorScores: () => true,
  score(ctx): LayerHit[] {
    if (ctx.currentScores.size > 0) return []
    let filePaths: readonly string[]
    try {
      filePaths = ctx.port.recentIndexedFiles(ctx.limit)
    } catch {
      return []
    }
    return filePaths.map(filePath => ({ filePath, score: ctx.ranking.preselectFallbackScore, reason: LAYER_FALLBACK }))
  },
}

/**
 * The preselect layer registry — the single place to register a new built-in
 * layer. Order is the execution order and must be preserved: the fallback
 * layer's gate reads the scores of layers 1-6. Composition-time layers (the
 * graph package's graph-neighbor layer) join through `PreselectRequest.layers`
 * / `defaultPreselectLayersForEngine`, never by mutating this list.
 * @returns the frozen built-in layers in execution order (rank-decay 1-4, FTS, token-search, fallback).
 */
export function defaultPreselectLayers(): PreselectLayer[] {
  return [
    defineRankDecayLayer('workingSet'),
    defineRankDecayLayer('recent'),
    defineRankDecayLayer('pinned'),
    defineRankDecayLayer('overlay'),
    FTS_SUMMARY_LAYER,
    TOKEN_SEARCH_LAYER,
    FALLBACK_LAYER,
  ]
}

/** Request bundle for the preselect fold. */
export interface PreselectRequest {
  readonly port: RetrievalPort
  readonly query: string
  readonly pathPrefix: string | null
  readonly boostFilePaths: readonly string[] | null
  readonly recentFilePaths: readonly string[] | null
  readonly pinnedFilePaths: readonly string[] | null
  readonly overlayFilePaths: readonly string[] | null
  /** Explicit caller file scope: short-circuits the whole fold when non-empty. */
  readonly explicitFilePaths: readonly string[] | null
  readonly limit: number
  readonly ranking: PreselectContext['ranking']
  /**
   * Layer set the fold executes, in execution order; absent means the built-in
   * layers. Extended assemblies (the graph package's graph-neighbor layer)
   * pass their composed list here so the fold and the engine registry can
   * never disagree.
   */
  readonly layers?: readonly PreselectLayer[]
}

/** One candidate file's accumulated state across all layers. */
interface AccumulatedFile {
  score: number
  /** Reason tokens in emission order; deduplicated only when finalized. */
  readonly reasons: string[]
  /** Per-layer bill `[layer name, aggregated total]`, same-layer entries merged. */
  readonly bill: Array<[string, number]>
}

function emptyAccumulation(): AccumulatedFile {
  return { score: 0, reasons: [], bill: [] }
}

/**
 * Merge one {@link LayerHit} into the accumulated record: backslashes
 * normalize to slashes, scores accumulate additively, every hit appends its
 * reason (deduplicated by the driver at the end), and same-layer bill
 * contributions aggregate into one entry.
 */
function mergeLayerHit(record: AccumulatedFile, layerName: string, hit: LayerHit): void {
  record.score += hit.score
  record.reasons.push(hit.reason)
  const lastEntry = record.bill.at(-1)
  if (lastEntry !== undefined && lastEntry[0] === layerName) {
    lastEntry[1] += hit.score
  } else {
    record.bill.push([layerName, hit.score])
  }
}

/**
 * Run the preselect fold: explicit scopes short-circuit; otherwise every
 * registered layer merges its hits in order, then results are prefix-filtered,
 * sorted (score desc, path asc), truncated to the limit, and their reasons
 * deduplicated.
 * @param req - the request bundle: port, query, scope paths, limit, ranking constants.
 * @returns per-file scores, reason tokens, and per-layer bills, plus the fold's `LaneStats`.
 */
export function preselect(req: PreselectRequest): PreselectResult {
  if (req.explicitFilePaths !== null && req.explicitFilePaths.length > 0) {
    const explicitScore = req.ranking.preselectExplicitScopeScore
    const files = [...req.explicitFilePaths]
    return {
      files,
      scores: new Map(files.map(file => [file, explicitScore])),
      reasons: new Map(files.map(file => [file, [LAYER_EXPLICIT_SCOPE]])),
      laneStats: { ftsHits: 0, tokenHits: 0, usedFallback: false },
      layerScores: new Map(files.map(file => [file, [[LAYER_EXPLICIT_SCOPE, explicitScore]]])),
    }
  }

  const files_ = new Map<string, AccumulatedFile>()
  let ftsHits = 0
  let tokenHits = 0
  let usedFallback = false

  const ctxFor = (currentScores: ReadonlyMap<string, number>): PreselectContext => ({
    port: req.port,
    query: req.query,
    pathPrefix: req.pathPrefix,
    limit: req.limit,
    ranking: req.ranking,
    boostFilePaths: req.boostFilePaths,
    recentFilePaths: req.recentFilePaths,
    pinnedFilePaths: req.pinnedFilePaths,
    overlayFilePaths: req.overlayFilePaths,
    currentScores,
  })

  for (const layer of req.layers ?? defaultPreselectLayers()) {
    // Driver mirror of the fallback gate: record that fallback fired even if
    // its DB query then returns nothing (historical semantics).
    if (layer.name === LAYER_FALLBACK && files_.size === 0) {
      usedFallback = true
    }
    const hits = layer.score(ctxFor(currentScoresView(files_)))
    if (layer.name === LAYER_FTS_SUMMARY) ftsHits = hits.length
    if (layer.name === LAYER_TOKEN_SEARCH) tokenHits = hits.length
    for (const hit of hits) {
      const normalized = hit.filePath.replaceAll('\\', '/')
      let record = files_.get(normalized)
      if (record === undefined) {
        record = emptyAccumulation()
        files_.set(normalized, record)
      }
      mergeLayerHit(record, layer.name, hit)
    }
  }

  const filtered = [...files_.entries()]
    .filter(([path]) => req.pathPrefix === null || path.startsWith(req.pathPrefix))
    .sort((a, b) =>
      (b[1].score - a[1].score) !== 0 ? b[1].score - a[1].score : compareStrings(a[0], b[0]),
    )
    .slice(0, req.limit)

  const files = filtered.map(([path]) => path)
  const finalReasons = new Map<string, readonly string[]>()
  const finalBills = new Map<string, readonly (readonly [string, number])[]>()
  for (const [file, record] of filtered) {
    finalReasons.set(file, dedupePreservingOrder(record.reasons))
    finalBills.set(file, record.bill)
  }

  return {
    files,
    scores: new Map(filtered.map(([file, record]) => [file, record.score])),
    reasons: finalReasons,
    laneStats: { ftsHits, tokenHits, usedFallback },
    layerScores: finalBills,
  }
}

/** Read-only projection handed to layers as "prior scores" without exposing mutable records. */
function currentScoresView(records: ReadonlyMap<string, AccumulatedFile>): ReadonlyMap<string, number> {
  const view = new Map<string, number>()
  for (const [path, record] of records) {
    view.set(path, record.score)
  }
  return view
}

function dedupePreservingOrder(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value)
      result.push(value)
    }
  }
  return result
}
