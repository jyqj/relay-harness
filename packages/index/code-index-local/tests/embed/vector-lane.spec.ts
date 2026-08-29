/**
 * Vector lane end to end: fake embeddings endpoint + real derived store.
 *
 * Covers the full R5 data path — refresh enqueues the committed batch, the
 * drain converges into `chunks_vec`, searches embed their query and feed the
 * vector lane, the graph result cache respects embedding-epoch movement, and
 * every failure mode degrades honestly instead of fabricating vector
 * contributions or pinning sticky status.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import CodeIndexLocal, { resolveEmbeddingConfig } from '../../src/index.ts'
import type { EmbeddingConfig } from '../../src/index.ts'
import {
  createQueryVectorCache,
  embedQueryVector,
  isLaneFailureReadError,
  LocalCodeIndexRuntime,
  QUERY_VECTOR_CACHE_CAPACITY,
} from '../../src/provider.ts'
import type { LocalEmbeddingRuntimeConfig } from '../../src/provider.ts'
import { EMBED_RESPONSE_INVALID } from '../../src/embed/errors.ts'
import type { EmbedderLike } from '../../src/embed/worker.ts'
import { startFakeEmbedServer, type FakeEmbedServer } from './fake-server.ts'
import { makeWorkspace, sweepWorkspaces } from '../support.ts'

const servers: FakeEmbedServer[] = []
const trackedDirs: string[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
  for (const dir of trackedDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  await sweepWorkspaces()
})

/** Resolve an endpoint configuration with the suite's small budgets and a usable credential. */
function embeddingFor(config: EmbeddingConfig): LocalEmbeddingRuntimeConfig {
  process.env['RLH_VEC_TEST_EMBED_KEY'] = 'test-key'
  const resolved = resolveEmbeddingConfig({ apiKeyEnv: 'RLH_VEC_TEST_EMBED_KEY', ...config })
  if (resolved === undefined) throw new Error('fixture embedding configuration must resolve')
  return resolved
}

function runtimeFor(root: string, embedding?: LocalEmbeddingRuntimeConfig, databasePath = ':memory:'): LocalCodeIndexRuntime {
  return new LocalCodeIndexRuntime({
    workspaceRoot: root,
    databasePath,
    journalMode: 'wal',
    excludePatterns: [],
    maxFileBytes: 512_000,
    ...(embedding === undefined ? {} : { embedding }),
  })
}

/** The exact chunk text used as a query, so the fake endpoint reproduces its vector. */
const STRIDE_LINE = 'export function quantizedHarmonicStride() { return 42 }\n'

async function strideWorkspace(): Promise<string> {
  return makeWorkspace('rlh-vec-e2e-', {
    files: {
      'src/stride.ts': STRIDE_LINE,
      'src/other.ts': 'export const unrelatedConstant = 7\n',
    },
  })
}

function hasVectorReason(answer: { hits: ReadonlyArray<{ reasons: readonly string[] }> }): boolean {
  return answer.hits.some(hit => hit.reasons.some(reason => reason.startsWith('vector@')))
}

describe('configured embedding tier end to end', () => {
  it('backfills unchanged chunks when embedding is enabled after indexing', async () => {
    const dbDir = await mkdtemp(join(tmpdir(), 'rlh-vec-enable-db-'))
    trackedDirs.push(dbDir)
    const databasePath = join(dbDir, 'derived.sqlite3')
    const root = await strideWorkspace()
    const withoutEmbedding = runtimeFor(root, undefined, databasePath)
    await withoutEmbedding.refresh({ reason: 'manual' })
    await withoutEmbedding.dispose()

    const server = await startFakeEmbedServer({ dim: 16 })
    servers.push(server)
    const enabled = runtimeFor(root, embeddingFor({
      baseURL: server.url,
      model: 'fake-embed',
      dimensions: 16,
      timeoutMs: 2_000,
    }), databasePath)
    await enabled.ensureOpen()
    await enabled.embedDrainIdle()
    expect(enabled.vectorStatus()).toMatchObject({ pendingJobs: 0 })
    expect(enabled.vectorStatus()?.vectorizedChunks).toBeGreaterThan(0)
    expect(enabled.status().epochs.embeddingEpoch).toBeGreaterThan(0)
    expect(enabled.status().epochs.evidenceEpoch).toBe(0)
    await enabled.dispose()
  })

  it('converges refresh → enqueue → drain into chunks_vec and ranks with the vector lane', async () => {
    const server = await startFakeEmbedServer({ dim: 16 })
    servers.push(server)
    const root = await strideWorkspace()
    const runtime = runtimeFor(root, embeddingFor({
      baseURL: server.url,
      model: 'fake-embed',
      timeoutMs: 2_000,
      maxJobsPerDrain: 16,
      maxPromptTokensPerDrain: 100_000,
    }))

    const summary = await runtime.refresh({ reason: 'manual' })
    expect(summary.chunksWritten).toBeGreaterThan(0)
    await runtime.embedDrainIdle()

    const vectors = runtime.vectorStatus()
    expect(vectors).toMatchObject({ model: 'fake-embed', pendingJobs: 0 })
    expect(vectors?.vectorizedChunks).toBeGreaterThan(0)
    expect(vectors?.totalChunks).toBeGreaterThanOrEqual(vectors?.vectorizedChunks ?? 0)
    const management = runtime.managementStatus()
    expect(management.chunkCount).toBe(vectors?.totalChunks)
    expect(management.generations[0]).toMatchObject({ model: 'fake-embed', vectorizedChunks: vectors?.vectorizedChunks })
    expect(runtime.status().epochs.embeddingEpoch).toBeGreaterThanOrEqual(1)
    expect(runtime.status().epochs.evidenceEpoch).toBe(0)
    const embeddingExplain = runtime.status().lastRefresh?.explain?.embedding
    expect(typeof embeddingExplain?.missingChunks).toBe('number')
    expect(typeof embeddingExplain?.jobsEnqueued).toBe('number')
    expect(typeof embeddingExplain?.batchesClaimed).toBe('number')
    expect(typeof embeddingExplain?.batchesWritten).toBe('number')
    expect(typeof embeddingExplain?.jobsCompleted).toBe('number')
    expect(embeddingExplain?.jobsFailed).toBe(0)

    // The query text equals a chunk's text, so its embedding is that chunk's
    // own direction: the vector lane must rank it and annotate the hit.
    const answer = await runtime.search({ query: STRIDE_LINE.trim() })
    expect(hasVectorReason(answer)).toBe(true)
    expect(answer.degraded).toBe(false)

    // A repeat query is served from the memo — no new endpoint request.
    const requestsAfterFirst = server.requests.length
    await runtime.search({ query: STRIDE_LINE.trim() })
    expect(server.requests.length).toBe(requestsAfterFirst)
    await runtime.dispose()
  })

  it('serves a byte-identical cached answer until evidence lands, then recomputes', async () => {
    const server = await startFakeEmbedServer({ dim: 16 })
    servers.push(server)
    const root = await strideWorkspace()
    const runtime = runtimeFor(root, embeddingFor({
      baseURL: server.url,
      model: 'fake-embed',
      timeoutMs: 2_000,
      maxJobsPerDrain: 16,
      maxPromptTokensPerDrain: 100_000,
    }))
    await runtime.refresh({ reason: 'manual' })
    await runtime.embedDrainIdle()

    const first = await runtime.search({ query: STRIDE_LINE.trim() })
    const cached = await runtime.search({ query: STRIDE_LINE.trim() })
    // The graph result cache is live: the repeat call returns the same outcome.
    expect(cached).toBe(first)
    const embeddingBefore = first.epochs.embeddingEpoch ?? 0

    // A content revision re-enqueues its chunks; draining them advances the
    // evidence clock. The cached entry (keyed on the epoch pair) must miss.
    await writeFile(join(root, 'src/other.ts'), 'export const unrelatedConstant = 707\n')
    await runtime.refresh({ reason: 'manual' })
    await runtime.embedDrainIdle()
    const embeddingAfter = runtime.status().epochs.embeddingEpoch ?? 0
    expect(embeddingAfter).toBeGreaterThan(embeddingBefore)

    const recomputed = await runtime.search({ query: STRIDE_LINE.trim() })
    expect(recomputed).not.toBe(first)
    // A stale cache hit would still carry the pre-drain epoch pair.
    expect(recomputed.epochs.embeddingEpoch).toBe(embeddingAfter)
    await runtime.dispose()
  })
})

describe('unconfigured tier keeps prior behavior', () => {
  it('never registers vector surfaces and leaves epochs and answers untouched', async () => {
    const root = await strideWorkspace()
    const runtime = runtimeFor(root)
    await runtime.refresh({ reason: 'manual' })
    await runtime.embedDrainIdle()

    expect(runtime.vectorStatus()).toBeUndefined()
    const answer = await runtime.search({ query: 'quantizedHarmonicStride' })
    expect(answer.degraded).toBe(false)
    expect(answer.readErrors).toEqual([])
    expect(hasVectorReason(answer)).toBe(false)
    expect(runtime.status().epochs.evidenceEpoch).toBe(0)
    await runtime.dispose()
  })
})

describe('runtime-unavailable embedding degrades honestly', () => {
  it('degrades the answer on an unreachable query embedder without sticky status', async () => {
    const server = await startFakeEmbedServer({ dim: 16 })
    servers.push(server)
    const root = await strideWorkspace()
    const runtime = runtimeFor(root, embeddingFor({ baseURL: server.url, model: 'fake-embed', timeoutMs: 2_000 }))
    await runtime.refresh({ reason: 'manual' })
    await runtime.embedDrainIdle()
    await server.close()

    const answer = await runtime.search({ query: STRIDE_LINE.trim() })
    expect(answer.degraded).toBe(true)
    expect(answer.readErrors.some(entry => entry.startsWith('query embedding failed'))).toBe(true)
    // No fabricated vector contribution for the failed embedding.
    expect(hasVectorReason(answer)).toBe(false)
    // A transient embedder outage is not a lane failure: status stays clean.
    expect(runtime.status().degraded).toBe(false)
    await runtime.dispose()
  })

  it('refuses a blank credential loudly on every operation without pinning status', async () => {
    delete process.env['RLH_VEC_TEST_UNSET_KEY']
    const root = await strideWorkspace()
    const runtime = runtimeFor(root, embeddingFor({
      baseURL: 'http://127.0.0.1:1',
      model: 'fake-embed',
      apiKeyEnv: 'RLH_VEC_TEST_UNSET_KEY',
    }))
    await runtime.refresh({ reason: 'manual' })
    await runtime.embedDrainIdle()
    // The drain could not even construct its client; the diagnosis is recorded.
    expect(runtime.vectorStatus()?.lastDrainError).toContain('API key')

    const answer = await runtime.search({ query: STRIDE_LINE.trim() })
    expect(answer.degraded).toBe(true)
    expect(answer.readErrors.some(entry => entry.includes('query embedding failed'))).toBe(true)
    expect(runtime.status().degraded).toBe(false)
    await runtime.dispose()
  })

  it('records drain failures without failing the committed refresh', async () => {
    const server = await startFakeEmbedServer({ dim: 16 })
    const root = await strideWorkspace()
    const runtime = runtimeFor(root, embeddingFor({ baseURL: server.url, model: 'fake-embed', timeoutMs: 2_000 }))
    await server.close()

    const summary = await runtime.refresh({ reason: 'manual' })
    expect(summary.changedFiles).toBeGreaterThan(0)
    await runtime.embedDrainIdle()

    // The endpoint is gone: jobs stay queued (settled back with attempts
    // burned), nothing embedded, and the committed refresh never failed.
    const vectors = runtime.vectorStatus()
    expect(vectors?.pendingJobs).toBeGreaterThan(0)
    expect(vectors?.vectorizedChunks).toBe(0)
    expect(runtime.status().degraded).toBe(false)
    const explain = runtime.status().lastRefresh?.explain
    expect(explain?.degraded).toBe(true)
    expect(explain?.degradationReasons).toContain('embedding-jobs-failed')
    await runtime.dispose()
  })
})

describe('generation isolation and lane-failure degradation', () => {
  it('backfills a distinct endpoint/dimension generation instead of mixing same-model vectors', async () => {
    const dbDir = await mkdtemp(join(tmpdir(), 'rlh-vec-db-'))
    trackedDirs.push(dbDir)
    const databasePath = join(dbDir, 'derived.sqlite3')
    const chunkServer = await startFakeEmbedServer({ dim: 16 })
    servers.push(chunkServer)
    const root = await strideWorkspace()

    // Generation A embeds chunks at 16 dimensions into the shared file store.
    const runtimeA = runtimeFor(
      root,
      embeddingFor({ baseURL: chunkServer.url, model: 'fake-embed', timeoutMs: 2_000 }),
      databasePath,
    )
    await runtimeA.refresh({ reason: 'manual' })
    await runtimeA.embedDrainIdle()
    await runtimeA.dispose()

    // Generation B shares the model string but changes endpoint and dimensions.
    // Its coverage reconciler must backfill instead of reading generation A.
    const queryServer = await startFakeEmbedServer({ dim: 8 })
    servers.push(queryServer)
    const runtimeB = runtimeFor(
      root,
      embeddingFor({ baseURL: queryServer.url, model: 'fake-embed', dimensions: 8, timeoutMs: 2_000 }),
      databasePath,
    )
    await runtimeB.embedDrainIdle()
    const answer = await runtimeB.search({ query: STRIDE_LINE.trim() })
    expect(answer.degraded).toBe(false)
    expect(hasVectorReason(answer)).toBe(true)
    expect(runtimeB.vectorStatus()?.vectorizedChunks).toBeGreaterThan(0)
    expect(runtimeB.status().epochs.evidenceEpoch).toBe(0)
    await runtimeB.dispose()
    const inspector = new DatabaseSync(databasePath)
    expect((inspector.prepare('SELECT COUNT(*) AS n FROM embedding_generations').get() as { n: number }).n).toBe(2)
    expect((inspector.prepare('SELECT COUNT(DISTINCT generation_id) AS n FROM chunks_vec').get() as { n: number }).n).toBe(2)
    inspector.close()
  })

  it('pins sticky status even when the same answer also lost its query embedding', async () => {
    const dbDir = await mkdtemp(join(tmpdir(), 'rlh-vec-db-'))
    trackedDirs.push(dbDir)
    const databasePath = join(dbDir, 'derived.sqlite3')
    const server = await startFakeEmbedServer({ dim: 16 })
    servers.push(server)
    const root = await strideWorkspace()
    const runtimeA = runtimeFor(
      root,
      embeddingFor({ baseURL: server.url, model: 'fake-embed', timeoutMs: 2_000 }),
      databasePath,
    )
    await runtimeA.refresh({ reason: 'manual' })
    await runtimeA.embedDrainIdle()
    await runtimeA.dispose()
    await server.close()

    // Rename a read column inside a registered table: the inventory check
    // still admits the store, but the lexical lane's candidate query aborts
    // whole (a lane failure) while everything else stays readable.
    const raw = new DatabaseSync(databasePath)
    raw.exec('ALTER TABLE files RENAME COLUMN language TO language_unreadable')
    raw.close()

    // The query embedder is gone too, so this answer reaches search's
    // query-embedding early return WITH a lane failure in its base readErrors.
    const runtimeB = runtimeFor(
      root,
      embeddingFor({ baseURL: 'http://127.0.0.1:1', model: 'fake-embed', timeoutMs: 2_000 }),
      databasePath,
    )
    const answer = await runtimeB.search({ query: STRIDE_LINE.trim() })
    expect(answer.degraded).toBe(true)
    expect(answer.readErrors.join('\n')).toContain('lexical lane failed')
    expect(answer.readErrors.some(entry => entry.startsWith('query embedding failed'))).toBe(true)
    // The lane failure must pin the sticky flag despite the early return.
    expect(runtimeB.status().degraded).toBe(true)
    await runtimeB.dispose()
  })
})

describe('deterministic flush hooks', () => {
  it('aborts an in-flight drain on dispose so the queue never fights a closed handle', async () => {
    const server = await startFakeEmbedServer({ dim: 16, behaviors: ['slow'] })
    servers.push(server)
    const root = await strideWorkspace()
    const runtime = runtimeFor(root, embeddingFor({ baseURL: server.url, model: 'fake-embed', timeoutMs: 5_000 }))

    await runtime.refresh({ reason: 'manual' })
    const deadline = Date.now() + 2_000
    while (server.requests.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(server.requests.length).toBeGreaterThan(0)

    await runtime.dispose()
    // The aborted drain resolves cleanly; the runtime refuses further work.
    await expect(runtime.embedDrainIdle()).resolves.toBeUndefined()
    expect(() => runtime.status()).toThrow('disposed')
  })

  it('folds a catch-up refresh into the drain already in flight without a lost final wakeup', async () => {
    const server = await startFakeEmbedServer({ dim: 16, behaviors: ['slow'] })
    servers.push(server)
    const root = await strideWorkspace()
    const runtime = runtimeFor(root, embeddingFor({ baseURL: server.url, model: 'fake-embed', timeoutMs: 5_000 }))

    await runtime.refresh({ reason: 'manual' })
    const deadline = Date.now() + 2_000
    while (server.requests.length === 0 && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    // The first drain is still mid-request when the second pass commits: its
    // catch-up must fold into the running drain instead of double-claiming.
    await writeFile(join(root, 'src/other.ts'), 'export const unrelatedConstant = 707\n')
    await runtime.refresh({ reason: 'manual' })

    await runtime.embedDrainIdle()
    expect(runtime.vectorStatus()).toMatchObject({ pendingJobs: 0 })
    expect(runtime.vectorStatus()?.vectorizedChunks).toBe(runtime.vectorStatus()?.totalChunks)
    await runtime.dispose()
    await expect(runtime.embedDrainIdle()).resolves.toBeUndefined()
    expect(() => runtime.status()).toThrow('disposed')
  })

  it('enqueues nothing for a pass whose changed files carry no chunks', async () => {
    const server = await startFakeEmbedServer({ dim: 16 })
    servers.push(server)
    const root = await strideWorkspace()
    // A 1-byte ceiling: every file records a row without chunks, so the
    // committed batch has no chunk rows to embed.
    const runtime = new LocalCodeIndexRuntime({
      workspaceRoot: root,
      databasePath: ':memory:',
      journalMode: 'wal',
      excludePatterns: [],
      maxFileBytes: 1,
      embedding: embeddingFor({ baseURL: server.url, model: 'fake-embed', timeoutMs: 2_000 }),
    })
    await runtime.refresh({ reason: 'manual' })
    await runtime.embedDrainIdle()

    const vectors = runtime.vectorStatus()
    expect(vectors?.totalChunks).toBe(0)
    expect(vectors?.vectorizedChunks).toBe(0)
    expect(vectors?.pendingJobs).toBe(0)
    await runtime.dispose()
  })
})

describe('embedQueryVector memo', () => {
  it('serves repeat queries from the memo and embeds misses once', async () => {
    const embedded: string[] = []
    const client: EmbedderLike = {
      model: 'fake-embed',
      embed: async (texts) => {
        embedded.push(...texts)
        return { vectors: texts.map(text => Float32Array.from([text.length, 1])), promptTokens: 1 }
      },
    }
    const cache = createQueryVectorCache()
    const first = await embedQueryVector(client, 'alpha beta', cache, { model: 'fake-embed', dimensions: 2 })
    const second = await embedQueryVector(client, 'alpha beta', cache, { model: 'fake-embed', dimensions: 2 })
    expect(second).toBe(first)
    expect(embedded).toEqual(['alpha beta'])
    await embedQueryVector(client, 'gamma', cache, { model: 'fake-embed', dimensions: 2 })
    expect(embedded).toEqual(['alpha beta', 'gamma'])
  })

  it('refuses an empty embedding reply instead of caching a missing vector', async () => {
    const client: EmbedderLike = {
      model: 'fake-embed',
      embed: async () => ({ vectors: [], promptTokens: 0 }),
    }
    await expect(embedQueryVector(client, 'alpha', createQueryVectorCache(), { model: 'fake-embed' }))
      .rejects.toMatchObject({ code: EMBED_RESPONSE_INVALID })
  })

  it('evicts the oldest entry once full', () => {
    const cache = createQueryVectorCache(2)
    expect(QUERY_VECTOR_CACHE_CAPACITY).toBe(32)
    const first = Float32Array.from([1])
    const second = Float32Array.from([2])
    const third = Float32Array.from([3])
    cache.set('a', first)
    cache.set('b', second)
    expect(cache.get('a')).toBe(first)
    cache.set('c', third)
    expect(cache.size).toBe(2)
    expect(cache.get('b')).toBeUndefined()
    expect(cache.get('a')).toBe(first)
    expect(cache.get('c')).toBe(third)
  })
})

describe('plugin-level wiring', () => {
  it('boots the embedding tier from plugin config and drains through the flush hook', async () => {
    process.env['RLH_VEC_TEST_EMBED_KEY'] = 'test-key'
    const server = await startFakeEmbedServer({ dim: 16 })
    servers.push(server)
    const root = await strideWorkspace()
    const ctx = new Context()
    try {
      await ctx.plugin(CodeIndexLocal, {
        workspaceRoot: root,
        databasePath: ':memory:',
        embedding: {
          apiKeyEnv: 'RLH_VEC_TEST_EMBED_KEY',
          baseURL: server.url,
          model: 'fake-embed',
          timeoutMs: 2_000,
        },
      })
      const provider = ctx.get('codeIndex') as CodeIndexLocal
      await provider.refreshInternal({ reason: 'manual' })
      await provider.embedDrainIdle()

      const answer = await provider.search({ query: STRIDE_LINE.trim() })
      expect(hasVectorReason(answer)).toBe(true)
      expect((await provider.status()).degraded).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('embedding configuration resolution', () => {
  it('removes the tier unless both endpoint anchors are present', () => {
    expect(resolveEmbeddingConfig(undefined)).toBeUndefined()
    expect(resolveEmbeddingConfig({ model: 'm' })).toBeUndefined()
    expect(resolveEmbeddingConfig({ baseURL: 'http://x', model: '  ' })).toBeUndefined()
    const resolved = resolveEmbeddingConfig({ baseURL: 'http://x/', model: ' m ' })
    expect(resolved).toMatchObject({
      apiKeyEnv: 'EMBEDDING_API_KEY',
      baseURL: 'http://x/',
      model: 'm',
      batchSize: 32,
      timeoutMs: 30_000,
      maxInputsPerRequest: 16,
      maxPromptTokensPerDrain: 200_000,
      maxJobsPerDrain: 256,
      vectorWeight: 0.9,
      vectorTopK: 12,
      vectorMaxCandidates: 2_000,
    })
    expect(resolved?.dimensions).toBeUndefined()
  })

  it('keeps explicit knobs and fails loud on invalid ones', () => {
    const resolved = resolveEmbeddingConfig({
      baseURL: 'http://x',
      model: 'm',
      apiKeyEnv: 'MY_KEY',
      dimensions: 8,
      vectorWeight: 1.25,
    })
    expect(resolved).toMatchObject({ apiKeyEnv: 'MY_KEY', dimensions: 8, vectorWeight: 1.25 })
    expect(() => resolveEmbeddingConfig({ baseURL: 'http://x', model: 'm', maxJobsPerDrain: 0 }))
      .toThrow('embedding maxJobsPerDrain')
    expect(() => resolveEmbeddingConfig({ baseURL: 'http://x', model: 'm', dimensions: 0 }))
      .toThrow('embedding dimensions')
    expect(() => resolveEmbeddingConfig({ baseURL: 'http://x', model: 'm', vectorWeight: -1 }))
      .toThrow('embedding vectorWeight')
    expect(() => resolveEmbeddingConfig({ baseURL: 'http://x', model: 'm', apiKeyEnv: '  ' }))
      .toThrow('embedding.apiKeyEnv')
  })
})

describe('isLaneFailureReadError', () => {
  it('matches only whole-lane abort messages', () => {
    expect(isLaneFailureReadError('vector lane failed (Error: x); contributed nothing')).toBe(true)
    expect(isLaneFailureReadError('lexical lane failed (boom); contributed nothing')).toBe(true)
    expect(isLaneFailureReadError('query embedding failed (the endpoint answered HTTP 500)')).toBe(false)
    expect(isLaneFailureReadError('chunk detail fetch failed (boom)')).toBe(false)
    expect(isLaneFailureReadError('')).toBe(false)
  })
})
