import { describe, expect, it } from 'vitest'
import type { SearchResult } from '@relay-harness/rlh-code-index'
import { createSearchEngine } from '@relay-harness/rlh-code-index-search'
import type { RetrievalLane } from '@relay-harness/rlh-code-index-search'
import {
  defaultPreselectLayersWithGraphNeighbor,
  defaultRetrievalLanesWithGraph,
} from '../../src/lane/defaults.ts'
import { FixturePort, edge, symbol } from './port-fixture.ts'

/** Round non-integer floats so two engine runs compare byte-for-byte. */
function canonical(result: SearchResult): string {
  return JSON.stringify(result, (_key, value: unknown) =>
    typeof value === 'number' && !Number.isInteger(value) ? Number(value.toFixed(6)) : value)
}

/** A small index with one lexical match and a call edge bridging two files. */
function wiredIndex(): FixturePort {
  const port = new FixturePort()
  port
    .addFile('src/seed-home.ts', 'seedfn entry point')
    .addFile('src/caller-home.ts', 'unrelated summary words')
    .addChunk({ chunkId: 'chunk:src/seed-home.ts:0', filePath: 'src/seed-home.ts', startLine: 1, endLine: 4, text: 'export function seedFn() { return 1 }' })
    .addChunk({ chunkId: 'chunk:src/caller-home.ts:0', filePath: 'src/caller-home.ts', startLine: 1, endLine: 4, text: 'export function callerFn() { return helper() }' })
    .addSpan({ filePath: 'src/seed-home.ts', chunkId: 'chunk:src/seed-home.ts:0', startLine: 1, endLine: 4 })
    .addSpan({ filePath: 'src/caller-home.ts', chunkId: 'chunk:src/caller-home.ts:0', startLine: 1, endLine: 4 })
  port
    .addSymbol(symbol({ name: 'seedFn', filePath: 'src/seed-home.ts', startLine: 1, endLine: 2 }))
    .addSymbol(symbol({ name: 'callerFn', filePath: 'src/caller-home.ts', startLine: 1, endLine: 2 }))
    .addEdge(edge({ callerSymbolUid: 'uid:callerFn', calleeSymbolUid: 'uid:seedFn', filePath: 'src/caller-home.ts' }))
  return port
}

describe('composed engine defaults', () => {
  it('registers the graph lane last and the graph-neighbor layer after fallback', () => {
    expect(defaultRetrievalLanesWithGraph().map(lane => lane.laneId)).toEqual(['lexical', 'grep', 'graph', 'literal'])
    const layers = defaultPreselectLayersWithGraphNeighbor().map(layer => layer.name)
    expect(layers.at(-1)).toBe('graph-neighbor')
    expect(layers.at(-2)).toBe('fallback-indexed')
  })

  it('appends a supplied vector lane after the literal lane', () => {
    // Structural stand-in: the concrete vector lane is the deployment's
    // construction (it must name the chunks_vec model), carried through the
    // composition unchanged.
    const vectorLane: RetrievalLane = {
      laneId: 'vector',
      weight: () => 0.9,
      isEnabled: () => true,
      annotatesHits: () => true,
      scoreSlot: () => 'vector',
      run: () => [],
    }
    expect(defaultRetrievalLanesWithGraph(vectorLane).map(entry => entry.laneId))
      .toEqual(['lexical', 'grep', 'graph', 'literal', 'vector'])
  })

  it('stays byte-identical to the plain engine while the graph data is empty', () => {
    const port = wiredIndex()
    port.state.symbols = []
    port.state.callEdges = []
    const plain = createSearchEngine({ port })
    const composed = createSearchEngine({
      port,
      lanes: defaultRetrievalLanesWithGraph(),
      layers: defaultPreselectLayersWithGraphNeighbor(),
    })
    const request = { query: 'seedfn' }
    expect(canonical(composed.search(request))).toBe(canonical(plain.search(request)))
  })

  it('brings graph-only candidates and neighbor reasons into the result', () => {
    const port = wiredIndex()
    const composed = createSearchEngine({
      port,
      lanes: defaultRetrievalLanesWithGraph(),
      layers: defaultPreselectLayersWithGraphNeighbor(),
    })
    const result = composed.search({ query: 'seedfn' })
    const callerChunk = result.hits.find(hit => hit.chunkId === 'chunk:src/caller-home.ts:0')
    // The caller chunk matches no lexical/grep term: only the graph lane's
    // 1-hop expansion carries it in, fusion-only (no graph@rank reason).
    expect(callerChunk).toBeDefined()
    expect(callerChunk?.reasons.some(reason => reason.startsWith('graph@'))).toBe(false)
    // The preselect graph-neighbor layer scores the caller file (its symbol
    // calls the top-scored seed file's symbol), surfacing as a bill entry.
    expect(callerChunk?.reasons).toContain('graph-neighbor')
    expect(result.degraded).toBe(false)
  })

  it('degrades into readErrors when the graph lane fails but keeps the other lanes', () => {
    const port = wiredIndex()
    ;(port.graph as unknown as Record<string, unknown>).symbolSeedHits = () => {
      throw new Error('graph mirror offline')
    }
    const composed = createSearchEngine({
      port,
      lanes: defaultRetrievalLanesWithGraph(),
      layers: defaultPreselectLayersWithGraphNeighbor(),
    })
    const result = composed.search({ query: 'seedfn' })
    expect(result.degraded).toBe(true)
    expect(result.readErrors.join('\n')).toContain('graph lane failed')
    // Lexical and grep still delivered their candidates.
    expect(result.hits.some(hit => hit.chunkId === 'chunk:src/seed-home.ts:0')).toBe(true)
  })
})
