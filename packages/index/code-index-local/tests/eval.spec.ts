/** Retrieval eval harness: deterministic corpus, real workspace, scoped incremental update. */

import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertRetrievalThresholds, evaluateRetrieval, percentile95 } from '../src/eval.ts'
import { LocalCodeIndexRuntime } from '../src/provider.ts'
import { makeWorkspace, sweepWorkspaces } from './support.ts'

afterEach(sweepWorkspaces)

function runtimeFor(root: string): LocalCodeIndexRuntime {
  return new LocalCodeIndexRuntime({
    workspaceRoot: root,
    databasePath: ':memory:',
    journalMode: 'wal',
    excludePatterns: [],
    maxFileBytes: 512_000,
  })
}

describe('evaluateRetrieval', () => {
  it('passes committed TypeScript, Python, and Go fixture repositories', async () => {
    const fixtures = [
      {
        root: join(process.cwd(), 'packages/index/code-index-local/tests/fixtures/eval/typescript'),
        query: 'rotateWorkspaceSessionToken',
        relevantPaths: ['src/session.ts'],
      },
      {
        root: join(process.cwd(), 'packages/index/code-index-local/tests/fixtures/eval/python'),
        query: 'reconcile_embedding_cache_generation',
        relevantPaths: ['pkg/cache.py'],
      },
      {
        root: join(process.cwd(), 'packages/index/code-index-local/tests/fixtures/eval/go'),
        query: 'ResolveTenantShardRoute',
        relevantPaths: ['service/router.go'],
      },
    ]
    for (const [index, fixture] of fixtures.entries()) {
      const runtime = runtimeFor(fixture.root)
      const report = await evaluateRetrieval(runtime, [{
        id: `fixture-${index}`,
        query: fixture.query,
        relevantPaths: fixture.relevantPaths,
      }])
      expect(report).toMatchObject({ recallAt5: 1, mrr: 1 })
      await runtime.dispose()
    }
  })

  it('computes exact Recall@5 and MRR over a deterministic corpus through the public seam', async () => {
    const root = await makeWorkspace('rlh-eval-corpus-', {
      files: {
        'auth/token-validator.ts': 'export function validateBearerToken(token: string) { return token.length > 10 }\n',
        'billing/invoice-total.ts': 'export function calculateInvoiceTotal(lines: number[]) { return lines.reduce((a, b) => a + b, 0) }\n',
        'shared/request-id.ts': 'export const correlationRequestId = "relay-request"\n',
      },
    })
    const runtime = runtimeFor(root)
    const report = await evaluateRetrieval(runtime, [
      { id: 'auth', query: 'validateBearerToken', relevantPaths: ['auth/token-validator.ts'] },
      { id: 'billing', query: 'calculateInvoiceTotal', relevantPaths: ['billing/invoice-total.ts'] },
    ])
    expect(report).toMatchObject({ recallAt5: 1, mrr: 1 })
    expect(report.cases.map(item => item.retrievedPaths[0])).toEqual([
      'auth/token-validator.ts',
      'billing/invoice-total.ts',
    ])
    await runtime.dispose()
  })

  it('smokes the checked-out package as a real workspace corpus', async () => {
    const root = join(process.cwd(), 'packages/index/code-index-local')
    const runtime = runtimeFor(root)
    const report = await evaluateRetrieval(runtime, [{
      id: 'refresh-path-normalizer',
      query: 'normalizeRefreshPaths workspace escape',
      relevantPaths: ['src/provider.ts'],
    }])
    expect(report.recallAt5).toBe(1)
    expect(report.mrr).toBeGreaterThan(0)
    await runtime.dispose()
  }, 30_000)

  it('measures a single-file scoped incremental admission without rebuilding unrelated rows', async () => {
    const root = await makeWorkspace('rlh-eval-incremental-', {
      files: {
        'src/stable.ts': 'export const stableBaselineMarker = 1\n',
        'src/changed.ts': 'export const priorMarker = 1\n',
      },
    })
    const runtime = runtimeFor(root)
    await runtime.refresh({ reason: 'manual' })
    await writeFile(join(root, 'src/changed.ts'), 'export function incrementalOrbitReconciler() { return 7 }\n')
    const summary = await runtime.refresh({ reason: 'stale', paths: ['src/changed.ts'] })
    expect(summary).toMatchObject({ changedFiles: 1, removedFiles: 0 })
    const report = await evaluateRetrieval(runtime, [{
      id: 'incremental-one-file',
      query: 'incrementalOrbitReconciler',
      relevantPaths: ['src/changed.ts'],
    }])
    expect(report).toMatchObject({ recallAt5: 1, mrr: 1 })
    expect((await runtime.search({ query: 'stableBaselineMarker' })).hits[0]?.filePath).toBe('src/stable.ts')
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  })

  it('enforces executable Recall@5, MRR, and incremental-p95 CI thresholds', async () => {
    const root = await makeWorkspace('rlh-eval-threshold-', {
      files: { 'src/gate.ts': 'export const executableEvalGateMarker = 0\n' },
    })
    const runtime = runtimeFor(root)
    await runtime.refresh({ reason: 'manual' })
    const durations: number[] = []
    for (let revision = 1; revision <= 7; revision++) {
      await writeFile(join(root, 'src/gate.ts'), `export const executableEvalGateMarker = ${revision}\n`)
      durations.push((await runtime.refresh({ reason: 'stale', paths: ['src/gate.ts'] })).durationMs)
    }
    const report = await evaluateRetrieval(runtime, [{
      id: 'ci-gate',
      query: 'executableEvalGateMarker',
      relevantPaths: ['src/gate.ts'],
    }])
    expect(assertRetrievalThresholds(report, durations, {
      minRecallAt5: 1,
      minMrr: 1,
      maxIncrementalP95Ms: 2_000,
    })).toEqual({ recallAt5: 1, mrr: 1, incrementalP95Ms: percentile95(durations) })
    expect(() => assertRetrievalThresholds(report, durations, {
      minRecallAt5: 1.1,
      minMrr: 1,
      maxIncrementalP95Ms: 2_000,
    })).toThrow(/Recall@5/u)
    await runtime.dispose()
  })
})
