/**
 * Compile-face and discriminant tests for the graph explore vocabulary: every
 * union member constructs, narrows through `op`, and the closed union refuses
 * unknown tags, without any runtime graph implementation existing yet.
 */

import { describe, expect, it } from 'vitest'
import type {
  GraphEdgeView,
  GraphExploreRequest,
  GraphExploreResult,
  GraphNodeView,
  GraphTestPairView,
  SearchHit,
} from '../src/types.ts'

const node: GraphNodeView = {
  nodeId: 'sym:1',
  name: 'routeRequest',
  kind: 'function',
  filePath: 'src/http/router.ts',
  startLine: 3,
  role: 'target',
}

const edge: GraphEdgeView = {
  edgeId: 'edge:1',
  kind: 'CALLS',
  source: 'sym:1',
  target: 'sym:2',
  line: 12,
  callKind: 'direct',
  resolutionStrategy: 'local-exact',
  confidence: 0.9,
  reason: 'direct call in same file',
}

const testPair: GraphTestPairView = {
  testFilePath: 'src/http/router.spec.ts',
  codeFilePath: 'src/http/router.ts',
  reason: 'direct import',
  confidence: 0.8,
}

/** Exhaustive narrowing over the closed request union; the default proves reachability. */
function opOf(request: GraphExploreRequest): GraphExploreResult['op'] {
  switch (request.op) {
    case 'relations': return 'relations'
    case 'impact': return 'impact'
    case 'tests': return 'tests'
    case 'cycles': return 'cycles'
    case 'dead_code': return 'dead_code'
    default: {
      const unreachable: never = request
      return unreachable
    }
  }
}

describe('graph explore vocabulary', () => {
  it('constructs each request member with its discriminant and narrows on it', () => {
    const requests: readonly GraphExploreRequest[] = [
      { op: 'relations', symbol: 'routeRequest', direction: 'callers', depth: 2, max: 10 },
      { op: 'relations', symbol: 'routeRequest', filePath: 'src/http/router.ts' },
      { op: 'impact', symbol: 'routeRequest', includeTests: true, max: 5 },
      { op: 'impact', files: ['src/http/router.ts'] },
      { op: 'tests', files: ['src/http/router.ts'], max: 5 },
      { op: 'cycles', max: 3 },
      { op: 'cycles' },
      { op: 'dead_code', max: 20 },
    ]
    expect(requests.map(opOf)).toEqual(['relations', 'relations', 'impact', 'impact', 'tests', 'cycles', 'cycles', 'dead_code'])
  })

  it('rounds out a complete result view carrying the epoch pair and explain block', () => {
    const result: GraphExploreResult = {
      op: 'relations',
      indexEpoch: { indexEpoch: 4, evidenceEpoch: 0 },
      nodes: [node],
      edges: [edge],
      tests: [testPair],
      explain: {
        declared: ['callersPerSym=3', 'direction=callers'],
        readErrors: ['degrees failed for sym:2'],
        droppedReadErrorCount: 2,
        truncatedReason: 'output-char budget',
      },
      truncated: true,
      candidateCount: 9,
      tier: 'small',
    }
    expect(result.op).toBe('relations')
    expect(result.indexEpoch.indexEpoch).toBe(4)
    expect(result.edges[0]?.source).toBe('sym:1')
    expect(result.explain.droppedReadErrorCount).toBe(2)
  })

  it('keeps the minimal result form legal when tests are absent and nothing truncated', () => {
    const result: GraphExploreResult = {
      op: 'tests',
      indexEpoch: { indexEpoch: 0, evidenceEpoch: 0 },
      nodes: [node],
      edges: [],
      explain: { declared: [], readErrors: [], droppedReadErrorCount: 0 },
      truncated: false,
      candidateCount: 0,
      tier: 'tiny',
    }
    expect(result.tests).toBeUndefined()
    expect(result.explain.truncatedReason).toBeUndefined()
  })

  it('carries cycle components and dead-code candidates as the analysis views', () => {
    const cycles: GraphExploreResult = {
      op: 'cycles',
      indexEpoch: { indexEpoch: 2, evidenceEpoch: 0 },
      nodes: [],
      edges: [],
      cycles: [{
        id: 'cycle:1',
        size: 2,
        severity: 'low',
        memberIds: ['src/a.ts', 'src/b.ts'],
        witnessEdges: [{ from: 'src/a.ts', to: 'src/b.ts', importString: './b' }],
      }],
      explain: { declared: ['IMPORTS'], readErrors: [], droppedReadErrorCount: 0 },
      truncated: false,
      candidateCount: 1,
      tier: 'tiny',
    }
    expect(cycles.cycles?.[0]?.severity).toBe('low')
    expect(cycles.cycles?.[0]?.witnessEdges).toHaveLength(1)

    const deadCode: GraphExploreResult = {
      op: 'dead_code',
      indexEpoch: { indexEpoch: 2, evidenceEpoch: 0 },
      nodes: [],
      edges: [],
      deadCode: [{
        symbolName: 'orphanFn',
        symbolId: 'uid:orphan',
        filePath: 'src/orphan.ts',
        kind: 'function',
        reason: 'no-callers',
      }],
      explain: { declared: ['CALLS', 'REFERENCES'], readErrors: [], droppedReadErrorCount: 0 },
      truncated: false,
      candidateCount: 1,
      tier: 'tiny',
    }
    expect(deadCode.deadCode?.[0]?.reason).toBe('no-callers')
  })
})

describe('search hit graph score', () => {
  const baseHit: SearchHit = {
    chunkId: 'chunk:src/a.ts:0',
    filePath: 'src/a.ts',
    language: 'typescript',
    contentHash: 'hash-a',
    startLine: 1,
    endLine: 4,
    score: 1.5,
    rank: 1,
    reasons: ['lexical@1'],
    scoreTrace: [{ label: 'rrf:lexical', value: 1.5 }],
    parserTier: 'generic',
    parserConfidence: 0.5,
  }

  it('keeps graphScore optional for plain hits and carries it when enriched', () => {
    expect(baseHit.graphScore).toBeUndefined()
    const enriched: SearchHit = { ...baseHit, graphScore: 0.13, reasons: [...baseHit.reasons, 'boost:graph-rerank'] }
    expect(enriched.graphScore).toBe(0.13)
    expect(enriched.reasons).toContain('boost:graph-rerank')
  })
})
