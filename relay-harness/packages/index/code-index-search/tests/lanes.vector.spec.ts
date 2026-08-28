/** Vector lane: quantized-cosine rescoring of the prior-candidate pool. */

import { describe, expect, it } from 'vitest'
import { DEFAULT_RANKING_CONFIG, DEFAULT_SEARCH_CONFIG } from '../src/config.ts'
import type { SearchConfig } from '../src/types.ts'
import { createSearchEngine, defaultPreselectLayersForEngine, defaultRetrievalLanes } from '../src/engine.ts'
import { LANE_VECTOR_ID } from '../src/fusion.ts'
import { createVectorLane, runVectorLane } from '../src/lanes.vector.ts'
import { SearchPlan } from '../src/plan.ts'
import { assembleRetrievalRegistry } from '../src/registry.ts'
import { defaultPreselectLayers } from '../src/preselect.layers.ts'
import type { LaneContext, ReadErrorCollector, RetrievalLane } from '../src/types.ts'
import { InMemoryIndex } from './fake-index.ts'

const searchConfig = DEFAULT_SEARCH_CONFIG
const ranking = DEFAULT_RANKING_CONFIG
const gates = { symbolExactEnabled: false }
const queryVector = Float32Array.from([1, 0, 0])

function noReadErrors(): ReadErrorCollector {
  return { push() {} }
}

function buildContext(
  index: InMemoryIndex,
  options: {
    query?: string
    queryVector?: Float32Array
    priorCandidates?: readonly string[] | undefined
    searchConfig?: SearchConfig
    topK?: number
  } = {},
): LaneContext {
  const plan = SearchPlan.build({
    port: index,
    request: {
      query: options.query ?? 'auth',
      ...(options.topK === undefined ? {} : { topK: options.topK }),
      ...(options.queryVector === undefined ? {} : { queryVector: options.queryVector }),
    },
    searchConfig: options.searchConfig ?? searchConfig,
    ranking,
    tier: 'tiny',
  })
  return {
    port: index,
    plan,
    config: options.searchConfig ?? searchConfig,
    ranking,
    gates,
    readErrors: noReadErrors(),
    ...(options.priorCandidates === undefined ? {} : { priorCandidates: options.priorCandidates }),
  }
}

/** One-file index whose single chunk carries vectors under `fake-embed`. */
function vectorIndex(chunkVector: Float32Array): InMemoryIndex {
  const index = new InMemoryIndex()
    .addFile('src/auth.ts', 'auth handler summary')
    .addChunk({ chunkId: 'c:auth', filePath: 'src/auth.ts', startLine: 1, endLine: 2, text: 'auth handler' })
  return index.installVectors().addVector('c:auth', chunkVector)
}

/** A lane emitting `count` synthetic hits keyed by its own id, optionally repeating them. */
function bulkLane(laneId: string, count: number, uniqueEvery: number): RetrievalLane {
  return {
    laneId,
    weight: () => 1,
    isEnabled: () => true,
    annotatesHits: () => false,
    scoreSlot: () => null,
    run: () => Array.from({ length: count }, (_, position) => ({
      chunkId: `${laneId}:${String(position % uniqueEvery).padStart(6, '0')}`,
      score: 1,
    })),
  }
}

/** A lane that records the pool it was handed, contributing nothing. */
function poolSpyLane(laneId: string, observed: Array<readonly string[] | undefined>): RetrievalLane {
  return {
    laneId,
    weight: () => 0,
    isEnabled: () => true,
    annotatesHits: () => false,
    scoreSlot: () => null,
    run: (context) => {
      observed.push(context.priorCandidates)
      return []
    },
  }
}

describe('vector lane metadata and gating', () => {
  it('declares the vector slot and the configured weight', () => {
    const lane = createVectorLane({ model: 'fake-embed' })
    expect(lane.laneId).toBe(LANE_VECTOR_ID)
    expect(lane.weight(searchConfig)).toBe(searchConfig.vectorWeight)
    expect(lane.weight({ ...searchConfig, vectorWeight: 1.5 })).toBe(1.5)
    expect(lane.annotatesHits()).toBe(true)
    expect(lane.scoreSlot()).toBe('vector')
  })

  it('enables only with a vector facet and a query vector', () => {
    const lane = createVectorLane({ model: 'fake-embed' })
    const withEverything = vectorIndex(queryVector)
    expect(lane.isEnabled(buildContext(withEverything, { queryVector }))).toBe(true)
    expect(lane.isEnabled(buildContext(withEverything))).toBe(false)

    const bare = new InMemoryIndex()
      .addFile('src/auth.ts', '')
      .addChunk({ chunkId: 'c:auth', filePath: 'src/auth.ts', startLine: 1, endLine: 2, text: 'auth handler' })
    expect(lane.isEnabled(buildContext(bare, { queryVector }))).toBe(false)
  })

  it('survives the assembly-time probe with a null context', () => {
    expect(() => assembleRetrievalRegistry([createVectorLane({ model: 'fake-embed' })], defaultPreselectLayers())).not.toThrow()
  })
})

describe('runVectorLane', () => {
  it('ranks by quantized cosine, drops non-positive similarities, and cuts to the lane limit', () => {
    const index = vectorIndex(queryVector)
    index
      .addFile('src/other.ts', 'other')
      .addChunk({ chunkId: 'c:ortho', filePath: 'src/other.ts', startLine: 1, endLine: 2, text: 'other words' })
      .addChunk({ chunkId: 'c:opposite', filePath: 'src/other.ts', startLine: 3, endLine: 4, text: 'more words' })
      .addChunk({ chunkId: 'c:lesser', filePath: 'src/other.ts', startLine: 5, endLine: 6, text: 'even more words' })
    index.addVector('c:ortho', Float32Array.from([0, 1, 0]))
    index.addVector('c:opposite', Float32Array.from([-1, 0, 0]))
    index.addVector('c:lesser', Float32Array.from([0.8, 0.6, 0]))

    const lane = createVectorLane({ model: 'fake-embed' })
    const context = buildContext(index, {
      queryVector,
      priorCandidates: ['c:auth', 'c:ortho', 'c:opposite', 'c:lesser', 'c:missing'],
    })
    const hits = lane.run(context)
    expect(hits.map(hit => hit.chunkId)).toEqual(['c:auth', 'c:lesser'])
    expect(hits[0]?.score).toBeCloseTo(1, 5)
    // The lane limit is the plan's vector window: a top-K of 1 cuts to one hit.
    const cut = lane.run(buildContext(index, {
      queryVector,
      priorCandidates: ['c:auth', 'c:lesser'],
      searchConfig: { ...searchConfig, vectorTopK: 1 },
      topK: 1,
    }))
    expect(cut).toHaveLength(1)
    expect(cut[0]?.chunkId).toBe('c:auth')
  })

  it('breaks equal-similarity ties by chunk id', () => {
    const index = vectorIndex(queryVector)
    index
      .addFile('src/other.ts', 'other')
      .addChunk({ chunkId: 'c:b', filePath: 'src/other.ts', startLine: 1, endLine: 2, text: 'b words' })
      .addChunk({ chunkId: 'c:a', filePath: 'src/other.ts', startLine: 3, endLine: 4, text: 'a words' })
    index.addVector('c:b', Float32Array.from([2, 0, 0]))
    index.addVector('c:a', Float32Array.from([3, 0, 0]))
    const hits = createVectorLane({ model: 'fake-embed' }).run(
      buildContext(index, { queryVector, priorCandidates: ['c:b', 'c:a'] }),
    )
    expect(hits.map(hit => hit.chunkId)).toEqual(['c:a', 'c:b'])
  })

  it('answers nothing for another model, an empty pool, or a missing pool', () => {
    const index = vectorIndex(queryVector)
    const lane = createVectorLane({ model: 'another-model' })
    expect(lane.run(buildContext(index, { queryVector, priorCandidates: ['c:auth'] }))).toEqual([])
    expect(lane.run(buildContext(index, { queryVector, priorCandidates: [] }))).toEqual([])
    expect(lane.run(buildContext(index, { queryVector }))).toEqual([])
  })

  it('stays total without a query vector or facet (direct-call defense)', () => {
    const index = vectorIndex(queryVector)
    expect(runVectorLane(buildContext(index), 'fake-embed')).toEqual([])
    const bare = new InMemoryIndex()
      .addFile('src/auth.ts', '')
      .addChunk({ chunkId: 'c:auth', filePath: 'src/auth.ts', startLine: 1, endLine: 2, text: 'auth handler' })
    expect(runVectorLane(buildContext(bare, { queryVector, priorCandidates: ['c:auth'] }), 'fake-embed')).toEqual([])
  })
})

describe('vector lane through the engine', () => {
  it('fuses vector-ranked candidates with a vector@rank reason', () => {
    const index = vectorIndex(queryVector)
    const engine = createSearchEngine({
      port: index,
      lanes: defaultRetrievalLanes(undefined, createVectorLane({ model: 'fake-embed' })),
    })
    const result = engine.search({ query: 'auth', queryVector })
    const hit = result.hits.find(entry => entry.chunkId === 'c:auth')
    expect(hit).toBeDefined()
    expect(hit?.reasons).toContain('lexical@1')
    expect(hit?.reasons).toContain('vector@1')
    expect(result.degraded).toBe(false)
  })

  it('degrades as a whole when a stored dimension contradicts the query vector', () => {
    const index = vectorIndex(queryVector)
    const engine = createSearchEngine({
      port: index,
      lanes: defaultRetrievalLanes(undefined, createVectorLane({ model: 'fake-embed' })),
    })
    const result = engine.search({ query: 'auth', queryVector: Float32Array.from([1, 0, 0, 0]) })
    expect(result.degraded).toBe(true)
    expect(result.readErrors[0]).toMatch(/^vector lane failed .+dimension mismatch/u)
  })

  it('stays byte-identical to the four-lane engine while gating fails', () => {
    const index = vectorIndex(queryVector)
    const plain = createSearchEngine({ port: index })
    const composed = createSearchEngine({
      port: index,
      lanes: defaultRetrievalLanes(undefined, createVectorLane({ model: 'fake-embed' })),
    })
    const request = { query: 'auth' }
    expect(composed.search(request)).toEqual(plain.search(request))
  })

  it('hands each lane the deduplicated pool of its predecessors, capped at vectorMaxCandidates', () => {
    const index = vectorIndex(queryVector)
    const observed: Array<readonly string[] | undefined> = []
    const engine = createSearchEngine({
      port: index,
      lanes: [
        poolSpyLane('spy-first', observed),
        bulkLane('dupes', 4, 2),
        poolSpyLane('spy-deduped', observed),
        bulkLane('bulk', 2_500, 2_500),
        poolSpyLane('spy-capped', observed),
      ],
      layers: defaultPreselectLayersForEngine(),
    })
    engine.search({ query: 'auth', queryVector })
    expect(observed[0]).toBeUndefined()
    expect(observed[1]).toEqual(['dupes:000000', 'dupes:000001'])
    expect(observed[2]).toHaveLength(searchConfig.vectorMaxCandidates)
    // Registration-order accumulation: the early lane's ids keep their head
    // positions, and the repeated ids inside one lane collapse.
    expect(observed[2]?.[0]).toBe('dupes:000000')
    expect(observed[2]?.[1]).toBe('dupes:000001')
    expect(observed[2]?.[2]).toBe('bulk:000000')
  })
})
