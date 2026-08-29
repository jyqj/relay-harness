/** Graph-aware search contract: boost application, single final sort, top-K, and the epoch-pair result cache. */

import { describe, expect, it } from 'vitest'
import type { SearchHit, SearchResult } from '@relay-harness/rlh-code-index'
import type { GraphEnrichLimits } from '@relay-harness/rlh-code-index'
import { DEFAULT_RANKING_CONFIG } from '@relay-harness/rlh-code-index-search'
import type { EngineSearchRequest } from '@relay-harness/rlh-code-index-search'
import { createSearchEngine } from '@relay-harness/rlh-code-index-search'
import {
  DEFAULT_GRAPH_RESULT_CACHE_CAPACITY,
  GRAPH_RERANK_REASON,
  createGraphResultCache,
  searchWithGraphContext,
} from '../../src/lane/engine.ts'
import type { GraphSearchOutcome } from '../../src/lane/engine.ts'
import { defaultPreselectLayersWithGraphNeighbor, defaultRetrievalLanesWithGraph } from '../../src/lane/defaults.ts'
import { FixturePort, edge, symbol } from './port-fixture.ts'

const LIMITS: GraphEnrichLimits = {
  maxResolve: 10,
  callersPerSym: 5,
  calleesPerSym: 5,
  maxTests: 5,
  maxRoutes: 1,
  graphBudgetPct: 50,
}

let hitSeq = 0
function fakeHit(score: number, filePath: string, overrides: Partial<SearchHit> = {}): SearchHit {
  hitSeq++
  return {
    chunkId: `chunk:${filePath}:${hitSeq}`,
    filePath,
    language: 'typescript',
    contentHash: `hash:${filePath}`,
    startLine: 1,
    endLine: 2,
    score,
    rank: hitSeq,
    reasons: ['lexical@1'],
    scoreTrace: [{ label: 'rrf:lexical', value: score }],
    parserTier: 'generic',
    parserConfidence: 0,
    ...overrides,
  }
}

function fakeResult(hits: readonly SearchHit[], overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    query: 'q',
    tier: 'tiny',
    hits,
    candidateCount: hits.length,
    epochs: { indexEpoch: 1, evidenceEpoch: 0 },
    truncated: false,
    degraded: false,
    readErrors: [],
    ...overrides,
  }
}

/** Fixture port with one resolvable symbol on `src/b.ts` and facet read counters. */
function wiredPort(): { port: FixturePort; reads: () => number } {
  const port = new FixturePort()
  port
    .addSymbol(symbol({ name: 'hub', filePath: 'src/b.ts' }))
    // Maxed-out degree so the score hits the 0.4 cap and the boost is visible.
    .addDegree({ symbolUid: 'uid:hub', inDegree: 99, outDegree: 99, refCount: 0 })
  let facetReads = 0
  const facet = port.graph as unknown as Record<string, unknown>
  const original = port.graph.symbolsByFilePaths.bind(port.graph)
  facet.symbolsByFilePaths = (files: readonly string[]) => {
    facetReads++
    return original(files)
  }
  return { port, reads: () => facetReads }
}

describe('searchWithGraphContext ranking', () => {
  it('folds the graph score into the hit with the ranking weight and reason token', () => {
    const { port } = wiredPort()
    const enriched = fakeHit(0.9, 'src/b.ts')
    const plain = fakeHit(1.0, 'src/a.ts')
    const outcome = searchWithGraphContext({
      engine: { search: () => fakeResult([plain, enriched]) },
      port,
      request: { query: 'q' },
      epochs: { indexEpoch: 1, evidenceEpoch: 0 },
      limits: LIMITS,
      tokenBudget: 6_000,
    })
    const boosted = outcome.result.hits.find(hit => hit.filePath === 'src/b.ts')
    expect(boosted?.graphScore).toBe(0.4)
    expect(boosted?.score).toBeCloseTo(0.9 + 0.4 * DEFAULT_RANKING_CONFIG.graphRerankWeight, 12)
    expect(boosted?.reasons.at(-1)).toBe(GRAPH_RERANK_REASON)
    // The unassigned hit passes through untouched.
    const untouched = outcome.result.hits.find(hit => hit.filePath === 'src/a.ts')
    expect(untouched?.graphScore).toBeUndefined()
    expect(untouched?.reasons).not.toContain(GRAPH_RERANK_REASON)
    expect(outcome.enrichment.symbolsResolved).toBe(1)
  })

  it('runs the single final sort after the boost and reassigns ranks', () => {
    const { port } = wiredPort()
    const leader = fakeHit(1.0, 'src/a.ts')
    const trailer = fakeHit(0.9, 'src/b.ts')
    const outcome = searchWithGraphContext({
      engine: { search: () => fakeResult([leader, trailer]) },
      port,
      request: { query: 'q' },
      epochs: { indexEpoch: 1, evidenceEpoch: 0 },
      limits: LIMITS,
      tokenBudget: 6_000,
    })
    expect(outcome.result.hits.map(hit => hit.filePath)).toEqual(['src/b.ts', 'src/a.ts'])
    expect(outcome.result.hits.map(hit => hit.rank)).toEqual([1, 2])
  })

  it('breaks score ties deterministically by chunk id', () => {
    const late = fakeHit(0.5, 'src/b.ts', { chunkId: 'chunk:src/b.ts:9', rank: 1 })
    const early = fakeHit(0.5, 'src/a.ts', { chunkId: 'chunk:src/a.ts:9', rank: 2 })
    const outcome = searchWithGraphContext({
      engine: { search: () => fakeResult([late, early]) },
      port: new FixturePort(),
      request: { query: 'q' },
      epochs: { indexEpoch: 1, evidenceEpoch: 0 },
      limits: LIMITS,
      tokenBudget: 6_000,
    })
    // Equal scores fall through to the chunk-id tie-breaker, then ranks reseat.
    expect(outcome.result.hits.map(hit => hit.chunkId)).toEqual(['chunk:src/a.ts:9', 'chunk:src/b.ts:9'])
    expect(outcome.result.hits.map(hit => hit.rank)).toEqual([1, 2])
  })

  it('passes an unassigned hit list through with original ranks and identity', () => {
    const plainA = fakeHit(1.0, 'src/a.ts', { rank: 1 })
    const plainB = fakeHit(0.5, 'src/c.ts', { rank: 2 })
    const outcome = searchWithGraphContext({
      engine: { search: () => fakeResult([plainA, plainB]) },
      port: new FixturePort(),
      request: { query: 'q' },
      epochs: { indexEpoch: 1, evidenceEpoch: 0 },
      limits: LIMITS,
      tokenBudget: 6_000,
    })
    // Order and rank are unchanged, so the hit objects pass through untouched.
    expect(outcome.result.hits[0]).toBe(plainA)
    expect(outcome.result.hits[1]).toBe(plainB)
  })

  it('keeps a zero graph score without boost or reason token', () => {
    const port = new FixturePort()
    port.addSymbol(symbol({ name: 'lonely', filePath: 'src/b.ts' }))
    const hit = fakeHit(0.5, 'src/b.ts')
    const outcome = searchWithGraphContext({
      engine: { search: () => fakeResult([hit]) },
      port,
      request: { query: 'q' },
      epochs: { indexEpoch: 1, evidenceEpoch: 0 },
      limits: LIMITS,
      tokenBudget: 6_000,
    })
    expect(outcome.result.hits[0]?.graphScore).toBe(0)
    expect(outcome.result.hits[0]?.score).toBe(0.5)
    expect(outcome.result.hits[0]?.reasons).not.toContain(GRAPH_RERANK_REASON)
  })

  it('merges base and enrichment read errors into degraded', () => {
    const { port } = wiredPort()
    ;(port.graph as unknown as Record<string, unknown>).symbolsByFilePaths = () => {
      throw new Error('mirror offline')
    }
    const outcome = searchWithGraphContext({
      engine: { search: () => fakeResult([fakeHit(1, 'src/b.ts')], { readErrors: ['lexical lane failed (x); contributed nothing'], degraded: true }) },
      port,
      request: { query: 'q' },
      epochs: { indexEpoch: 1, evidenceEpoch: 0 },
      limits: LIMITS,
      tokenBudget: 6_000,
    })
    expect(outcome.result.degraded).toBe(true)
    expect(outcome.result.readErrors).toEqual([
      'lexical lane failed (x); contributed nothing',
      'symbols_by_file_paths: Error: mirror offline',
    ])
  })
})

describe('searchWithGraphContext top-K', () => {
  const seven = (): SearchResult => fakeResult([
    fakeHit(7, 'src/a.ts'),
    fakeHit(6, 'src/b.ts'),
    fakeHit(5, 'src/c.ts'),
    fakeHit(4, 'src/d.ts'),
    fakeHit(3, 'src/e.ts'),
    fakeHit(2, 'src/f.ts'),
    fakeHit(1, 'src/g.ts'),
  ])

  it('defaults the cut to the tier top-K when the request omits it', () => {
    const outcome = searchWithGraphContext({
      engine: { search: () => seven() },
      port: new FixturePort(),
      request: { query: 'q' },
      epochs: { indexEpoch: 0, evidenceEpoch: 0 },
      limits: LIMITS,
      tokenBudget: 6_000,
    })
    expect(outcome.result.tier).toBe('tiny')
    expect(outcome.result.hits).toHaveLength(5)
  })

  it('maps a zero top-K to 10', () => {
    const outcome = searchWithGraphContext({
      engine: { search: () => seven() },
      port: new FixturePort(),
      request: { query: 'q', topK: 0 },
      epochs: { indexEpoch: 0, evidenceEpoch: 0 },
      limits: LIMITS,
      tokenBudget: 6_000,
    })
    expect(outcome.result.hits).toHaveLength(7)
  })

  it('honors a positive top-K', () => {
    const outcome = searchWithGraphContext({
      engine: { search: () => seven() },
      port: new FixturePort(),
      request: { query: 'q', topK: 3 },
      epochs: { indexEpoch: 0, evidenceEpoch: 0 },
      limits: LIMITS,
      tokenBudget: 6_000,
    })
    expect(outcome.result.hits).toHaveLength(3)
    expect(outcome.result.hits.map(hit => hit.rank)).toEqual([1, 2, 3])
  })
})

describe('graph result cache', () => {
  it('serves the identical outcome on a repeat call without engine or facet reads', () => {
    const { port, reads } = wiredPort()
    let engineCalls = 0
    const input = {
      engine: { search: (): SearchResult => { engineCalls++; return fakeResult([fakeHit(1, 'src/b.ts')]) } },
      port,
      request: { query: 'q' } satisfies EngineSearchRequest,
      epochs: { indexEpoch: 3, evidenceEpoch: 0 },
      limits: LIMITS,
      tokenBudget: 6_000,
    }
    const cache = createGraphResultCache()
    const first = searchWithGraphContext({ ...input, cache })
    const second = searchWithGraphContext({ ...input, cache })
    expect(engineCalls).toBe(1)
    expect(reads()).toBe(1)
    expect(second).toBe(first)
  })

  it('misses when either epoch moves', () => {
    const { port } = wiredPort()
    let engineCalls = 0
    const input = {
      engine: { search: (): SearchResult => { engineCalls++; return fakeResult([fakeHit(1, 'src/b.ts')]) } },
      port,
      request: { query: 'q' } satisfies EngineSearchRequest,
      epochs: { indexEpoch: 1, evidenceEpoch: 0 },
      limits: LIMITS,
      tokenBudget: 6_000,
    }
    const cache = createGraphResultCache()
    const first = searchWithGraphContext({ ...input, cache })
    const bumped = searchWithGraphContext({ ...input, epochs: { indexEpoch: 2, evidenceEpoch: 0 }, cache })
    expect(bumped).not.toBe(first)
    expect(engineCalls).toBe(2)
    const evidence = searchWithGraphContext({ ...input, epochs: { indexEpoch: 2, evidenceEpoch: 1 }, cache })
    expect(evidence).not.toBe(bumped)
    expect(engineCalls).toBe(3)
  })

  it('misses on limit, token budget, or ranking changes and keeps the original entries', () => {
    const { port } = wiredPort()
    let engineCalls = 0
    const input = {
      engine: { search: (): SearchResult => { engineCalls++; return fakeResult([fakeHit(1, 'src/b.ts')]) } },
      port,
      request: { query: 'q' } satisfies EngineSearchRequest,
      epochs: { indexEpoch: 1, evidenceEpoch: 0 },
      limits: LIMITS,
      tokenBudget: 6_000,
    }
    const cache = createGraphResultCache()
    const base = searchWithGraphContext({ ...input, cache })
    const otherLimits = searchWithGraphContext({ ...input, limits: { ...LIMITS, callersPerSym: 6 }, cache })
    const otherBudget = searchWithGraphContext({ ...input, tokenBudget: 8_000, cache })
    const otherRanking = searchWithGraphContext({ ...input, ranking: { graphRerankWeight: 0.9 }, cache })
    expect(otherLimits).not.toBe(base)
    expect(otherBudget).not.toBe(base)
    expect(otherRanking).not.toBe(base)
    expect(engineCalls).toBe(4)
    expect(searchWithGraphContext({ ...input, cache })).toBe(base)
    expect(engineCalls).toBe(4)
  })

  it('never caches a degraded outcome so the next call retries the reads', () => {
    const port = new FixturePort()
    let facetReads = 0
    ;(port.graph as unknown as Record<string, unknown>).symbolsByFilePaths = () => {
      facetReads++
      throw new Error('mirror offline')
    }
    let engineCalls = 0
    const input = {
      engine: { search: (): SearchResult => { engineCalls++; return fakeResult([fakeHit(1, 'src/b.ts')]) } },
      port,
      request: { query: 'q' } satisfies EngineSearchRequest,
      epochs: { indexEpoch: 1, evidenceEpoch: 0 },
      limits: LIMITS,
      tokenBudget: 6_000,
    }
    const cache = createGraphResultCache()
    const first = searchWithGraphContext({ ...input, cache })
    expect(first.result.readErrors.join('\n')).toContain('symbols_by_file_paths')
    expect(cache.size).toBe(0)
    const second = searchWithGraphContext({ ...input, cache })
    expect(second).not.toBe(first)
    expect(engineCalls).toBe(2)
    expect(facetReads).toBe(2)
  })

  it('never caches a base-lane failure either: the degraded answer recomputes on the next call', () => {
    const { port, reads } = wiredPort()
    let engineCalls = 0
    const input = {
      engine: {
        search: (): SearchResult => {
          engineCalls++
          // The failure lives in the BASE result's lanes, not the enrichment.
          return fakeResult([fakeHit(1, 'src/b.ts')], {
            readErrors: ['vector lane failed (cosine mismatch); contributed nothing'],
            degraded: true,
          })
        },
      },
      port,
      request: { query: 'q' } satisfies EngineSearchRequest,
      epochs: { indexEpoch: 1, evidenceEpoch: 0 },
      limits: LIMITS,
      tokenBudget: 6_000,
    }
    const cache = createGraphResultCache()
    const first = searchWithGraphContext({ ...input, cache })
    expect(first.result.degraded).toBe(true)
    expect(first.result.readErrors.join('\n')).toContain('vector lane failed')
    expect(cache.size).toBe(0)
    const second = searchWithGraphContext({ ...input, cache })
    expect(second).not.toBe(first)
    expect(engineCalls).toBe(2)
    // A clean failure-free enrichment ran twice too — only the merged answer
    // decides cacheability.
    expect(reads()).toBe(2)
  })

  it('stabilizes object key order in the cache key', () => {
    const { port } = wiredPort()
    let engineCalls = 0
    const input = {
      engine: { search: (): SearchResult => { engineCalls++; return fakeResult([fakeHit(1, 'src/b.ts')]) } },
      port,
      epochs: { indexEpoch: 1, evidenceEpoch: 0 },
      limits: LIMITS,
      tokenBudget: 6_000,
    }
    const cache = createGraphResultCache()
    // Different key insertion order must serialize to the same cache key.
    const first = searchWithGraphContext({ ...input, request: { query: 'q', topK: 3 }, cache })
    const reordered = searchWithGraphContext({ ...input, request: { topK: 3, query: 'q' }, cache })
    expect(reordered).toBe(first)
    expect(engineCalls).toBe(1)
  })

  it('treats list order as irrelevant for the cache key', () => {
    const { port } = wiredPort()
    let engineCalls = 0
    const input = {
      engine: { search: (): SearchResult => { engineCalls++; return fakeResult([fakeHit(1, 'src/b.ts')]) } },
      port,
      request: { query: 'q', paths: ['src/a.ts', 'src/b.ts'] } satisfies EngineSearchRequest,
      epochs: { indexEpoch: 1, evidenceEpoch: 0 },
      limits: LIMITS,
      tokenBudget: 6_000,
    }
    const cache = createGraphResultCache()
    const first = searchWithGraphContext({ ...input, cache })
    const reordered = searchWithGraphContext({ ...input, request: { query: 'q', paths: ['src/b.ts', 'src/a.ts'] }, cache })
    expect(reordered).toBe(first)
    expect(engineCalls).toBe(1)
  })

  it('keys the query vector by content fingerprint: byte-equal vectors hit, different ones miss', () => {
    const { port } = wiredPort()
    let engineCalls = 0
    const input = {
      engine: { search: (): SearchResult => { engineCalls++; return fakeResult([fakeHit(1, 'src/b.ts')]) } },
      port,
      request: { query: 'q' } satisfies EngineSearchRequest,
      epochs: { indexEpoch: 1, evidenceEpoch: 0 },
      limits: LIMITS,
      tokenBudget: 6_000,
    }
    const cache = createGraphResultCache()
    const first = searchWithGraphContext({
      ...input,
      request: { ...input.request, queryVector: Float32Array.from([1, 0, 0]) },
      cache,
    })
    // Byte-equal vector: the fingerprint matches and the outcome is served.
    const sameVector = searchWithGraphContext({
      ...input,
      request: { ...input.request, queryVector: Float32Array.from([1, 0, 0]) },
      cache,
    })
    expect(sameVector).toBe(first)
    expect(engineCalls).toBe(1)
    // A different embedding of the same query text must not share the entry.
    const otherVector = searchWithGraphContext({
      ...input,
      request: { ...input.request, queryVector: Float32Array.from([0, 1, 0]) },
      cache,
    })
    expect(otherVector).not.toBe(first)
    expect(engineCalls).toBe(2)
    // A vectorless call is its own key too.
    expect(searchWithGraphContext({ ...input, cache })).not.toBe(first)
    expect(engineCalls).toBe(3)
  })

  it('evicts the least recently used entry past capacity and refreshes recency on get', () => {
    const cache = createGraphResultCache(1)
    expect(DEFAULT_GRAPH_RESULT_CACHE_CAPACITY).toBe(32)
    const outcome: GraphSearchOutcome = {
      result: fakeResult([]),
      enrichment: {
        nodes: [],
        symbolsResolved: 0,
        callersAdded: 0,
        calleesAdded: 0,
        testsFound: 0,
        explain: { declared: [], edgeKindsUsed: [], readErrors: [], droppedReadErrorCount: 0, truncated: false, isEmpty: true },
      },
    }
    cache.set('a', outcome)
    expect(cache.get('missing')).toBeUndefined()
    cache.set('b', outcome)
    expect(cache.size).toBe(1)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.get('b')).toBeDefined()

    const refresh = createGraphResultCache(2)
    refresh.set('a', outcome)
    refresh.set('b', outcome)
    refresh.get('a') // refresh recency; 'b' now evicts first
    refresh.set('c', outcome)
    expect(refresh.get('b')).toBeUndefined()
    expect(refresh.get('a')).toBeDefined()
    expect(refresh.get('c')).toBeDefined()
  })
})

describe('searchWithGraphContext through the real engine', () => {
  it('boosts the resolved hit of a wired index and carries the enrichment', () => {
    const port = new FixturePort()
    port
      .addFile('src/seed-home.ts', 'seedfn entry point')
      .addFile('src/caller-home.ts', 'unrelated summary words')
      .addChunk({ chunkId: 'chunk:src/seed-home.ts:0', filePath: 'src/seed-home.ts', startLine: 1, endLine: 4, text: 'export function seedFn() { return 1 }' })
      .addChunk({ chunkId: 'chunk:src/caller-home.ts:0', filePath: 'src/caller-home.ts', startLine: 1, endLine: 4, text: 'export function callerFn() { return helper() }' })
      .addSpan({ filePath: 'src/seed-home.ts', chunkId: 'chunk:src/seed-home.ts:0', startLine: 1, endLine: 4 })
      .addSpan({ filePath: 'src/caller-home.ts', chunkId: 'chunk:src/caller-home.ts:0', startLine: 1, endLine: 4 })
    // Symbol spans contain their chunk spans so the enrich resolver binds them.
    port
      .addSymbol(symbol({ name: 'seedFn', filePath: 'src/seed-home.ts', startLine: 1, endLine: 4 }))
      .addSymbol(symbol({ name: 'callerFn', filePath: 'src/caller-home.ts', startLine: 1, endLine: 4 }))
      .addEdge(edge({ callerSymbolUid: 'uid:callerFn', calleeSymbolUid: 'uid:seedFn', filePath: 'src/caller-home.ts' }))
      .addDegree({ symbolUid: 'uid:seedFn', inDegree: 1, outDegree: 0, refCount: 0 })

    const engine = createSearchEngine({
      port,
      lanes: defaultRetrievalLanesWithGraph(),
      layers: defaultPreselectLayersWithGraphNeighbor(),
      resolveEpochs: () => ({ indexEpoch: 7, evidenceEpoch: 0 }),
    })
    const outcome = searchWithGraphContext({
      engine,
      port,
      request: { query: 'seedfn' },
      epochs: { indexEpoch: 7, evidenceEpoch: 0 },
      limits: LIMITS,
      tokenBudget: 6_000,
      cache: createGraphResultCache(),
    })
    const seeded = outcome.result.hits.find(hit => hit.chunkId === 'chunk:src/seed-home.ts:0')
    expect(seeded).toBeDefined()
    expect(seeded?.graphScore).toBeCloseTo(Math.log(2) / 10, 12)
    expect(seeded?.reasons).toContain(GRAPH_RERANK_REASON)
    expect(outcome.result.candidateCount).toBe(2)
    expect(outcome.result.epochs).toEqual({ indexEpoch: 7, evidenceEpoch: 0 })
    expect(outcome.result.degraded).toBe(false)
    expect(outcome.enrichment.symbolsResolved).toBe(2)
  })
})
