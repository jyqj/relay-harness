import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  enqueueEmbedJobs,
  openCodeIndexDatabase,
  pendingEmbedCount,
  readEpochs,
} from '@relay-harness/rlh-code-index-sqlite'
import { cosineQuantized, dequantizeInt8, quantizeInt8 } from '@relay-harness/rlh-code-index-search'
import { contentHash } from '../../src/hash.ts'
import { EmbeddingClient } from '../../src/embed/client.ts'
import { EmbedError, EMBED_DIMENSION_MISMATCH, EMBED_TIMEOUT } from '../../src/embed/errors.ts'
import { DEFAULT_EMBED_DRAIN_RETRY_MS, drainEmbedJobs, type EmbedderLike } from '../../src/embed/worker.ts'
import { startFakeEmbedServer, type FakeEmbedServer } from './fake-server.ts'

const servers: FakeEmbedServer[] = []
const databases: DatabaseSync[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
  while (databases.length > 0) databases.pop()?.close()
})

/** Shape one in-memory store with one file and the given chunk texts. */
async function storeWithChunks(texts: readonly string[]): Promise<{ db: DatabaseSync; chunkIds: string[] }> {
  const db = await openCodeIndexDatabase(':memory:')
  databases.push(db)
  db.prepare(`
    INSERT INTO files (
      file_path, language, content_hash, mtime, size, is_test_file, indexed_at
    ) VALUES ('src/a.ts', 'typescript', 'hash', 1.5, 10, 0, '2026-08-28T00:00:00Z')
  `).run()
  const chunkIds = texts.map((_, index) => `chunk:src/a.ts:${index}`)
  const insert = db.prepare(`
    INSERT INTO chunks (
      chunk_id, file_path, chunk_index, start_line, end_line, text, token_estimate
    ) VALUES (?, 'src/a.ts', ?, ?, ?, ?, ?)
  `)
  for (const [index, text] of texts.entries()) {
    insert.run(chunkIds[index]!, index, index * 10 + 1, index * 10 + 10, text, Math.ceil(text.length / 4))
  }
  return { db, chunkIds }
}

/** Enqueue every chunk at its content hash with the given clock. */
function enqueueAll(db: DatabaseSync, chunkIds: readonly string[], texts: readonly string[], now = 1_000): void {
  const result = enqueueEmbedJobs(
    db,
    chunkIds.map((chunkId, index) => ({
      chunkId,
      model: 'fake-embed',
      contentHash: contentHash(texts[index]!),
    })),
    { now, maxAttempts: 2 },
  )
  expect(result.enqueued).toBe(chunkIds.length)
}

/** Compose a client for the server with drain-sized defaults. */
function clientFor(server: FakeEmbedServer, dim = 16): EmbeddingClient {
  return new EmbeddingClient({
    baseURL: server.url,
    apiKey: 'test-key',
    model: 'fake-embed',
    dimensions: dim,
    batchSize: 4,
    timeoutMs: 2_000,
    maxInputsPerRequest: 4,
  })
}

describe('drainEmbedJobs end to end', () => {
  it('embeds every queued chunk into chunks_vec and advances the evidence epoch exactly once per job', async () => {
    const texts = ['export function alpha() {}', 'const beta = 1;', 'class Gamma {}']
    const { db, chunkIds } = await storeWithChunks(texts)
    enqueueAll(db, chunkIds, texts)
    const server = await startFakeEmbedServer({ dim: 16 })
    servers.push(server)

    const before = readEpochs(db)
    const result = await drainEmbedJobs({
      db,
      client: clientFor(server),
      owner: 'drain-1',
      maxJobs: 10,
      maxPromptTokens: 100_000,
    })
    const after = readEpochs(db)

    expect(result).toEqual({
      jobsClaimed: 3,
      jobsCompleted: 3,
      jobsFailed: 0,
      vectorsWritten: 3,
      promptTokens: texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0),
      leaseSettlementsRefused: 0,
      stoppedBecause: 'queue-empty',
    })
    // Three jobs, three evidence transactions, index channel frozen.
    expect(after.evidenceEpoch).toBe(before.evidenceEpoch + 3)
    expect(after.indexEpoch).toBe(before.indexEpoch)

    // The stored rows round-trip byte-exactly against a fresh embedding of
    // the same text — the deterministic endpoint makes them identical vectors.
    const probe = new EmbeddingClient({
      baseURL: server.url,
      apiKey: 'test-key',
      model: 'fake-embed',
      batchSize: 1,
      timeoutMs: 1_000,
      maxInputsPerRequest: 1,
    })
    for (const [index, chunkId] of chunkIds.entries()) {
      const row = db.prepare('SELECT q, scale, norm, dim, model, format FROM chunks_vec WHERE chunk_id = ?')
        .get(chunkId) as { q: Uint8Array; scale: number; norm: number; dim: number; model: string; format: string }
      expect(row.model).toBe('fake-embed')
      expect(row.format).toBe('int8')
      expect(row.dim).toBe(16)
      expect(row.q).toBeInstanceOf(Uint8Array)
      const reference = quantizeInt8((await probe.embed([texts[index]!])).vectors[0]!)
      expect(row.scale).toBe(reference.scale)
      expect(row.norm).toBeCloseTo(reference.norm, 9)
      expect([...Int8Array.from(row.q)]).toEqual([...reference.q])
      const decoded = dequantizeInt8(row.q, row.scale)
      expect(decoded.length).toBe(16)
    }
    // Queue drained: no pending work remains.
    expect(pendingEmbedCount(db, 'fake-embed')).toBe(0)
  })

  it('ranks a stored vector coherently: the chunk text outscores unrelated text', async () => {
    const own = 'function computeInvoiceTotals(invoice) { return invoice.items.reduce((a, i) => a + i.price, 0) }'
    const { db } = await storeWithChunks([own])
    enqueueAll(db, ['chunk:src/a.ts:0'], [own])
    const server = await startFakeEmbedServer({ dim: 32 })
    servers.push(server)
    const probe = new EmbeddingClient({
      baseURL: server.url, apiKey: 'test-key', model: 'fake-embed',
      batchSize: 1, timeoutMs: 1_000, maxInputsPerRequest: 1,
    })
    await drainEmbedJobs({ db, client: clientFor(server, 32), owner: 'd', maxJobs: 5, maxPromptTokens: 10_000 })
    const row = db.prepare('SELECT q, scale, norm FROM chunks_vec').get() as { q: Uint8Array; scale: number; norm: number }
    const querySelf = (await probe.embed([own])).vectors[0]!
    const queryOther = (await probe.embed(['completely different prose about gardens'])).vectors[0]!

    const selfScore = cosineQuantized(querySelf, row.q, row.scale, row.norm)
    const otherScore = cosineQuantized(queryOther, row.q, row.scale, row.norm)
    expect(selfScore).toBeGreaterThan(0.99)
    expect(selfScore).toBeGreaterThan(otherScore)
  })

  it('is idempotent: re-enqueueing adds nothing and a second drain is a no-op', async () => {
    const texts = ['export const one = 1']
    const { db, chunkIds } = await storeWithChunks(texts)
    enqueueAll(db, chunkIds, texts)
    const server = await startFakeEmbedServer({ dim: 16 })
    servers.push(server)
    await drainEmbedJobs({ db, client: clientFor(server), owner: 'd1', maxJobs: 5, maxPromptTokens: 10_000 })
    const epochAfterFirst = readEpochs(db).evidenceEpoch

    // The completed job still holds its identity: the re-enqueue is ignored.
    const repeat = enqueueEmbedJobs(
      db,
      chunkIds.map((chunkId, index) => ({ chunkId, model: 'fake-embed', contentHash: contentHash(texts[index]!) })),
      { now: 2_000 },
    )
    expect(repeat).toEqual({ enqueued: 0, duplicates: 1 })
    const second = await drainEmbedJobs({ db, client: clientFor(server), owner: 'd2', maxJobs: 5, maxPromptTokens: 10_000 })
    expect(second.jobsClaimed).toBe(0)
    expect(second.stoppedBecause).toBe('queue-empty')
    expect(readEpochs(db).evidenceEpoch).toBe(epochAfterFirst)
    expect((db.prepare('SELECT COUNT(*) AS n FROM code_embed_jobs').get() as { n: number }).n).toBe(1)
  })

  it('stops at the job budget with stoppedBecause job-budget', async () => {
    const texts = ['a', 'b', 'c']
    const { db, chunkIds } = await storeWithChunks(texts)
    enqueueAll(db, chunkIds, texts)
    const server = await startFakeEmbedServer({ dim: 16 })
    servers.push(server)
    const result = await drainEmbedJobs({ db, client: clientFor(server), owner: 'd', maxJobs: 2, maxPromptTokens: 10_000 })
    expect(result.jobsClaimed).toBe(2)
    expect(result.stoppedBecause).toBe('job-budget')
    expect(pendingEmbedCount(db, 'fake-embed')).toBe(1)
  })

  it('stops before the token budget is exceeded and records per-job usage', async () => {
    const texts = ['one two three four five', 'six seven eight']
    const { db, chunkIds } = await storeWithChunks(texts)
    enqueueAll(db, chunkIds, texts)
    const server = await startFakeEmbedServer({ dim: 16 })
    servers.push(server)
    const result = await drainEmbedJobs({ db, client: clientFor(server), owner: 'd', maxJobs: 10, maxPromptTokens: 2 })
    // The first job costs ceil(24/4) = 6 tokens: the pre-claim check (spent
    // 0 < 2) admits it, then the cap blocks the second job.
    expect(result.promptTokens).toBe(6)
    expect(result.jobsCompleted).toBe(1)
    expect(result.stoppedBecause).toBe('token-budget')
    const usage = db.prepare("SELECT usage_json FROM code_embed_jobs WHERE status = 'completed'").get() as { usage_json: string }
    expect(JSON.parse(usage.usage_json)).toEqual({ promptTokens: 6 })
  })

  it('fails a job on provider errors, retries it after the delay, and completes on recovery', async () => {
    const texts = ['recovering chunk']
    const { db } = await storeWithChunks(texts)
    enqueueAll(db, ['chunk:src/a.ts:0'], texts)
    const server = await startFakeEmbedServer({ dim: 16, behaviors: ['http-error', 'ok'] })
    servers.push(server)

    const first = await drainEmbedJobs({
      db, client: clientFor(server), owner: 'd1', maxJobs: 5, maxPromptTokens: 10_000,
      now: () => 5_000,
    })
    expect(first.jobsFailed).toBe(1)
    expect(first.jobsCompleted).toBe(0)
    expect(readEpochs(db).evidenceEpoch).toBe(0)

    // Before retryAt nothing is claimable; after it the retry succeeds.
    const attemptAt = 5_000 + DEFAULT_EMBED_DRAIN_RETRY_MS
    const second = await drainEmbedJobs({
      db, client: clientFor(server), owner: 'd2', maxJobs: 5, maxPromptTokens: 10_000,
      now: () => attemptAt,
    })
    expect(second.jobsCompleted).toBe(1)
    expect(second.vectorsWritten).toBe(1)
    expect(readEpochs(db).evidenceEpoch).toBe(1)
    const row = db.prepare('SELECT attempts, status, last_error FROM code_embed_jobs').get() as {
      attempts: number
      status: string
      last_error: string
    }
    expect(row.attempts).toBe(2)
    expect(row.status).toBe('completed')
    expect(row.last_error).toBeNull()
  })

  it('settles a deadline overrun as a failed job and continues with the next job instead of stopping', async () => {
    const texts = ['slow chunk', 'fast chunk']
    const { db, chunkIds } = await storeWithChunks(texts)
    enqueueAll(db, chunkIds, texts)
    // The scripted endpoint stalls the first request past the client deadline
    // and answers the second normally.
    const server = await startFakeEmbedServer({ dim: 16, behaviors: ['slow', 'ok'] })
    servers.push(server)

    const result = await drainEmbedJobs({
      db,
      client: new EmbeddingClient({
        baseURL: server.url,
        apiKey: 'test-key',
        model: 'fake-embed',
        dimensions: 16,
        batchSize: 4,
        timeoutMs: 50,
        maxInputsPerRequest: 4,
      }),
      owner: 'd',
      maxJobs: 10,
      maxPromptTokens: 10_000,
      now: () => 5_000,
    })
    // The timed-out job settled through the attempt budget (retry scheduled
    // past the drain's clock) and the drain moved on to complete the next one.
    expect(result.jobsClaimed).toBe(2)
    expect(result.jobsFailed).toBe(1)
    expect(result.jobsCompleted).toBe(1)
    expect(result.stoppedBecause).toBe('queue-empty')
    const timedOut = db.prepare(
      'SELECT status, attempts, last_error, usage_json FROM code_embed_jobs WHERE chunk_id = ?',
    ).get(chunkIds[0]!) as { status: string; attempts: number; last_error: string; usage_json: string | null }
    expect(timedOut.status).toBe('pending')
    expect(timedOut.attempts).toBe(1)
    expect(timedOut.last_error).toContain('timed out after 50ms')
    expect(timedOut.usage_json).toBeNull()
    const completed = db.prepare('SELECT status FROM code_embed_jobs WHERE chunk_id = ?').get(chunkIds[1]!) as { status: string }
    expect(completed.status).toBe('completed')
    expect(readEpochs(db).evidenceEpoch).toBe(1)
  })

  it('records a timeout failure\'s partial prompt-token spend onto usage_json', async () => {
    const texts = ['partially billed chunk']
    const { db } = await storeWithChunks(texts)
    enqueueAll(db, ['chunk:src/a.ts:0'], texts)
    const partialClient: EmbedderLike = {
      model: 'fake-embed',
      embed: async () => {
        const error = new EmbedError('the embedding request timed out after 50ms', EMBED_TIMEOUT)
        error.promptTokensUsed = 5
        throw error
      },
    }
    const result = await drainEmbedJobs({
      db, client: partialClient, owner: 'd', maxJobs: 5, maxPromptTokens: 10_000, now: () => 5_000,
    })
    expect(result.jobsFailed).toBe(1)
    const row = db.prepare('SELECT last_error, usage_json FROM code_embed_jobs').get() as { last_error: string; usage_json: string }
    expect(row.last_error).toContain('timed out')
    expect(JSON.parse(row.usage_json)).toEqual({ promptTokens: 5 })
  })

  it('exhausts the attempt budget to a terminal failure with the last error recorded', async () => {
    const texts = ['doomed chunk']
    const { db } = await storeWithChunks(texts)
    enqueueAll(db, ['chunk:src/a.ts:0'], texts)
    const server = await startFakeEmbedServer({ dim: 16, behaviors: ['http-error-plain'] })
    servers.push(server)

    for (const [index, owner] of ['d1', 'd2'].entries()) {
      const result = await drainEmbedJobs({
        db, client: clientFor(server), owner, maxJobs: 5, maxPromptTokens: 10_000,
        now: () => 5_000 + index * 10_000,
      })
      expect(result.jobsFailed).toBe(1)
    }
    // Both attempts consumed: a third drain finds nothing claimable.
    const third = await drainEmbedJobs({
      db, client: clientFor(server), owner: 'd3', maxJobs: 5, maxPromptTokens: 10_000,
      now: () => 30_000,
    })
    expect(third.jobsClaimed).toBe(0)
    const row = db.prepare('SELECT status, last_error FROM code_embed_jobs').get() as { status: string; last_error: string }
    expect(row.status).toBe('failed')
    expect(row.last_error).toContain('HTTP 500')
    expect(readEpochs(db).evidenceEpoch).toBe(0)
  })

  it('stops on the caller signal without settling the in-flight job', async () => {
    const texts = ['aborted chunk']
    const { db } = await storeWithChunks(texts)
    enqueueAll(db, ['chunk:src/a.ts:0'], texts)
    const server = await startFakeEmbedServer({ dim: 16, behaviors: ['slow'] })
    servers.push(server)
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort(new Error('drain stopped'))
    }, 50)

    const result = await drainEmbedJobs({
      db, client: clientFor(server), owner: 'd1', maxJobs: 5, maxPromptTokens: 10_000,
      signal: controller.signal,
    })
    expect(result.stoppedBecause).toBe('signal')
    expect(result.jobsCompleted).toBe(0)
    // The claim burned one attempt; the job stays leased until expiry.
    const row = db.prepare('SELECT status, attempts, lease_owner FROM code_embed_jobs').get() as {
      status: string
      attempts: number
      lease_owner: string | null
    }
    expect(row.status).toBe('running')
    expect(row.attempts).toBe(1)
    expect(row.lease_owner).toBe('d1')
  })

  it('fails a job whose chunk row vanished and keeps draining', async () => {
    const texts = ['present chunk']
    const { db } = await storeWithChunks(texts)
    enqueueAll(db, ['chunk:src/a.ts:0'], texts)
    // An orphan queue row whose chunk is gone (only reachable through a
    // hand-repaired store, since the FK cascade purges jobs with their
    // chunks): simulate it with enforcement off for the raw insert.
    db.exec('PRAGMA foreign_keys = OFF')
    db.exec(`INSERT INTO code_embed_jobs (
        id, dedupe_key, chunk_id, model, content_hash, payload_json,
        status, max_attempts, available_at, created_at, updated_at
      ) VALUES (
        'code-embed-orphan', 'orphan', 'chunk:src/gone.ts:0', 'fake-embed', 'h', '{}',
        'pending', 2, 1, 1, 1
      )`)
    db.exec('PRAGMA foreign_keys = ON')
    const server = await startFakeEmbedServer({ dim: 16 })
    servers.push(server)

    const result = await drainEmbedJobs({ db, client: clientFor(server), owner: 'd', maxJobs: 10, maxPromptTokens: 10_000 })
    expect(result.jobsFailed).toBe(1)
    expect(result.jobsCompleted).toBe(1)
    expect(result.stoppedBecause).toBe('queue-empty')
    const orphan = db.prepare('SELECT status, last_error FROM code_embed_jobs WHERE id = ?').get('code-embed-orphan') as {
      status: string
      last_error: string
    }
    expect(orphan.last_error).toBe('the chunk row disappeared before embedding')
  })

  it('rethrows a deterministic DIMENSION_MISMATCH after settling the job', async () => {
    const texts = ['dimensionally confused']
    const { db } = await storeWithChunks(texts)
    enqueueAll(db, ['chunk:src/a.ts:0'], texts)
    const server = await startFakeEmbedServer({ dim: 16, behaviors: ['wrong-dim'] })
    servers.push(server)
    const error = await drainEmbedJobs({
      db, client: clientFor(server), owner: 'd', maxJobs: 5, maxPromptTokens: 10_000,
    }).then(
      () => {
        throw new Error('expected the drain to throw')
      },
      (caught: unknown) => caught,
    ) as EmbedError
    expect(error.code).toBe(EMBED_DIMENSION_MISMATCH)
    // The job was settled (attempt burned) before the rethrow, so a config
    // fix can retry it without the budget having been burned queue-wide.
    const row = db.prepare('SELECT attempts, status FROM code_embed_jobs').get() as { attempts: number; status: string }
    expect(row.attempts).toBe(1)
    expect(row.status).toBe('pending')
  })

  it('respects an injected quantizer and stores its exact bytes', async () => {
    const texts = ['pinned bytes']
    const { db, chunkIds } = await storeWithChunks(texts)
    enqueueAll(db, chunkIds, texts)
    const server = await startFakeEmbedServer({ dim: 16 })
    servers.push(server)
    await drainEmbedJobs({
      db,
      client: clientFor(server),
      quantize: vector => ({ q: Int8Array.from({ length: vector.length }, () => 7), scale: 0.125, norm: 4 }),
      owner: 'd',
      maxJobs: 5,
      maxPromptTokens: 10_000,
    })
    const row = db.prepare('SELECT q, scale, norm, dim FROM chunks_vec WHERE chunk_id = ?').get(chunkIds[0]!) as {
      q: Uint8Array
      scale: number
      norm: number
      dim: number
    }
    expect([...Int8Array.from(row.q)]).toEqual(new Array<number>(16).fill(7))
    expect(row.scale).toBe(0.125)
    expect(row.norm).toBe(4)
    expect(row.dim).toBe(16)
  })

  it('reports signal as the stop reason when the signal fired before the first claim', async () => {
    const { db } = await storeWithChunks(['never claimed'])
    enqueueAll(db, ['chunk:src/a.ts:0'], ['never claimed'])
    const server = await startFakeEmbedServer({ dim: 16 })
    servers.push(server)
    const controller = new AbortController()
    controller.abort()
    const result = await drainEmbedJobs({
      db, client: clientFor(server), owner: 'd', maxJobs: 5, maxPromptTokens: 10_000,
      signal: controller.signal,
    })
    expect(result.jobsClaimed).toBe(0)
    expect(result.stoppedBecause).toBe('signal')
  })

  it('counts a completion settlement refused after the lease expired mid-job', async () => {
    const texts = ['slow beyond the lease']
    const { db } = await storeWithChunks(texts)
    enqueueAll(db, ['chunk:src/a.ts:0'], texts)
    const server = await startFakeEmbedServer({ dim: 16 })
    servers.push(server)
    // The fake embed outlasts the drain's 10ms lease, so the completion guard
    // refuses and the drain counts the refusal instead of failing the job.
    const slowClient: EmbedderLike = {
      model: 'fake-embed',
      embed: async () => {
        await new Promise(resolve => setTimeout(resolve, 60))
        const vector = Float32Array.from({ length: 16 }, (_, index) => (index % 2 === 0 ? 0.5 : -0.5))
        return { vectors: [vector], promptTokens: 4 }
      },
    }
    const result = await drainEmbedJobs({
      db, client: slowClient, owner: 'd', maxJobs: 5, maxPromptTokens: 10_000, leaseMs: 10,
    })
    // Each 60ms embed outlives the 10ms lease: two claim/embed cycles both
    // refuse settlement, then the burned attempts terminalize the job.
    expect(result.leaseSettlementsRefused).toBe(2)
    expect(result.jobsCompleted).toBe(0)
    expect((db.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get() as { n: number }).n).toBeGreaterThan(0)
    expect((db.prepare('SELECT status FROM code_embed_jobs').get() as { status: string }).status).toBe('failed')
  })

  it('fails a job whose client breached the one-vector-per-input contract', async () => {
    const texts = ['contract breach']
    const { db } = await storeWithChunks(texts)
    enqueueAll(db, ['chunk:src/a.ts:0'], texts)
    const server = await startFakeEmbedServer({ dim: 16 })
    servers.push(server)
    const emptyClient: EmbedderLike = {
      model: 'fake-embed',
      embed: async () => ({ vectors: [], promptTokens: 0 }),
    }
    const result = await drainEmbedJobs({
      db, client: emptyClient, owner: 'd', maxJobs: 5, maxPromptTokens: 10_000,
    })
    expect(result.jobsFailed).toBe(1)
    const row = db.prepare('SELECT last_error FROM code_embed_jobs').get() as { last_error: string }
    expect(row.last_error).toBe('the embedding endpoint returned no vector for the job input')
  })

  it('counts a failure settlement refused after the lease expired and renders non-Error throws', async () => {
    const texts = ['slow failure beyond the lease']
    const { db } = await storeWithChunks(texts)
    enqueueAll(db, ['chunk:src/a.ts:0'], texts)
    const server = await startFakeEmbedServer({ dim: 16 })
    servers.push(server)
    const failingClient: EmbedderLike = {
      model: 'fake-embed',
      embed: async () => {
        await new Promise(resolve => setTimeout(resolve, 60))
        // A non-Error rejection exercises the String(error) rendering.
        throw 'plain string failure'
      },
    }
    const result = await drainEmbedJobs({
      db, client: failingClient, owner: 'd', maxJobs: 5, maxPromptTokens: 10_000, leaseMs: 10,
    })
    // Both failure settlements hit the expired-lease guard; the reclaim cycle
    // then burns the attempts to terminal failure. Nothing was ever settled
    // by this worker.
    expect(result.leaseSettlementsRefused).toBe(2)
    expect(result.jobsFailed).toBe(0)
    expect((db.prepare('SELECT status FROM code_embed_jobs').get() as { status: string }).status).toBe('failed')
  })
})
