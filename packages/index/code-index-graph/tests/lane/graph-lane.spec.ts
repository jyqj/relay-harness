import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FEATURE_GATES,
  DEFAULT_RANKING_CONFIG,
  DEFAULT_SEARCH_CONFIG,
  SearchPlan,
} from '@relay-harness/rlh-code-index-search'
import type { LaneContext, ReadErrorCollector, SearchConfig } from '@relay-harness/rlh-code-index-search'
import { LANE_GRAPH_ID, createGraphLane } from '../../src/lane/graph-lane.ts'
import { FixturePort, edge, symbol } from './port-fixture.ts'

const config = DEFAULT_SEARCH_CONFIG
const ranking = DEFAULT_RANKING_CONFIG

function readErrors(): ReadErrorCollector & { entries(): string[] } {
  const entries: string[] = []
  return { push: message => entries.push(message), entries: () => entries }
}

function contextFor(port: FixturePort, query: string, over: Partial<SearchConfig> = {}): LaneContext {
  const searchConfig = { ...config, ...over }
  const plan = SearchPlan.build({
    port,
    request: { query },
    searchConfig,
    ranking,
    tier: 'tiny',
    layers: [],
  })
  return { port, plan, config: searchConfig, ranking, gates: DEFAULT_FEATURE_GATES, readErrors: readErrors() }
}

/** One seeded symbol with a covering chunk span, keyed off the symbol name. */
function seed(port: FixturePort, name: string, filePath: string, span = { start: 1, end: 2 }): void {
  port
    .addFile(filePath, '')
    .addSymbol(symbol({ name, filePath, startLine: span.start, endLine: span.end }))
    .addChunk({ chunkId: `chunk:${filePath}:0`, filePath, startLine: span.start, endLine: span.end, text: '' })
    .addSpan({ filePath, chunkId: `chunk:${filePath}:0`, startLine: span.start, endLine: span.end })
}

describe('graph lane shape', () => {
  it('declares the fusion-only graph contract', () => {
    const lane = createGraphLane()
    expect(lane.laneId).toBe(LANE_GRAPH_ID)
    expect(lane.weight(config)).toBe(0.6)
    expect(lane.annotatesHits()).toBe(false)
    expect(lane.scoreSlot()).toBe('graph')
    expect(lane.isEnabled(contextFor(new FixturePort(), 'x'))).toBe(true)
    const disabled = contextFor(new FixturePort(), 'x', { graphWeight: 0 })
    expect(lane.isEnabled(disabled)).toBe(false)
    expect(lane.weight({ ...config, graphWeight: 0.9 })).toBe(0.9)
  })
})

describe('graph lane seeding (lanes.rs::find_seed_symbol_uids)', () => {
  it('seeds on the first five query tokens only', () => {
    const port = new FixturePort()
    for (const name of ['tok1', 'tok2', 'tok3', 'tok4', 'tok5', 'tok6']) {
      seed(port, name, `src/${name}.ts`)
    }
    const lane = createGraphLane()
    const hits = lane.run(contextFor(port, 'tok1 tok2 tok3 tok4 tok5 tok6', { graphTopK: 30 }))
    // tok6's chunk is absent: only five tokens seed, and each seeded symbol
    // maps to exactly one chunk.
    expect(hits.map(hit => hit.chunkId)).not.toContain('chunk:src/tok6.ts:0')
    expect(hits).toHaveLength(5)
  })

  it('resolves short tokens through exact names in both casings', () => {
    const port = new FixturePort()
    seed(port, 'do', 'src/do.ts')
    seed(port, 'Do', 'src/Do.ts')
    seed(port, 'done', 'src/done.ts')
    // An exact-name row without a uid cannot seed anything.
    port.addSymbol(symbol({ name: 'do', filePath: 'src/uidless.ts', symbolUid: null }))
    const lane = createGraphLane()
    const hits = lane.run(contextFor(port, 'do'))
    // 'do' and 'Do' are exact-name seeds (score 1.0 each); 'done' only
    // substring-matches and short tokens never take the substring path.
    expect(hits.map(hit => hit.chunkId)).toEqual(['chunk:src/do.ts:0', 'chunk:src/Do.ts:0'])
    expect(hits[0]?.score).toBe(1)
    expect(hits[1]?.score).toBe(1)
  })

  it('scores exact name matches 1.0 and substring matches 0.5', () => {
    const port = new FixturePort()
    seed(port, 'loaduser', 'src/exact.ts')
    seed(port, 'loaduserSession', 'src/fuzzy.ts')
    const lane = createGraphLane()
    const hits = lane.run(contextFor(port, 'loaduser'))
    expect(hits.map(hit => hit.chunkId)).toEqual(['chunk:src/exact.ts:0', 'chunk:src/fuzzy.ts:0'])
    expect(hits[0]?.score).toBe(1)
    expect(hits[1]?.score).toBe(0.5)
  })

  it('merges repeated sightings of one uid by maximum', () => {
    const port = new FixturePort()
    seed(port, 'loadUser', 'src/both.ts')
    const lane = createGraphLane()
    // 'load' substring-matches (0.5) and 'loaduser' exact-matches (1.0): one
    // seed survives at 1.0, producing one chunk scored 1.
    const hits = lane.run(contextFor(port, 'load loaduser'))
    expect(hits).toEqual([{ chunkId: 'chunk:src/both.ts:0', score: 1 }])
  })

  it('caps the seed field at 20 symbols', () => {
    const port = new FixturePort()
    for (const family of ['aa1', 'aa2', 'aa3']) {
      for (let index = 0; index < 25; index++) {
        const name = `${family}item${String(index).padStart(2, '0')}`
        seed(port, name, `src/${name}.ts`)
      }
    }
    const lane = createGraphLane()
    // Three tokens × 10 per-token hits = 30 candidate seeds; the field cuts to
    // 20 and the raised graphTopK (30) keeps the cut observable.
    const hits = lane.run(contextFor(port, 'aa1item aa2item aa3item', { graphTopK: 30 }))
    expect(hits).toHaveLength(20)
    // The first two token families fill the cut entirely.
    expect(hits.every(hit => !hit.chunkId.startsWith('chunk:src/aa3'))).toBe(true)
  })
})

describe('graph lane 1-hop expansion', () => {
  it('adds callers and callees at seed × 0.5 and keeps the seed at distance 0', () => {
    const port = new FixturePort()
    seed(port, 'seedFn', 'src/seed.ts')
    seed(port, 'callerFn', 'src/caller-file.ts')
    seed(port, 'calleeFn', 'src/callee-file.ts')
    port.addEdge(edge({ callerSymbolUid: 'uid:callerFn', calleeSymbolUid: 'uid:seedFn', filePath: 'src/caller-file.ts' }))
    port.addEdge(edge({ callerSymbolUid: 'uid:seedFn', calleeSymbolUid: 'uid:calleeFn', filePath: 'src/callee-file.ts' }))
    const lane = createGraphLane()
    const hits = lane.run(contextFor(port, 'seedfn'))
    // seedFn exact (1.0); both 1-hop neighbors land at 0.5 — callees expand
    // first, so ties keep discovery order.
    expect(hits.map(hit => hit.chunkId)).toEqual([
      'chunk:src/seed.ts:0',
      'chunk:src/callee-file.ts:0',
      'chunk:src/caller-file.ts:0',
    ])
    expect(hits[0]?.score).toBe(1)
    expect(hits[1]?.score).toBe(0.5)
    expect(hits[2]?.score).toBe(0.5)
  })

  it('keeps the maximum when one neighbor is reachable from several seeds', () => {
    const port = new FixturePort()
    seed(port, 'seedFn', 'src/seed.ts')
    seed(port, 'weakSeedFn', 'src/weak.ts')
    seed(port, 'hubFn', 'src/hub.ts')
    // hubFn is a neighbor of both seeds but never a seed itself ('hub' does
    // not match either token); both decayed sightings score 0.5 and merge.
    port.addEdge(edge({ callerSymbolUid: 'uid:hubFn', calleeSymbolUid: 'uid:seedFn', filePath: 'src/hub.ts' }))
    port.addEdge(edge({ callerSymbolUid: 'uid:hubFn', calleeSymbolUid: 'uid:weakSeedFn', filePath: 'src/hub.ts' }))
    const lane = createGraphLane()
    const hits = lane.run(contextFor(port, 'seedfn weakseedfn'))
    const hub = hits.find(hit => hit.chunkId === 'chunk:src/hub.ts:0')
    expect(hub?.score).toBe(0.5)
    // Both seeds exact-match one token each (1.0) and lead; the hub follows.
    expect(hits.map(hit => hit.chunkId)).toEqual([
      'chunk:src/seed.ts:0',
      'chunk:src/weak.ts:0',
      'chunk:src/hub.ts:0',
    ])
  })

  it('keeps expansion from the working direction when the other read fails', () => {
    const port = new FixturePort()
    seed(port, 'seedFn', 'src/seed.ts')
    seed(port, 'callerFn', 'src/caller-file.ts')
    seed(port, 'calleeFn', 'src/callee-file.ts')
    // The seed calls calleeFn (rows where the seed is the caller) and is
    // called by callerFn (rows where the seed is the callee).
    port.addEdge(edge({ callerSymbolUid: 'uid:seedFn', calleeSymbolUid: 'uid:calleeFn', filePath: 'src/seed.ts' }))
    port.addEdge(edge({ callerSymbolUid: 'uid:callerFn', calleeSymbolUid: 'uid:seedFn', filePath: 'src/caller-file.ts' }))
    // The callee-finding direction dies; the caller direction still expands.
    ;(port.graph as unknown as Record<string, unknown>).calleeRowsByUids = () => {
      throw new Error('callee edge index offline')
    }
    const lane = createGraphLane()
    const hits = lane.run(contextFor(port, 'seedfn'))
    expect(hits.map(hit => hit.chunkId)).toEqual([
      'chunk:src/seed.ts:0',
      'chunk:src/callee-file.ts:0',
    ])
  })
})

describe('graph lane chunk mapping', () => {
  it('maps each neighbor to its smallest containing chunk and merges by maximum', () => {
    const port = new FixturePort()
    port.addFile('src/big.ts', '').addFile('src/small.ts', '')
    // hubFn's span [2,3] sits inside the file-wide span and has its own tight
    // chunk: the tight chunk wins.
    port.addSymbol(symbol({ name: 'hubFn', filePath: 'src/big.ts', startLine: 2, endLine: 3 }))
    port.addSymbol(symbol({ name: 'twinFn', filePath: 'src/big.ts', startLine: 2, endLine: 3 }))
    port.addChunk({ chunkId: 'chunk:wide', filePath: 'src/big.ts', startLine: 1, endLine: 10, text: '' })
    port.addChunk({ chunkId: 'chunk:tight', filePath: 'src/big.ts', startLine: 2, endLine: 3, text: '' })
    port.addSpan({ filePath: 'src/big.ts', chunkId: 'chunk:wide', startLine: 1, endLine: 10 })
    port.addSpan({ filePath: 'src/big.ts', chunkId: 'chunk:tight', startLine: 2, endLine: 3 })
    // A second symbol lands on the same tight chunk with the same score:
    // max-merge keeps one entry.
    port.addChunk({ chunkId: 'chunk:small', filePath: 'src/small.ts', startLine: 1, endLine: 2, text: '' })
    port.addSpan({ filePath: 'src/small.ts', chunkId: 'chunk:small', startLine: 1, endLine: 2 })
    port.addEdge(edge({ callerSymbolUid: 'uid:hubFn', calleeSymbolUid: 'uid:seedFn', filePath: 'src/big.ts' }))
    seed(port, 'seedFn', 'src/small.ts')

    const lane = createGraphLane()
    const hits = lane.run(contextFor(port, 'seedfn'))
    expect(hits.map(hit => hit.chunkId)).toEqual(['chunk:small', 'chunk:tight'])
    expect(hits[0]?.score).toBe(1)
    expect(hits[1]?.score).toBe(0.5)
  })

  it('filters candidates through the plan scope', () => {
    const port = new FixturePort()
    seed(port, 'seedFn', 'src/in-scope.ts')
    seed(port, 'callerFn', 'lib/out-of-scope.ts')
    port.addEdge(edge({
      callerSymbolUid: 'uid:callerFn',
      calleeSymbolUid: 'uid:seedFn',
      filePath: 'lib/out-of-scope.ts',
    }))
    const lane = createGraphLane()
    const plan = SearchPlan.build({
      port,
      request: { query: 'seedfn', pathPrefix: 'src/' },
      searchConfig: config,
      ranking,
      tier: 'tiny',
      layers: [],
    })
    const hits = lane.run({ port, plan, config, ranking, gates: DEFAULT_FEATURE_GATES, readErrors: readErrors() })
    // The out-of-scope caller chunk never becomes a candidate; the seed chunk
    // survives prefix filtering.
    expect(hits.map(hit => hit.chunkId)).toEqual(['chunk:src/in-scope.ts:0'])
  })

  it('drops neighbors without symbol rows, without spans, or without a containing span', () => {
    const port = new FixturePort()
    seed(port, 'seedFn', 'src/seed.ts')
    // A neighbor uid the symbol lookup cannot resolve contributes nothing.
    port.addEdge(edge({ callerSymbolUid: 'uid:ghost', calleeSymbolUid: 'uid:seedFn', filePath: 'src/ghost.ts' }))
    // A symbol whose file carries no chunk spans has no chunk to map into.
    port.addFile('src/spanless.ts', '')
    port.addSymbol(symbol({ name: 'spanlessFn', filePath: 'src/spanless.ts' }))
    port.addEdge(edge({ callerSymbolUid: 'uid:spanlessFn', calleeSymbolUid: 'uid:seedFn', filePath: 'src/spanless.ts' }))
    // A symbol whose only span does not contain its lines has no containing chunk.
    port.addFile('src/mismatch.ts', '')
    port.addSymbol(symbol({ name: 'mismatchFn', filePath: 'src/mismatch.ts', startLine: 5, endLine: 6 }))
    port.addChunk({ chunkId: 'chunk:mismatch', filePath: 'src/mismatch.ts', startLine: 1, endLine: 2, text: '' })
    port.addSpan({ filePath: 'src/mismatch.ts', chunkId: 'chunk:mismatch', startLine: 1, endLine: 2 })
    port.addEdge(edge({ callerSymbolUid: 'uid:mismatchFn', calleeSymbolUid: 'uid:seedFn', filePath: 'src/mismatch.ts' }))
    // Edges without a resolvable neighbor uid contribute nothing.
    port.addEdge(edge({ callerSymbolUid: null, calleeSymbolUid: 'uid:seedFn', filePath: 'src/nullcaller.ts' }))
    port.addEdge(edge({ callerSymbolUid: 'uid:seedFn', calleeSymbolUid: null, filePath: 'src/seed.ts' }))
    // A uid-less symbol row returned by the uid lookup is skipped.
    const graph = port.graph as unknown as Record<string, unknown>
    const originalRows = (graph.symbolRowsByUids as (...args: unknown[]) => ReturnType<FixturePort['graph']['symbolRowsByUids']>).bind(port.graph)
    graph.symbolRowsByUids = (uids: readonly string[]) => [
      ...originalRows(uids),
      symbol({ name: 'uidless', filePath: 'src/uidless.ts', symbolUid: null }),
    ]

    const lane = createGraphLane()
    expect(lane.run(contextFor(port, 'seedfn'))).toEqual([{ chunkId: 'chunk:src/seed.ts:0', score: 1 }])
  })

  it('cuts the ranked chunk field to the graph limit', () => {
    const port = new FixturePort()
    seed(port, 'seedFn', 'src/seed.ts')
    // 10 callers + 10 callees (the per-seed store caps) + the seed itself:
    // 21 neighbor chunks exist and the default graph limit 12 wins.
    for (let index = 0; index < 10; index++) {
      const caller = `caller${String(index).padStart(2, '0')}`
      const callee = `callee${String(index).padStart(2, '0')}`
      seed(port, caller, `src/${caller}.ts`)
      seed(port, callee, `src/${callee}.ts`)
      port.addEdge(edge({ callerSymbolUid: `uid:${caller}`, calleeSymbolUid: 'uid:seedFn', filePath: `src/${caller}.ts` }))
      port.addEdge(edge({ callerSymbolUid: 'uid:seedFn', calleeSymbolUid: `uid:${callee}`, filePath: 'src/seed.ts' }))
    }
    const lane = createGraphLane()
    const hits = lane.run(contextFor(port, 'seedfn'))
    expect(hits).toHaveLength(12)
    // The seed itself (score 1.0) leads; every 0.5-scored neighbor follows.
    expect(hits[0]?.chunkId).toBe('chunk:src/seed.ts:0')
    expect(hits[0]?.score).toBe(1)
  })

  it('answers empty when no symbol matches and propagates seed-read failures', () => {
    const lane = createGraphLane()
    expect(lane.run(contextFor(new FixturePort(), 'nothing'))).toEqual([])

    const broken = new FixturePort()
    ;(broken.graph as unknown as Record<string, unknown>).symbolSeedHits = () => {
      throw new Error('fts mirror offline')
    }
    expect(() => lane.run(contextFor(broken, 'seedfn'))).toThrow('fts mirror offline')
  })
})
