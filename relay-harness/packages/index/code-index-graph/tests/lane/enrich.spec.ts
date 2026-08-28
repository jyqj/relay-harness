/** Graph enrichment contract: score formula, hit→symbol resolution, budget breaks, templates, explain. */

import { describe, expect, it } from 'vitest'
import type { SearchHit } from '@relay-harness/rlh-code-index'
import type { GraphEnrichLimits } from '@relay-harness/rlh-code-index'
import { SEARCH_ENRICH_EDGE_KINDS } from '../../src/lane/explain.ts'
import { GRAPH_SCORE_CAP, graphEnrich } from '../../src/lane/enrich.ts'
import { FixturePort, edge, symbol } from './port-fixture.ts'

const BASE_LIMITS: GraphEnrichLimits = {
  maxResolve: 10,
  callersPerSym: 5,
  calleesPerSym: 5,
  maxTests: 5,
  maxRoutes: 1,
  graphBudgetPct: 50,
}

function hit(chunkId: string, filePath: string, startLine: number, endLine: number, symbolName?: string): SearchHit {
  return {
    chunkId,
    filePath,
    startLine,
    endLine,
    ...(symbolName === undefined ? {} : { symbolName }),
    score: 1,
    rank: 1,
    reasons: [],
    parserTier: 'generic',
    parserConfidence: 0,
  }
}

/** The reference's lock fixture: alpha→beta, x→alpha, beta→gamma, two refs on alpha. */
function wiredPort(): FixturePort {
  const port = new FixturePort()
  port
    .addSymbol(symbol({ name: 'alpha', filePath: 'src/a.ts', startLine: 1, endLine: 4 }))
    .addSymbol(symbol({ name: 'beta', filePath: 'src/b.ts', startLine: 1, endLine: 4 }))
    .addDegree({ symbolUid: 'uid:alpha', inDegree: 1, outDegree: 1, refCount: 2 })
    .addDegree({ symbolUid: 'uid:beta', inDegree: 1, outDegree: 1, refCount: 0 })
    .addEdge(edge({ callerSymbolUid: 'uid:alpha', calleeSymbolUid: 'uid:beta', filePath: 'src/a.ts', line: 5, callerSymbol: 'alpha', calleeSymbol: 'beta' }))
    .addEdge(edge({ callerSymbolUid: 'uid:x', calleeSymbolUid: 'uid:alpha', filePath: 'src/b.ts', line: 3, callerSymbol: 'x_caller', calleeSymbol: 'alpha' }))
    .addEdge(edge({ callerSymbolUid: 'uid:beta', calleeSymbolUid: 'uid:gamma', filePath: 'src/b.ts', line: 7, callerSymbol: 'beta', calleeSymbol: 'gamma' }))
  return port
}

describe('graph enrichment degradation', () => {
  it('returns an empty enrichment for zero hits without declaring anything', () => {
    const output = graphEnrich({ hits: [], port: new FixturePort(), limits: BASE_LIMITS, tokenBudget: 10_000 })
    expect(output.assignments.size).toBe(0)
    expect(output.nodes).toHaveLength(0)
    expect(output.explain.isEmpty).toBe(true)
    expect(output.explain.declared).toEqual([])
  })

  it('records failed reads as "{op}: {error}" and degrades to empty results', () => {
    const port = wiredPort()
    ;(port.graph as unknown as Record<string, unknown>).symbolsByFilePaths = () => {
      throw new Error('mirror offline')
    }
    const output = graphEnrich({
      hits: [hit('chunk:a', 'src/a.ts', 1, 4, 'alpha')],
      port,
      limits: BASE_LIMITS,
      tokenBudget: 10_000,
    })
    expect(output.symbolsResolved).toBe(0)
    expect(output.assignments.size).toBe(0)
    expect(output.nodes).toHaveLength(0)
    expect(output.explain.isEmpty).toBe(false)
    expect(output.explain.readErrors).toEqual(['symbols_by_file_paths: Error: mirror offline'])
  })

  it('records every degraded section once and keeps the surviving sections', () => {
    const port = wiredPort()
    const facet = port.graph as unknown as Record<string, unknown>
    facet.symbolDegreeDetailsBatch = () => {
      throw new Error('degree boom')
    }
    facet.calleeRowsByUids = () => {
      throw new Error('callers boom')
    }
    facet.callerRowsByUids = () => {
      throw new Error('callees boom')
    }
    facet.findImpactedTests = () => {
      throw new Error('tests boom')
    }
    const output = graphEnrich({
      hits: [hit('chunk:a', 'src/a.ts', 1, 4, 'alpha')],
      port,
      limits: BASE_LIMITS,
      tokenBudget: 10_000,
    })
    expect(output.callersAdded).toBe(0)
    expect(output.calleesAdded).toBe(0)
    expect(output.testsFound).toBe(0)
    expect(output.explain.readErrors).toEqual([
      'symbol_degree_details_batch: Error: degree boom',
      'caller_rows_by_uids: Error: callers boom',
      'callee_rows_by_uids: Error: callees boom',
      'find_impacted_tests: Error: tests boom',
    ])
  })
})

describe('graph enrichment scores', () => {
  it('locks the score formula, node identity/order, and counters', () => {
    const port = wiredPort()
    const output = graphEnrich({
      hits: [hit('chunk:a', 'src/a.ts', 1, 4, 'alpha'), hit('chunk:b', 'src/b.ts', 1, 4, 'beta')],
      port,
      limits: BASE_LIMITS,
      tokenBudget: 10_000,
    })

    expect(output.symbolsResolved).toBe(2)
    expect(output.callersAdded).toBe(2)
    expect(output.calleesAdded).toBe(2)
    expect(output.testsFound).toBe(0)
    expect(output.nodes.map(node => node.nodeId)).toEqual([
      'graph:caller:uid:x',
      'graph:callee:uid:beta',
      'graph:caller:uid:alpha',
      'graph:callee:uid:gamma',
    ])
    // ln(in+out+1)/10 + min(refs,10)/100: alpha carries the two-ref bonus.
    const expectedAlpha = Math.log(3) / 10 + 0.02
    expect(output.assignments.get('chunk:a')).toBeCloseTo(expectedAlpha, 12)
    expect(output.assignments.get('chunk:b')).toBeCloseTo(Math.log(3) / 10, 12)
    // Clean run: only the static declaration rides along, nothing to report.
    expect(output.explain.isEmpty).toBe(true)
    expect(output.explain.declared).toEqual(SEARCH_ENRICH_EDGE_KINDS)
    expect(output.explain.truncated).toBe(false)
  })

  it('caps the score at 0.4 and clamps the reference bonus at 10', () => {
    const port = new FixturePort()
    port
      .addSymbol(symbol({ name: 'hub', filePath: 'src/hub.ts' }))
      .addDegree({ symbolUid: 'uid:hub', inDegree: 99, outDegree: 99, refCount: 25 })
    const output = graphEnrich({
      hits: [hit('chunk:hub', 'src/hub.ts', 1, 2, 'hub')],
      port,
      limits: BASE_LIMITS,
      tokenBudget: 10_000,
    })
    expect(output.assignments.get('chunk:hub')).toBe(GRAPH_SCORE_CAP)
    expect(GRAPH_SCORE_CAP).toBe(0.4)
  })

  it('assigns a zero score (no boost) to resolved symbols without graph rows', () => {
    const port = new FixturePort()
    port.addSymbol(symbol({ name: 'lonely', filePath: 'src/l.ts' }))
    const output = graphEnrich({
      hits: [hit('chunk:l', 'src/l.ts', 1, 2, 'lonely')],
      port,
      limits: BASE_LIMITS,
      tokenBudget: 10_000,
    })
    expect(output.assignments.get('chunk:l')).toBe(0)
  })

  it('skips chunks whose uid is missing from the degree batch', () => {
    const port = wiredPort()
    ;(port.graph as unknown as Record<string, unknown>).symbolDegreeDetailsBatch = () => []
    const output = graphEnrich({
      hits: [hit('chunk:a', 'src/a.ts', 1, 4, 'alpha')],
      port,
      limits: BASE_LIMITS,
      tokenBudget: 10_000,
    })
    expect(output.symbolsResolved).toBe(1)
    expect(output.assignments.size).toBe(0)
  })
})

describe('hit → symbol resolution', () => {
  it('resolves through name equality when the span does not contain the hit', () => {
    const port = new FixturePort()
    port.addSymbol(symbol({ name: 'widely', filePath: 'src/a.ts', startLine: 5, endLine: 6 }))
    const output = graphEnrich({
      hits: [hit('chunk:a', 'src/a.ts', 1, 4, 'widely')],
      port,
      limits: BASE_LIMITS,
      tokenBudget: 10_000,
    })
    expect(output.symbolsResolved).toBe(1)
    expect(output.assignments.has('chunk:a')).toBe(true)
  })

  it('resolves through span containment when the names differ', () => {
    const port = new FixturePort()
    port.addSymbol(symbol({ name: 'enclosing', filePath: 'src/a.ts', startLine: 1, endLine: 10 }))
    const output = graphEnrich({
      hits: [hit('chunk:a', 'src/a.ts', 2, 3, 'other')],
      port,
      limits: BASE_LIMITS,
      tokenBudget: 10_000,
    })
    expect(output.symbolsResolved).toBe(1)
  })

  it('deduplicates uids globally so two hits on one symbol resolve once', () => {
    const port = new FixturePort()
    port.addSymbol(symbol({ name: 'shared', filePath: 'src/a.ts', startLine: 1, endLine: 10 }))
    const output = graphEnrich({
      hits: [hit('chunk:a0', 'src/a.ts', 1, 2, 'shared'), hit('chunk:a1', 'src/a.ts', 3, 4, 'shared')],
      port,
      limits: BASE_LIMITS,
      tokenBudget: 10_000,
    })
    expect(output.symbolsResolved).toBe(1)
    expect([...output.assignments.keys()]).toEqual(['chunk:a0'])
  })

  it('cuts resolution at maxResolve hits', () => {
    const port = new FixturePort()
    for (const index of [0, 1, 2, 3, 4]) {
      port.addSymbol(symbol({ name: `sym${index}`, filePath: `src/f${index}.ts` }))
    }
    const output = graphEnrich({
      hits: [0, 1, 2, 3, 4].map(index => hit(`chunk:${index}`, `src/f${index}.ts`, 1, 2, `sym${index}`)),
      port,
      limits: { ...BASE_LIMITS, maxResolve: 3 },
      tokenBudget: 10_000,
    })
    expect(output.symbolsResolved).toBe(3)
    expect([...output.assignments.keys()]).toEqual(['chunk:0', 'chunk:1', 'chunk:2'])
  })
})

describe('node templates and budget', () => {
  it('renders caller, callee, and test templates character-for-character', () => {
    const port = wiredPort()
    port.addImpactedTest({ testFilePath: 'tests/a.test.ts', codeFilePath: 'src/a.ts', reason: 'import', confidence: 0.9 })
    const output = graphEnrich({
      hits: [hit('chunk:a', 'src/a.ts', 1, 4, 'alpha'), hit('chunk:b', 'src/b.ts', 1, 4, 'beta')],
      port,
      limits: BASE_LIMITS,
      tokenBudget: 10_000,
    })
    const byId = new Map(output.nodes.map(node => [node.nodeId, node]))
    const caller = byId.get('graph:caller:uid:x')
    expect(caller?.text).toBe('caller: x_caller → alpha (src/b.ts:3)')
    expect(caller?.title).toBe('Caller: x_caller')
    expect(caller?.filePath).toBe('src/b.ts')
    expect(caller?.startLine).toBe(3)
    expect(caller?.source).toBe('graph')
    const callee = byId.get('graph:callee:uid:beta')
    expect(callee?.text).toBe('callee: alpha → beta (src/a.ts:5)')
    expect(callee?.title).toBe('Callee: beta')
    const test = byId.get('graph:test:tests/a.test.ts')
    expect(test?.text).toBe('test file: tests/a.test.ts')
    expect(test?.title).toBe('Test: tests/a.test.ts')
    expect(test?.nodeType).toBe('test_edge')
    expect(test?.role).toBe('test')
    expect(output.testsFound).toBe(1)
  })

  it('derives node confidence from the edge resolution kind and omits null lines', () => {
    const port = new FixturePort()
    port
      .addSymbol(symbol({ name: 'target', filePath: 'src/t.ts' }))
      .addEdge(edge({ callerSymbolUid: 'uid:c1', calleeSymbolUid: 'uid:target', resolutionKind: 'exact', line: null, callerSymbol: 'c1', calleeSymbol: 'target' }))
      .addEdge(edge({ callerSymbolUid: 'uid:c2', calleeSymbolUid: 'uid:target', resolutionKind: 'heuristic', callerSymbol: 'c2', calleeSymbol: 'target' }))
      .addEdge(edge({ callerSymbolUid: 'uid:c3', calleeSymbolUid: 'uid:target', resolutionKind: null, callerSymbol: 'c3', calleeSymbol: 'target' }))
    const output = graphEnrich({
      hits: [hit('chunk:t', 'src/t.ts', 1, 2, 'target')],
      port,
      limits: BASE_LIMITS,
      tokenBudget: 10_000,
    })
    const byCaller = new Map(output.nodes.map(node => [node.title, node]))
    expect(byCaller.get('Caller: c1')?.confidence).toBe(1.0)
    expect(byCaller.get('Caller: c1')?.startLine).toBeUndefined()
    expect(byCaller.get('Caller: c2')?.confidence).toBe(0.5)
    expect(byCaller.get('Caller: c3')?.confidence).toBe(0)
  })

  it('skips edges without a neighbor uid and deduplicates repeated neighbors', () => {
    const port = new FixturePort()
    port
      .addSymbol(symbol({ name: 'target', filePath: 'src/t.ts' }))
      .addEdge(edge({ callerSymbolUid: null, calleeSymbolUid: 'uid:target', callerSymbol: 'anon', calleeSymbol: 'target' }))
      .addEdge(edge({ callerSymbolUid: 'uid:dup', calleeSymbolUid: 'uid:target', callerSymbol: 'dup', calleeSymbol: 'target' }))
      .addEdge(edge({ callerSymbolUid: 'uid:dup', calleeSymbolUid: 'uid:target', callerSymbol: 'dup', calleeSymbol: 'target' }))
    const output = graphEnrich({
      hits: [hit('chunk:t', 'src/t.ts', 1, 2, 'target')],
      port,
      limits: BASE_LIMITS,
      tokenBudget: 10_000,
    })
    expect(output.callersAdded).toBe(1)
    expect(output.nodes.map(node => node.nodeId)).toEqual(['graph:caller:uid:dup'])
  })

  it('breaks the caller section at the budget instead of skipping oversized entries', () => {
    const port = new FixturePort()
    port.addSymbol(symbol({ name: 'target', filePath: 'src/t.ts' }))
    for (const index of [1, 2, 3, 4, 5]) {
      port.addEdge(edge({ callerSymbolUid: `uid:c${index}`, calleeSymbolUid: 'uid:target', callerSymbol: `c${index}`, calleeSymbol: 'target' }))
    }
    // Budget = floor(100 * 20 / 100) = 20 — exactly two 10-token caller nodes;
    // every short template estimates 10, so the third break clips the rest.
    const output = graphEnrich({
      hits: [hit('chunk:t', 'src/t.ts', 1, 2, 'target')],
      port,
      limits: { ...BASE_LIMITS, graphBudgetPct: 20 },
      tokenBudget: 100,
    })
    expect(output.callersAdded).toBe(2)
    expect(output.nodes).toHaveLength(2)
    expect(output.explain.truncated).toBe(true)
    expect(output.explain.truncatedReason).toBe('output_budget')
    expect(output.explain.isEmpty).toBe(false)
  })

  it('breaks the callee section at the budget', () => {
    const port = new FixturePort()
    port.addSymbol(symbol({ name: 'source', filePath: 'src/s.ts' }))
    for (const index of [1, 2, 3, 4, 5]) {
      port.addEdge(edge({ callerSymbolUid: 'uid:source', calleeSymbolUid: `uid:t${index}`, callerSymbol: 'source', calleeSymbol: `t${index}` }))
    }
    const output = graphEnrich({
      hits: [hit('chunk:s', 'src/s.ts', 1, 2, 'source')],
      port,
      limits: { ...BASE_LIMITS, graphBudgetPct: 20 },
      tokenBudget: 100,
    })
    expect(output.calleesAdded).toBe(2)
    expect(output.nodes.map(node => node.nodeId)).toEqual(['graph:callee:uid:t1', 'graph:callee:uid:t2'])
    expect(output.explain.truncatedReason).toBe('output_budget')
  })

  it('breaks the test section at the budget and dedupes repeated test rows', () => {
    const port = new FixturePort()
    port.addSymbol(symbol({ name: 'coded', filePath: 'src/c.ts' }))
    for (const index of [1, 2, 3, 4, 5]) {
      port.addImpactedTest({ testFilePath: `tests/f${index}.test.ts`, codeFilePath: 'src/c.ts', reason: 'import', confidence: 0.9 })
    }
    port.addImpactedTest({ testFilePath: 'tests/f1.test.ts', codeFilePath: 'src/c.ts', reason: 'import', confidence: 0.9 })
    const output = graphEnrich({
      hits: [hit('chunk:c', 'src/c.ts', 1, 2, 'coded')],
      port,
      limits: { ...BASE_LIMITS, graphBudgetPct: 20 },
      tokenBudget: 100,
    })
    expect(output.testsFound).toBe(2)
    expect(output.nodes.map(node => node.nodeId)).toEqual(['graph:test:tests/f1.test.ts', 'graph:test:tests/f2.test.ts'])
    expect(output.explain.truncatedReason).toBe('output_budget')
  })
})

describe('callee-side node guards', () => {
  it('skips null callee uids, dedupes repeated callees, and defaults missing caller text', () => {
    const port = new FixturePort()
    port.addSymbol(symbol({ name: 'origin', filePath: 'src/o.ts' }))
    port
      .addEdge(edge({ callerSymbolUid: 'uid:origin', calleeSymbolUid: null, filePath: 'src/o.ts', callerSymbol: 'origin', calleeSymbol: 'anonTarget' }))
      .addEdge(edge({ callerSymbolUid: 'uid:origin', calleeSymbolUid: 'uid:t1', filePath: 'src/o.ts', callerSymbol: null, calleeSymbol: 't1', line: null }))
      .addEdge(edge({ callerSymbolUid: 'uid:origin', calleeSymbolUid: 'uid:t1', filePath: 'src/o.ts', callerSymbol: null, calleeSymbol: 't1', line: null }))
    const output = graphEnrich({
      hits: [hit('chunk:o', 'src/o.ts', 1, 2, 'origin')],
      port,
      limits: BASE_LIMITS,
      tokenBudget: 10_000,
    })
    // The anonymous-target edge is skipped, the duplicate callee dedupes, and
    // the surviving node renders the '?' caller fallback without a line.
    expect(output.calleesAdded).toBe(1)
    const node = output.nodes[0]
    expect(node?.nodeId).toBe('graph:callee:uid:t1')
    expect(node?.text).toBe('callee: ? → t1 (src/o.ts:0)')
    expect(node?.title).toBe('Callee: t1')
    expect(node?.startLine).toBeUndefined()
  })
})
