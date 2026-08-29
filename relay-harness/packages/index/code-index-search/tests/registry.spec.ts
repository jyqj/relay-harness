import { describe, expect, it } from 'vitest'
import { HarnessError } from '@relay-harness/rlh-llm'
import { DEFAULT_SEARCH_CONFIG } from '../src/config.ts'
import {
  SEARCH_REGISTRY_INVALID,
  SearchEngineError,
  SEARCH_PORT_READ_FAILED,
  SEARCH_REQUEST_INVALID,
} from '../src/errors.ts'
import { defaultPreselectLayersForEngine, defaultRetrievalLanes } from '../src/engine.ts'
import { LANE_GREP_ID, LANE_LEXICAL_ID, LANE_LITERAL_ID, LANE_VECTOR_ID } from '../src/fusion.ts'
import { LAYER_FALLBACK } from '../src/preselect.layers.ts'
import { assembleRetrievalRegistry, definePreselectLayer, defineRetrievalLane } from '../src/registry.ts'
import type { PreselectLayer, RetrievalLane } from '../src/types.ts'

function lane(over: Partial<RetrievalLane> = {}): RetrievalLane {
  return defineRetrievalLane({
    laneId: 'lexical',
    weight: () => 1,
    isEnabled: () => true,
    annotatesHits: () => true,
    scoreSlot: () => null,
    run: () => [],
    ...over,
  })
}

function layer(over: Partial<PreselectLayer> = {}): PreselectLayer {
  return definePreselectLayer({
    name: 'working-set',
    readsPriorScores: () => false,
    score: () => [],
    ...over,
  })
}

describe('errors', () => {
  it('exposes SEARCH_* codes on a HarnessError subclass', () => {
    const error = new SearchEngineError('boom', SEARCH_REQUEST_INVALID)
    expect(error).toBeInstanceOf(HarnessError)
    expect(error.code).toBe(SEARCH_REQUEST_INVALID)
    expect(error.name).toBe('SearchEngineError')
    expect(SEARCH_PORT_READ_FAILED).toBe('SEARCH_PORT_READ_FAILED')
    expect(SEARCH_REGISTRY_INVALID).toBe('SEARCH_REGISTRY_INVALID')
  })
})

describe('assembleRetrievalRegistry validation', () => {
  it('freezes definitions and preserves order on success', () => {
    const second = layer({ name: 'recent' })
    const first = layer()
    const grep = lane({ laneId: 'grep' })
    const registry = assembleRetrievalRegistry([lane(), grep], [first, second])
    expect(Object.isFrozen(registry.lanes[0])).toBe(true)
    expect(Object.isFrozen(registry.layers[0])).toBe(true)
    expect(registry.lanes.map(entry => entry.laneId)).toEqual(['lexical', 'grep'])
    expect(registry.layers.map(entry => entry.name)).toEqual(['working-set', 'recent'])
  })

  it('rejects duplicate lane ids and layer names with SEARCH_REGISTRY_INVALID', () => {
    expect(() => assembleRetrievalRegistry([lane(), lane({ run: () => [] })], [layer()])).toThrow(SearchEngineError)
    expect(() => assembleRetrievalRegistry([lane()], [layer(), layer()])).toThrow(/duplicate preselect layer name/)
  })

  it('requires at least one enabled lane and rejects empty registries', () => {
    expect(() => assembleRetrievalRegistry([], [layer()])).toThrow(/at least one retrieval lane/)
    expect(() => assembleRetrievalRegistry([lane()], [])).toThrow(/at least one preselect layer/)
    const alwaysDisabled = lane({ isEnabled: () => false })
    expect(() => assembleRetrievalRegistry([alwaysDisabled], [layer()])).toThrow(/never enabled/)
    // A context-dependent gate (like grep's includeGrep) cannot be probed and counts as enabled.
    const contextGated = lane({ isEnabled: ctx => ctx.plan.limits().topK > 0 })
    expect(assembleRetrievalRegistry([contextGated], [layer()]).lanes).toHaveLength(1)
  })
})

describe('default assembly with the graph extension slot', () => {
  // The concrete graph lane lives in the graph package (which depends on this
  // one); the composition order it plugs into is owned here and pinned with a
  // structural stand-in carrying the same id.
  const graphLane = lane({ laneId: 'graph', weight: config => config.graphWeight, annotatesHits: () => false })
  const graphNeighbor = layer({ name: 'graph-neighbor', readsPriorScores: () => true })

  it('registers the graph lane before the literal lane: lexical, grep, graph, literal', () => {
    expect(defaultRetrievalLanes().map(entry => entry.laneId)).toEqual([LANE_LEXICAL_ID, LANE_GREP_ID, LANE_LITERAL_ID])
    const withGraph = defaultRetrievalLanes(graphLane)
    expect(withGraph.map(entry => entry.laneId)).toEqual([LANE_LEXICAL_ID, LANE_GREP_ID, 'graph', LANE_LITERAL_ID])
    expect(withGraph[2]?.weight(DEFAULT_SEARCH_CONFIG)).toBe(DEFAULT_SEARCH_CONFIG.graphWeight)
    expect(withGraph[3]?.weight(DEFAULT_SEARCH_CONFIG)).toBe(DEFAULT_SEARCH_CONFIG.literalWeight)

    const registry = assembleRetrievalRegistry(withGraph, defaultPreselectLayersForEngine(graphNeighbor))
    expect(registry.lanes.map(entry => entry.laneId)).toEqual(['lexical', 'grep', 'graph', 'literal'])
  })

  it('registers a supplied vector lane after the literal lane', () => {
    const vectorLane = lane({ laneId: LANE_VECTOR_ID, weight: config => config.vectorWeight })
    const composed = defaultRetrievalLanes(graphLane, vectorLane)
    expect(composed.map(entry => entry.laneId))
      .toEqual([LANE_LEXICAL_ID, LANE_GREP_ID, 'graph', LANE_LITERAL_ID, LANE_VECTOR_ID])
    expect(composed[4]?.weight(DEFAULT_SEARCH_CONFIG)).toBe(DEFAULT_SEARCH_CONFIG.vectorWeight)
    // Omitting the vector lane leaves the four-lane set untouched.
    expect(defaultRetrievalLanes(graphLane, undefined).map(entry => entry.laneId))
      .toEqual([LANE_LEXICAL_ID, LANE_GREP_ID, 'graph', LANE_LITERAL_ID])
  })

  it('rejects a duplicate graph id while accepting the unique three-lane assembly', () => {
    expect(() => assembleRetrievalRegistry(defaultRetrievalLanes(lane({ laneId: 'lexical' })), [layer()]))
      .toThrow(/duplicate retrieval lane id 'lexical'/)
    expect(() => assembleRetrievalRegistry(defaultRetrievalLanes(graphLane), [layer()])).not.toThrow()
  })

  it('appends the graph-neighbor layer after the built-in fallback', () => {
    const names = defaultPreselectLayersForEngine(graphNeighbor).map(entry => entry.name)
    expect(names.at(-1)).toBe('graph-neighbor')
    expect(names.at(-2)).toBe(LAYER_FALLBACK)
    expect(names).toHaveLength(8)
  })
})
