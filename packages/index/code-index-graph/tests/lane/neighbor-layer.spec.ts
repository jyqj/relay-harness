import { describe, expect, it } from 'vitest'
import { DEFAULT_RANKING_CONFIG } from '@relay-harness/rlh-code-index-search'
import type { PreselectContext, RankingConfig } from '@relay-harness/rlh-code-index-search'
import { LAYER_GRAPH_NEIGHBOR, createGraphNeighborLayer } from '../../src/lane/neighbor-layer.ts'
import { FixturePort, edge, symbol } from './port-fixture.ts'

const ranking = DEFAULT_RANKING_CONFIG

function contextFor(
  port: FixturePort,
  currentScores: ReadonlyMap<string, number>,
  over: { limit?: number; ranking?: RankingConfig } = {},
): PreselectContext {
  return {
    port,
    query: '',
    pathPrefix: null,
    limit: over.limit ?? 10,
    ranking: over.ranking ?? ranking,
    boostFilePaths: null,
    recentFilePaths: null,
    pinnedFilePaths: null,
    overlayFilePaths: null,
    currentScores,
  }
}

/** A scored seed file with one symbol, plus a caller file reached by one edge. */
function seededPair(port: FixturePort, seedFile: string, callerFile: string): void {
  port.addFile(seedFile, '').addFile(callerFile, '')
  port.addSymbol(symbol({ name: 'seedFn', filePath: seedFile }))
  port.addSymbol(symbol({ name: 'callerFn', filePath: callerFile }))
  port.addEdge(edge({ callerSymbolUid: 'uid:callerFn', calleeSymbolUid: 'uid:seedFn', filePath: callerFile }))
}

describe('graph-neighbor layer gate', () => {
  it('answers empty while the budget is spent or nothing scored yet', () => {
    const layer = createGraphNeighborLayer()
    const port = new FixturePort()
    expect(layer.name).toBe(LAYER_GRAPH_NEIGHBOR)
    expect(layer.readsPriorScores()).toBe(true)

    const full = contextFor(port, new Map([['src/a.ts', 1], ['src/b.ts', 1]]), { limit: 2 })
    expect(layer.score(full)).toEqual([])

    const empty = contextFor(port, new Map(), { limit: 10 })
    expect(layer.score(empty)).toEqual([])
  })

  it('degrades a seed-file read failure to no hits', () => {
    const layer = createGraphNeighborLayer()
    const port = new FixturePort()
    ;(port.graph as unknown as Record<string, unknown>).symbolsByFilePaths = () => {
      throw new Error('symbol mirror offline')
    }
    const ctx = contextFor(port, new Map([['src/seed.ts', 2]]))
    expect(layer.score(ctx)).toEqual([])
  })
})

describe('graph-neighbor layer scoring', () => {
  it('scores absent caller files at the base and never rescores known files', () => {
    const port = new FixturePort()
    seededPair(port, 'src/seed.ts', 'src/caller.ts')
    // A uid-less seed symbol row is skipped during seed collection.
    port.addSymbol(symbol({ name: 'uidlessSeed', filePath: 'src/seed.ts', symbolUid: null }))
    const layer = createGraphNeighborLayer()

    const first = layer.score(contextFor(port, new Map([['src/seed.ts', 2]])))
    expect(first).toEqual([{ filePath: 'src/caller.ts', score: 0.8, reason: 'graph-neighbor' }])

    // The caller file is now a known candidate: the layer must not rescore it.
    const known = layer.score(contextFor(port, new Map([['src/seed.ts', 2], ['src/caller.ts', 2]])))
    expect(known).toEqual([])
  })

  it('adds the per-edge increment on repeated sightings and clamps at the cap', () => {
    const port = new FixturePort()
    port.addFile('src/seed.ts', '').addFile('src/hub.ts', '')
    port.addSymbol(symbol({ name: 'seedFn', filePath: 'src/seed.ts' }))
    port.addSymbol(symbol({ name: 'hubFn', filePath: 'src/hub.ts' }))
    // Six duplicate caller edges (the store returns 5 rows per seed): the hub
    // file is sighted 5× — 0.8 + 4×0.1 clamps at 1.2.
    for (let repeat = 0; repeat < 6; repeat++) {
      port.addEdge(edge({ callerSymbolUid: 'uid:hubFn', calleeSymbolUid: 'uid:seedFn', filePath: 'src/hub.ts' }))
    }
    const layer = createGraphNeighborLayer()
    const hits = layer.score(contextFor(port, new Map([['src/seed.ts', 5]]), { limit: 10 }))
    expect(hits).toEqual([{ filePath: 'src/hub.ts', score: 1.2, reason: 'graph-neighbor' }])
  })

  it('scores each single-sighting caller file at the base', () => {
    const port = new FixturePort()
    port.addFile('src/seed.ts', '')
    port.addSymbol(symbol({ name: 'seedFn', filePath: 'src/seed.ts' }))
    for (let index = 0; index < 3; index++) {
      const name = `caller${index}`
      port.addFile(`src/${name}.ts`, '')
      port.addSymbol(symbol({ name, filePath: `src/${name}.ts` }))
      port.addEdge(edge({ callerSymbolUid: `uid:${name}`, calleeSymbolUid: 'uid:seedFn', filePath: `src/${name}.ts` }))
    }
    const layer = createGraphNeighborLayer()
    const hits = layer.score(contextFor(port, new Map([['src/seed.ts', 5]]), { limit: 10 }))
    expect(hits.map(hit => [hit.filePath, hit.score])).toEqual([
      ['src/caller0.ts', 0.8],
      ['src/caller1.ts', 0.8],
      ['src/caller2.ts', 0.8],
    ])
  })

  it('clamps a base above the cap on first sighting', () => {
    const port = new FixturePort()
    seededPair(port, 'src/seed.ts', 'src/caller.ts')
    const layer = createGraphNeighborLayer()
    const hits = layer.score(contextFor(
      port,
      new Map([['src/seed.ts', 2]]),
      { ranking: { ...ranking, graphNeighborBase: 2.5 } },
    ))
    expect(hits[0]?.score).toBe(1.2)
  })

  it('resolves callee files through the batched uid lookup', () => {
    const port = new FixturePort()
    seededPair(port, 'src/seed.ts', 'src/callee-home.ts')
    // Flip the edge: the seed file's symbol CALLS a symbol housed elsewhere.
    port.state.callEdges = [edge({
      callerSymbolUid: 'uid:seedFn',
      calleeSymbolUid: 'uid:hubFn',
      filePath: 'src/seed.ts',
    })]
    port.addSymbol(symbol({ name: 'hubFn', filePath: 'src/callee-home.ts' }))
    const layer = createGraphNeighborLayer()
    const hits = layer.score(contextFor(port, new Map([['src/seed.ts', 2]])))
    expect(hits).toEqual([{ filePath: 'src/callee-home.ts', score: 0.8, reason: 'graph-neighbor' }])
  })

  it('seeds only the top-20 scored files', () => {
    const port = new FixturePort()
    const scores = new Map<string, number>()
    for (let index = 0; index < 21; index++) {
      const file = `src/seeded${String(index).padStart(2, '0')}.ts`
      port.addFile(file, '')
      scores.set(file, 10 - index)
    }
    // Only file #21 (the lowest score, outside the top 20) holds a symbol
    // whose caller would be discoverable.
    port.addSymbol(symbol({ name: 'loneSeed', filePath: 'src/seeded20.ts' }))
    port.addFile('src/lone-caller.ts', '')
    port.addSymbol(symbol({ name: 'loneCaller', filePath: 'src/lone-caller.ts' }))
    port.addEdge(edge({ callerSymbolUid: 'uid:loneCaller', calleeSymbolUid: 'uid:loneSeed', filePath: 'src/lone-caller.ts' }))
    const layer = createGraphNeighborLayer()
    expect(layer.score(contextFor(port, scores, { limit: 40 }))).toEqual([])
  })

  it('caps resolved callee uids at 100', () => {
    const port = new FixturePort()
    const scores = new Map<string, number>()
    // 20 seed files × 3 symbols = 60 uids; the first 50 become seeds and each
    // contributes up to 5 outgoing edge rows (per-seed store cap) = 250
    // distinct callees. Zero-padded naming makes the sorted 100-cap keep
    // callee000..callee099 and drop the rest.
    let calleeIndex = 0
    for (let file = 0; file < 20; file++) {
      const seedFile = `src/seed${String(file).padStart(2, '0')}.ts`
      port.addFile(seedFile, '')
      scores.set(seedFile, 100 - file)
      for (let member = 0; member < 3; member++) {
        const seedName = `seed${String(file).padStart(2, '0')}m${member}`
        port.addSymbol(symbol({ name: seedName, filePath: seedFile }))
        for (let edgeNo = 0; edgeNo < 5; edgeNo++) {
          const calleeName = `callee${String(calleeIndex).padStart(3, '0')}`
          const calleeFile = `src/${calleeName}.ts`
          port.addFile(calleeFile, '')
          port.addSymbol(symbol({ name: calleeName, filePath: calleeFile }))
          port.addEdge(edge({ callerSymbolUid: `uid:${seedName}`, calleeSymbolUid: `uid:${calleeName}`, filePath: seedFile }))
          calleeIndex++
        }
      }
    }
    const layer = createGraphNeighborLayer()
    const hits = layer.score(contextFor(port, scores, { limit: 400 }))
    expect(hits).toHaveLength(100)
    expect(hits.some(hit => hit.filePath === 'src/callee000.ts')).toBe(true)
    expect(hits.some(hit => hit.filePath === 'src/callee100.ts')).toBe(false)
  })

  it('orders hits by score descending and cuts to the remaining budget', () => {
    const port = new FixturePort()
    port.addFile('src/seed.ts', '')
    port.addSymbol(symbol({ name: 'seedFn', filePath: 'src/seed.ts' }))
    // caller0's three edges come first, so the per-seed store cap returns
    // them plus caller1/caller2: caller0 is sighted 3× (1.0), the rest 0.8.
    for (let repeat = 0; repeat < 3; repeat++) {
      port.addEdge(edge({ callerSymbolUid: 'uid:caller0', calleeSymbolUid: 'uid:seedFn', filePath: 'src/caller0.ts' }))
    }
    for (let index = 1; index < 5; index++) {
      const name = `caller${index}`
      const file = `src/${name}.ts`
      port.addFile(file, '')
      port.addSymbol(symbol({ name, filePath: file }))
      port.addEdge(edge({ callerSymbolUid: `uid:${name}`, calleeSymbolUid: 'uid:seedFn', filePath: file }))
    }
    const layer = createGraphNeighborLayer()
    const hits = layer.score(contextFor(port, new Map([['src/seed.ts', 2], ['src/other-a.ts', 2], ['src/other-b.ts', 2]]), { limit: 5 }))
    // Budget = 5 - 3 = 2 hits, best-first: the repeat caller (1.0) then 0.8.
    expect(hits).toEqual([
      { filePath: 'src/caller0.ts', score: 1, reason: 'graph-neighbor' },
      { filePath: 'src/caller1.ts', score: 0.8, reason: 'graph-neighbor' },
    ])
  })
})
