/**
 * Composed engine defaults with the graph retrieval pieces registered.
 *
 * The search package owns the deterministic registration order (lexical →
 * grep → graph → literal → vector; built-in layers with graph-neighbor
 * appended after fallback) through the optional-extension parameters of
 * `defaultRetrievalLanes` / `defaultPreselectLayersForEngine`; this module
 * supplies the concrete graph pieces and forwards an optional vector lane
 * instance (capability-probed: the deployment constructs one only when it
 * runs an embedding tier). The direction is one-way — graph depends on
 * search — because the workspace dependency graph forbids the reverse edge.
 *
 * Engines built from the plain search defaults stay byte-identical to their
 * pre-graph behavior: with no graph rows the lane contributes nothing (no
 * hits, no reasons) and the layer scores no files.
 *
 * @module @relay-harness/rlh-code-index-graph/lane/defaults
 */

import {
  defaultPreselectLayersForEngine,
  defaultRetrievalLanes,
} from '@relay-harness/rlh-code-index-search'
import type { PreselectLayer, RetrievalLane } from '@relay-harness/rlh-code-index-search'
import { createGraphLane } from './graph-lane.ts'
import { createGraphNeighborLayer } from './neighbor-layer.ts'

/**
 * The engine's default lanes with the graph lane registered in its reserved
 * position and an optional vector lane last.
 * @param vectorLane - the vector lane to register last (constructed by the
 * deployment that runs an embedding tier), or omitted for the four-lane set.
 * @returns the lane list in fusion order: lexical, grep, graph, literal, vector.
 */
export function defaultRetrievalLanesWithGraph(vectorLane?: RetrievalLane): RetrievalLane[] {
  return defaultRetrievalLanes(createGraphLane(), vectorLane)
}

/**
 * The engine's default preselect layers with the graph-neighbor layer
 * appended after the built-in fallback.
 * @returns the layer list in execution order, `graph-neighbor` last.
 */
export function defaultPreselectLayersWithGraphNeighbor(): PreselectLayer[] {
  return defaultPreselectLayersForEngine(createGraphNeighborLayer())
}
