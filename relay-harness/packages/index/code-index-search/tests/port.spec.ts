/**
 * Port-shape specs for the fake index: the graph facet must satisfy
 * `GraphReadFacet`, answer empty while its data slot is empty, and reflect
 * injected rows so later graph specs can pin behavior without SQLite.
 */

import { describe, expect, it } from 'vitest'
import type { GraphReadFacet, RetrievalPort } from '../src/port.ts'
import { emptyGraphData, InMemoryIndex } from './fake-index.ts'

const symbol = {
  symbolId: 'sym:1',
  symbolUid: 'uid:routeRequest',
  name: 'routeRequest',
  kind: 'function',
  filePath: 'src/http/router.ts',
  container: null,
  startLine: 3,
  endLine: 9,
  qname: null,
  signature: null,
}

describe('retrieval port graph facet (fixture)', () => {
  it('carries a graph facet on every retrieval port and answers empty before injection', () => {
    const index = new InMemoryIndex()
    const port: RetrievalPort = index
    const facet: GraphReadFacet = port.graph
    expect(facet).toBe(index.graph)
    expect(facet.symbolSeedHits('route', 5)).toEqual([])
    expect(facet.symbolUidsByExactNames(['routeRequest'], 5)).toEqual([])
    expect(facet.callerRowsByUids(['uid:routeRequest'], 5)).toEqual([])
    expect(facet.calleeRowsByUids(['uid:routeRequest'], 5)).toEqual([])
    expect(facet.symbolRowsByUids(['uid:routeRequest'])).toEqual([])
    expect(facet.symbolDegreeDetailsBatch(['uid:routeRequest']))
      .toEqual([{ symbolUid: 'uid:routeRequest', inDegree: 0, outDegree: 0, refCount: 0 }])
    expect(facet.chunkSpansForFiles(['src/http/router.ts'])).toEqual([])
    expect(facet.symbolsByFilePaths(['src/http/router.ts'])).toEqual([])
    expect(facet.importsByFilePaths(['src/http/router.ts'])).toEqual([])
    expect(facet.findImpactedTests(['src/http/router.ts'])).toEqual([])
    expect(facet.exportFingerprints(['src/http/router.ts'])).toEqual([])
    expect(facet.literalRowsByFilePaths(['src/http/router.ts'])).toEqual([])
  })

  it('projects injected graph rows through seed, degree, and file-slot queries', () => {
    const index = new InMemoryIndex()
    index.graphData = {
      ...emptyGraphData(),
      symbols: [symbol],
      callEdges: [{
        filePath: 'src/http/router.ts',
        line: 12,
        callerSymbol: 'routeRequest',
        calleeSymbol: 'dispatch',
        callerSymbolUid: 'uid:routeRequest',
        calleeSymbolUid: 'uid:dispatch',
        resolutionKind: 'resolved',
        dispatchKind: 'direct',
        callKind: 'direct',
      }],
      imports: [{
        filePath: 'src/http/router.ts',
        importString: './dispatch',
        resolvedPath: 'src/http/dispatch.ts',
        importedName: 'dispatch',
        alias: null,
        isNamespace: false,
        isDefault: true,
        isReexport: false,
      }],
      chunkSpans: [{ filePath: 'src/http/router.ts', chunkId: 'chunk:src/http/router.ts:0', startLine: 1, endLine: 20 }],
      degrees: [{ symbolUid: 'uid:routeRequest', inDegree: 2, outDegree: 1, refCount: 4 }],
      impactedTests: [{
        testFilePath: 'src/http/router.spec.ts',
        codeFilePath: 'src/http/router.ts',
        reason: 'direct import',
        confidence: 0.8,
      }],
      exportFingerprints: [{ filePath: 'src/http/router.ts', fingerprint: 'fp-1' }],
      literals: [{
        literalId: 'lit:1',
        filePath: 'src/http/router.ts',
        literal: 'GET',
        literalKind: 'string',
        line: 5,
        container: null,
        confidence: null,
        enclosingSymbolUid: null,
      }],
    }

    expect(index.graph.symbolSeedHits('routerequest', 5)).toEqual([{
      symbolUid: 'uid:routeRequest',
      name: 'routeRequest',
      score: 1,
    }])
    expect(index.graph.symbolUidsByExactNames(['routeRequest'], 5)).toEqual([symbol])
    expect(index.graph.callerRowsByUids(['uid:routeRequest'], 5)).toEqual([{
      seedUid: 'uid:routeRequest',
      filePath: 'src/http/router.ts',
      line: 12,
      callerSymbol: 'routeRequest',
      calleeSymbol: 'dispatch',
      callerSymbolUid: 'uid:routeRequest',
      calleeSymbolUid: 'uid:dispatch',
      resolutionKind: 'resolved',
      dispatchKind: 'direct',
      callKind: 'direct',
    }])
    expect(index.graph.calleeRowsByUids(['uid:dispatch'], 5)).toEqual([
      expect.objectContaining({ seedUid: 'uid:dispatch', calleeSymbolUid: 'uid:dispatch' }),
    ])
    expect(index.graph.symbolRowsByUids(['uid:routeRequest'])).toEqual([symbol])
    expect(index.graph.symbolDegreeDetailsBatch(['uid:routeRequest']))
      .toEqual([{ symbolUid: 'uid:routeRequest', inDegree: 2, outDegree: 1, refCount: 4 }])
    expect(index.graph.chunkSpansForFiles(['src/http/router.ts']))
      .toEqual([{ filePath: 'src/http/router.ts', chunkId: 'chunk:src/http/router.ts:0', startLine: 1, endLine: 20 }])
    expect(index.graph.symbolsByFilePaths(['src/http/router.ts'])).toEqual([symbol])
    expect(index.graph.importsByFilePaths(['src/http/router.ts']))
      .toEqual([expect.objectContaining({ resolvedPath: 'src/http/dispatch.ts' })])
    expect(index.graph.findImpactedTests(['src/http/router.ts']))
      .toEqual([expect.objectContaining({ testFilePath: 'src/http/router.spec.ts' })])
    expect(index.graph.exportFingerprints(['src/http/router.ts']))
      .toEqual([{ filePath: 'src/http/router.ts', fingerprint: 'fp-1' }])
    expect(index.graph.literalRowsByFilePaths(['src/http/router.ts']))
      .toEqual([expect.objectContaining({ literal: 'GET' })])

    // Substring seed matching with an exact-name tiebreak: the shorter exact hit leads.
    index.graphData = {
      ...index.graphData,
      symbols: [
        symbol,
        { ...symbol, symbolId: 'sym:2', symbolUid: 'uid:routeRequestHandler', name: 'routeRequestHandler' },
      ],
    }
    expect(index.graph.symbolSeedHits('routeRequest', 5).map(hit => hit.name))
      .toEqual(['routeRequest', 'routeRequestHandler'])
  })
})
