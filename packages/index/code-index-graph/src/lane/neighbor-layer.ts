/**
 * Graph-neighbor preselect layer (layer 8): expands the candidate files by
 * 1-hop call-graph neighbors of the current top-scoring files.
 *
 * Ported from the reference implementation
 * (`crates/cc-search/src/preselect.rs:466-595`, `GraphNeighborLayer` +
 * `score_graph_neighbors`). Only fires while preselect has budget left, and
 * scores only files absent from `currentScores`, so the additive merge is
 * equivalent to the reference's insert-if-absent semantics. Every read is
 * best-effort: a rejection collapses the layer to no hits exactly like the
 * reference's `unwrap_or_default` swallowing.
 *
 * Scores come from `RankingConfig`: first sighting `graphNeighborBase`
 * (default 0.8, clamped to the cap), each further sighting of the same file
 * adds `graphNeighborPerEdge` (default 0.1) capped at `graphNeighborCap`
 * (default 1.2).
 *
 * @module @relay-harness/rlh-code-index-graph/lane/neighbor-layer
 */

import { definePreselectLayer } from '@relay-harness/rlh-code-index-search'
import type {
  LayerHit,
  PreselectContext,
  PreselectLayer,
} from '@relay-harness/rlh-code-index-search'
import { edgesBySeed, edgesOrEmpty } from './edges.ts'

/** Stable layer name (the reference's `LAYER_GRAPH_NEIGHBOR`). */
export const LAYER_GRAPH_NEIGHBOR = 'graph-neighbor'

/** Seed files taken from the current scores, best-first. */
const SEED_FILES = 20
/** Symbol uids pulled from the seed files. */
const SEED_UIDS = 50
/** Per-direction edge fetch cap. */
const EDGE_ROWS_PER_SEED = 5
/** Callee uids resolved to files in one batch. */
const CALLEE_UID_CAP = 100

/**
 * Score the graph neighbors of the current top-scoring files.
 * @param ctx - preselect context with the port facet, current scores, budget, and ranking.
 * @returns neighbor file hits, best-first, cut to the remaining budget.
 */
function scoreGraphNeighbors(ctx: PreselectContext): LayerHit[] {
  const budget = ctx.limit - ctx.currentScores.size
  if (budget <= 0 || ctx.currentScores.size === 0) {
    return []
  }

  const seedFiles = [...ctx.currentScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEED_FILES)
    .map(([filePath]) => filePath)

  const seedUids: string[] = []
  for (const symbol of ctx.port.graph.symbolsByFilePaths(seedFiles)) {
    if (symbol.symbolUid === null) continue
    seedUids.push(symbol.symbolUid)
    if (seedUids.length >= SEED_UIDS) break
  }
  if (seedUids.length === 0) {
    return []
  }

  const accumCap = ctx.ranking.graphNeighborCap
  const edgeIncrement = ctx.ranking.graphNeighborPerEdge
  const neighborBase = Math.min(ctx.ranking.graphNeighborBase, accumCap)
  const neighbors = new Map<string, number>()
  const sight = (file: string): void => {
    const existing = neighbors.get(file)
    if (existing === undefined) {
      neighbors.set(file, neighborBase)
    } else {
      neighbors.set(file, Math.min(existing + edgeIncrement, accumCap))
    }
  }

  // Callers: rows where the seeds are the callees; the caller's file declares
  // the edge, so its `filePath` is the neighbor file.
  const callersBySeed = edgesBySeed(edgesOrEmpty(() => ctx.port.graph.calleeRowsByUids(seedUids, EDGE_ROWS_PER_SEED)))
  for (const uid of seedUids) {
    for (const edge of callersBySeed.get(uid) ?? []) {
      if (!ctx.currentScores.has(edge.filePath)) {
        sight(edge.filePath)
      }
    }
  }

  // Callees: rows where the seeds are the callers; the callee uids batch-
  // resolve to symbol rows whose files are the neighbor files. The batch
  // resolution is its own best-effort step (the reference's `if let Ok`).
  const calleeUids = edgesOrEmpty(() => ctx.port.graph.callerRowsByUids(seedUids, EDGE_ROWS_PER_SEED))
    .map(edge => edge.calleeSymbolUid)
    .filter((uid): uid is string => uid !== null)
  if (calleeUids.length > 0) {
    const resolved = [...new Set(calleeUids)].sort().slice(0, CALLEE_UID_CAP)
    try {
      for (const row of ctx.port.graph.symbolRowsByUids(resolved)) {
        if (!ctx.currentScores.has(row.filePath)) {
          sight(row.filePath)
        }
      }
    } catch {
      // Callee-side expansion degrades to nothing; caller-side hits survive.
    }
  }

  return [...neighbors.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, budget)
    .map(([filePath, score]) => ({ filePath, score, reason: LAYER_GRAPH_NEIGHBOR }))
}

/**
 * The graph-neighbor preselect layer, appended after the built-in fallback
 * layer by composed engine assemblies.
 * @returns the frozen layer definition reading prior scores (the seed gate
 * and the absent-file filter both consume `currentScores`). Any read failure
 * collapses the layer to no hits — expansion is best-effort, never fatal.
 */
export const createGraphNeighborLayer = (): PreselectLayer =>
  definePreselectLayer({
    name: LAYER_GRAPH_NEIGHBOR,
    readsPriorScores: () => true,
    score: (ctx) => {
      try {
        return scoreGraphNeighbors(ctx)
      } catch {
        // The reference's `unwrap_or_default`: a failed expansion adds nothing.
        return []
      }
    },
  })
