/**
 * Lane / preselect-layer registries — the single places to register a new
 * candidate source or scoring layer. Mirrors the reference seam
 * (`cc-search/src/lanes.rs::RetrievalLane`, `preselect.rs::PreselectLayer`).
 *
 * Registry order IS the deterministic fusion order: JS engines run lanes
 * serially in registration order, so RRF accumulation, reason emission, and
 * tie-breaking stay stable without the reference's concurrency machinery.
 *
 * @module @relay-harness/rlh-code-index-search/registry
 */

import { SearchEngineError, SEARCH_REGISTRY_INVALID } from './errors.ts'
import type { PreselectLayer, RetrievalLane } from './types.ts'

/**
 * Freeze and type a lane definition. Pass-through with identity guarantees.
 * @param lane - the lane definition to seal.
 * @returns a frozen shallow copy safe for registry assembly.
 */
export function defineRetrievalLane(lane: RetrievalLane): RetrievalLane {
  return Object.freeze({ ...lane })
}

/**
 * Freeze and type a preselect layer definition.
 * @param layer - the layer definition to seal.
 * @returns a frozen shallow copy safe for registry assembly.
 */
export function definePreselectLayer(layer: PreselectLayer): PreselectLayer {
  return Object.freeze({ ...layer })
}

/** Assembled registries: lane fusion order + preselect execution order. */
export interface RetrievalRegistry {
  readonly lanes: readonly RetrievalLane[]
  readonly layers: readonly PreselectLayer[]
}

/**
 * Validate and freeze an engine registry.
 *
 * Checks: at least one lane; unique lane ids; unique preselect layer names;
 * and at least one lane enabled at assembly time (a lane whose `isEnabled` is
 * statically always-false counts as disabled; per-request gating like grep's
 * `includeGrep` still happens at search time). Violations throw
 * {@link SearchEngineError} with code `SEARCH_REGISTRY_INVALID` so a broken
 * assembly fails loudly at engine construction, never mid-search.
 * @param lanes - lane definitions in fusion order.
 * @param layers - preselect layer definitions in execution order.
 * @returns the validated registry with every entry frozen.
 */
export function assembleRetrievalRegistry(lanes: readonly RetrievalLane[], layers: readonly PreselectLayer[]): RetrievalRegistry {
  const problems: string[] = []
  if (lanes.length === 0) {
    problems.push('at least one retrieval lane must be registered')
  }
  if (layers.length === 0) {
    problems.push('at least one preselect layer must be registered')
  }
  const laneIds = new Set<string>()
  for (const lane of lanes) {
    if (laneIds.has(lane.laneId)) {
      problems.push(`duplicate retrieval lane id '${lane.laneId}'`)
    }
    laneIds.add(lane.laneId)
    if (!isDynamicallyEnabled(lane)) problems.push(`lane '${lane.laneId}' is never enabled`)
  }
  const layerNames = new Set<string>()
  for (const layer of layers) {
    if (layerNames.has(layer.name)) {
      problems.push(`duplicate preselect layer name '${layer.name}'`)
    }
    layerNames.add(layer.name)
  }
  if (problems.length > 0) {
    throw new SearchEngineError(`invalid retrieval registry: ${problems.join('; ')}`, SEARCH_REGISTRY_INVALID)
  }
  return {
    lanes: lanes.map(lane => defineRetrievalLane(lane)),
    layers: layers.map(layer => definePreselectLayer(layer)),
  }
}

function isDynamicallyEnabled(lane: RetrievalLane): boolean {
  try {
    // Assembly-time probe against a null context: only meaningful for lanes
    // that hard-disable themselves; context-dependent gates must tolerate it.
    return lane.isEnabled(undefined as unknown as Parameters<RetrievalLane['isEnabled']>[0])
  } catch {
    return true
  }
}
