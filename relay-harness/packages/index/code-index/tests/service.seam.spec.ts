/**
 * Tests for the code-index Service Definition: a minimal concrete subclass registers as
 * `ctx.codeIndex`, a second load throws (duplicate service), and disposal releases it.
 * Storage, scanning, and ranking behavior are the provider's concern; here we only pin the
 * seam contract.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { CodeIndex } from '../src/index.ts'
import type {
  GraphExploreRequest,
  GraphExploreResult,
  IndexStatusReport,
  RefreshOptions,
  RefreshSummary,
  SearchRequest,
  SearchResult,
} from '../src/types.ts'

const status: IndexStatusReport = {
  indexedFileCount: 0,
  tier: 'tiny',
  epochs: { indexEpoch: 0, evidenceEpoch: 0 },
  degraded: false,
}

/** Minimal concrete backend: echoes a fixed answer for each seam verb. */
class StubIndex extends CodeIndex {
  async status(): Promise<IndexStatusReport> {
    return status
  }

  async refresh(options?: RefreshOptions): Promise<RefreshSummary> {
    return {
      reason: options?.reason ?? 'manual',
      changedFiles: 0,
      removedFiles: 0,
      chunksWritten: 0,
      durationMs: 0,
      epochsAfter: status.epochs,
    }
  }

  async search(request: SearchRequest): Promise<SearchResult> {
    return {
      query: request.query,
      tier: status.tier,
      hits: [],
      candidateCount: 0,
      epochs: status.epochs,
      truncated: false,
      degraded: false,
      readErrors: [],
    }
  }

  async exploreGraph(request: GraphExploreRequest): Promise<GraphExploreResult> {
    return {
      op: request.op,
      indexEpoch: status.epochs,
      nodes: [],
      edges: [],
      explain: { declared: ['CALLS'], readErrors: [], droppedReadErrorCount: 0 },
      truncated: false,
      candidateCount: 0,
      tier: status.tier,
    }
  }
}

describe('code-index seam', () => {
  it('registers as ctx.codeIndex and answers every seam verb', async () => {
    const ctx = new Context()
    await ctx.plugin(StubIndex)
    await expect(ctx.codeIndex.status()).resolves.toBe(status)
    const summary = await ctx.codeIndex.refresh({ reason: 'lazy' })
    expect(summary.reason).toBe('lazy')
    const result = await ctx.codeIndex.search({ query: 'login' })
    expect(result.query).toBe('login')
    expect(result.hits).toEqual([])
    const graph = await ctx.codeIndex.exploreGraph({ op: 'relations', symbol: 'login' })
    expect(graph.op).toBe('relations')
    expect(graph.indexEpoch).toBe(status.epochs)
  })

  it('rejects a second implementation (one per context)', async () => {
    const ctx = new Context()
    await ctx.plugin(StubIndex)
    await expect(ctx.plugin(StubIndex)).rejects.toThrow()
  })

  it('releases the service on disposal', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(StubIndex)
    expect(ctx.codeIndex).toBeInstanceOf(StubIndex)
    await fiber.dispose()
    expect((ctx as Context & { codeIndex?: unknown }).codeIndex).toBeUndefined()
  })
})
