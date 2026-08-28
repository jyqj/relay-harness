/**
 * Shared call-edge helpers for the graph retrieval lane and the graph-neighbor
 * preselect layer: seed-partitioned edge grouping and the best-effort read
 * both expansion paths rely on.
 *
 * @module @relay-harness/rlh-code-index-graph/lane/edges
 */

import type { CallerEdgeRow } from '@relay-harness/rlh-code-index-search'

/**
 * Group edge rows by their partitioning seed uid, preserving arrival order.
 * @param rows - edge rows as returned by a per-seed facet lookup.
 * @returns the rows grouped under their `seedUid`, same order within a group.
 */
export function edgesBySeed(rows: readonly CallerEdgeRow[]): Map<string, readonly CallerEdgeRow[]> {
  const bySeed = new Map<string, CallerEdgeRow[]>()
  for (const row of rows) {
    const kept = bySeed.get(row.seedUid)
    if (kept === undefined) {
      bySeed.set(row.seedUid, [row])
    } else {
      kept.push(row)
    }
  }
  return bySeed
}

/**
 * Read one edge direction, degrading a rejection to no rows: both expansion
 * paths treat call-edge reads as best-effort, so a failing direction removes
 * only its own contribution.
 * @param read - the facet edge lookup to run.
 * @returns the rows, or an empty array when the lookup rejected.
 */
export function edgesOrEmpty(read: () => readonly CallerEdgeRow[]): readonly CallerEdgeRow[] {
  try {
    return read()
  } catch {
    // Expansion is best-effort: seed results still rank without this direction.
    return []
  }
}
