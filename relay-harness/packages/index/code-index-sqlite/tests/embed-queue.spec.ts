import { describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import {
  DEFAULT_EMBED_JOB_MAX_ATTEMPTS,
  claimEmbedJobs,
  chunkRevisionsForFiles,
  completeEmbedJob,
  embedChunkInputs,
  enqueueEmbedJobs,
  failEmbedJob,
  pendingEmbedCount,
  resetFailedEmbedJobsForGeneration,
} from '../src/embed-queue.ts'
import { decodeChunkText } from '../src/codec.ts'
import { openCodeIndexDatabase } from '../src/open.ts'

/** Insert one indexed file (idempotent) plus one chunk row, bypassing the writer. */
function insertChunk(db: DatabaseSync, filePath: string, chunkId: string, text = 'export {}'): void {
  db.prepare(`
    INSERT OR IGNORE INTO files (
      file_path, language, content_hash, mtime, size, is_test_file, indexed_at
    ) VALUES (?, 'typescript', 'hash', 1.5, 10, 0, '2026-08-28T00:00:00Z')
  `).run(filePath)
  db.prepare(`
    INSERT INTO chunks (
      chunk_id, file_path, chunk_index, start_line, end_line, text, token_estimate
    ) VALUES (?, ?, 0, 1, 2, ?, 2)
  `).run(chunkId, filePath, text)
}

/** Enqueue one job for a chunk the fixture created. */
function enqueue(db: DatabaseSync, chunkId: string, model = 'embed-test', contentHash = 'hash-0'): void {
  const result = enqueueEmbedJobs(
    db,
    [{ chunkId, model, contentHash }],
    { now: 1_000, maxAttempts: 2 },
  )
  expect(result.enqueued).toBe(1)
}

describe('enqueueEmbedJobs', () => {
  it('is idempotent per (chunk_id, model, content_hash) and counts duplicates', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    enqueue(db, 'chunk:src/a.ts:0')

    const repeat = enqueueEmbedJobs(db, [{ chunkId: 'chunk:src/a.ts:0', model: 'embed-test', contentHash: 'hash-0' }], { now: 2_000 })
    expect(repeat).toEqual({ enqueued: 0, duplicates: 1 })
    // A content revision is a distinct job; so is another model.
    const revision = enqueueEmbedJobs(db, [
      { chunkId: 'chunk:src/a.ts:0', model: 'embed-test', contentHash: 'hash-1' },
      { chunkId: 'chunk:src/a.ts:0', model: 'embed-other', contentHash: 'hash-0' },
    ], { now: 2_000 })
    expect(revision.enqueued).toBe(2)
    expect(pendingEmbedCount(db, 'embed-test')).toBe(2)
    db.close()
  })

  it('fails loud through the foreign key when the chunk does not exist', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    expect(() => enqueueEmbedJobs(db, [{ chunkId: 'chunk:none:0', model: 'm', contentHash: 'h' }]))
      .toThrow(/FOREIGN KEY/)
    db.close()
  })

  it('rejects a non-positive attempt budget', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    expect(() => enqueueEmbedJobs(db, [], { maxAttempts: 0 })).toThrow(/maxAttempts/)
    db.close()
  })
})

describe('claimEmbedJobs', () => {
  it('claims disjoint sets across owners and burns one attempt per claim', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    for (const [index, chunkId] of ['chunk:src/a.ts:0', 'chunk:src/a.ts:1', 'chunk:src/a.ts:2'].entries()) {
      insertChunk(db, 'src/a.ts', chunkId)
      enqueueEmbedJobs(db, [{ chunkId, model: 'embed-test', contentHash: `hash-${index}` }], { now: 1_000 + index })
    }

    const w1 = claimEmbedJobs(db, { owner: 'w1', leaseMs: 60_000, limit: 2, now: 5_000 })
    const w2 = claimEmbedJobs(db, { owner: 'w2', leaseMs: 60_000, limit: 2, now: 5_001 })
    expect(w1).toHaveLength(2)
    expect(w2).toHaveLength(1)
    const ids = new Set([...w1, ...w2].map(job => job.id))
    expect(ids.size).toBe(3)
    expect(w1[0]!.attempts).toBe(1)
    expect(w2[0]!.attempts).toBe(1)

    // Everything is leased: a third owner gets nothing.
    expect(claimEmbedJobs(db, { owner: 'w3', leaseMs: 60_000, now: 5_002 })).toEqual([])
    db.close()
  })

  it('reclaims an expired lease and terminalizes an expired final attempt', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    enqueue(db, 'chunk:src/a.ts:0') // maxAttempts = 2

    // First claim burns attempt 1, then the worker dies without settlement.
    const [first] = claimEmbedJobs(db, { owner: 'w1', leaseMs: 100, now: 5_000 })
    expect(first!.attempts).toBe(1)
    expect(claimEmbedJobs(db, { owner: 'w2', leaseMs: 100, now: 5_050 })).toEqual([])

    // Attempt 2 (the last) is claimed after expiry and abandoned again.
    const [second] = claimEmbedJobs(db, { owner: 'w2', leaseMs: 100, now: 5_200 })
    expect(second!.id).toBe(first!.id)
    expect(second!.attempts).toBe(2)

    // Now the expired lease is a FINAL attempt: the next claim settles it
    // failed instead of re-claiming.
    expect(claimEmbedJobs(db, { owner: 'w3', leaseMs: 100, now: 5_400 })).toEqual([])
    const row = db.prepare('SELECT status, last_error, lease_owner FROM code_embed_jobs').get() as {
      status: string
      last_error: string
      lease_owner: string | null
    }
    expect(row.status).toBe('failed')
    expect(row.last_error).toBe('embed worker lease expired after final attempt')
    expect(row.lease_owner).toBeNull()
    db.close()
  })

  it('honors the model filter and validates its inputs', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    enqueueEmbedJobs(db, [
      { chunkId: 'chunk:src/a.ts:0', model: 'embed-a', contentHash: 'h0' },
      { chunkId: 'chunk:src/a.ts:0', model: 'embed-b', contentHash: 'h0' },
    ], { now: 1_000 })
    expect(claimEmbedJobs(db, { owner: 'w1', leaseMs: 1_000, model: 'embed-b', now: 2_000 })).toHaveLength(1)
    expect(claimEmbedJobs(db, { owner: 'w1', leaseMs: 1_000, model: 'embed-a', now: 2_000 })).toHaveLength(1)

    expect(() => claimEmbedJobs(db, { owner: '', leaseMs: 1_000 })).toThrow(/owner/)
    expect(() => claimEmbedJobs(db, { owner: 'w', leaseMs: 0 })).toThrow(/leaseMs/)
    expect(() => claimEmbedJobs(db, { owner: 'w', leaseMs: 1_000, limit: 0 })).toThrow(/limit/)
    expect(() => claimEmbedJobs(db, { owner: 'w', leaseMs: 1_000, now: -1 })).toThrow(/now/)
    db.close()
  })

  it('defaults the claim clock to wall-clock now and rolls back on a statement failure', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    // Wall-clock now >= available_at (enqueued at the same wall clock), so the
    // default-clock claim path claims the job.
    enqueueEmbedJobs(db, [
      { chunkId: 'chunk:src/a.ts:0', model: 'embed-a', contentHash: 'h0' },
      { chunkId: 'chunk:src/a.ts:0', model: 'embed-b', contentHash: 'h0' },
    ])
    const [first, second] = claimEmbedJobs(db, { owner: 'wall-clock', leaseMs: 60_000, limit: 2 })
    expect([first, second]).toHaveLength(2)

    // The default settlement clock pairs with the default claim clock: the
    // wall-clock leases are still live, so both settlements run without an
    // explicit now.
    completeEmbedJob(db, { id: first!.id, owner: 'wall-clock', usage: { promptTokens: 3 } })
    failEmbedJob(db, {
      id: second!.id,
      owner: 'wall-clock',
      error: 'transient',
      retryAt: 1,
    })

    // A statement failure inside the claim transaction rolls the unit back
    // instead of leaving a half-settled state.
    db.exec('DROP TABLE code_embed_jobs')
    expect(() => claimEmbedJobs(db, { owner: 'w', leaseMs: 1_000 })).toThrow()
    db.close()
  })
})

describe('completeEmbedJob / failEmbedJob', () => {
  it('completes under the owning unexpired lease and records usage', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    enqueue(db, 'chunk:src/a.ts:0')
    const [job] = claimEmbedJobs(db, { owner: 'w1', leaseMs: 1_000, now: 5_000 })

    const settled = completeEmbedJob(db, { id: job!.id, owner: 'w1', usage: { promptTokens: 12 }, now: 5_500 })
    expect(settled.leaseUntil).toBe(-1)
    const row = db.prepare('SELECT status, usage_json, lease_owner FROM code_embed_jobs').get() as {
      status: string
      usage_json: string
      lease_owner: string | null
    }
    expect(row.status).toBe('completed')
    expect(JSON.parse(row.usage_json)).toEqual({ promptTokens: 12 })
    expect(row.lease_owner).toBeNull()
    db.close()
  })

  it('refuses completion by a foreign owner, an expired lease, or a stale status', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    enqueue(db, 'chunk:src/a.ts:0')
    const [job] = claimEmbedJobs(db, { owner: 'w1', leaseMs: 1_000, now: 5_000 })

    expect(() => completeEmbedJob(db, { id: job!.id, owner: 'w2', usage: { promptTokens: 1 }, now: 5_100 }))
      .toThrow(/not leased by w2/)
    expect(() => completeEmbedJob(db, { id: job!.id, owner: 'w1', usage: { promptTokens: 1 }, now: 7_000 }))
      .toThrow(/not leased by w1/)

    // Re-claimed by w2 after expiry, completed, then a second completion refuses.
    const [again] = claimEmbedJobs(db, { owner: 'w2', leaseMs: 1_000, now: 7_100 })
    expect(again).toBeDefined()
    completeEmbedJob(db, { id: again!.id, owner: 'w2', usage: { promptTokens: 2 }, now: 7_200 })
    expect(() => completeEmbedJob(db, { id: again!.id, owner: 'w2', usage: { promptTokens: 2 }, now: 7_300 }))
      .toThrow(/not leased by w2/)
    db.close()
  })

  it('returns a failed job to pending with attempts left, terminally failing otherwise', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    enqueue(db, 'chunk:src/a.ts:0') // maxAttempts = 2

    const [first] = claimEmbedJobs(db, { owner: 'w1', leaseMs: 1_000, now: 5_000 })
    const retried = failEmbedJob(db, { id: first!.id, owner: 'w1', error: 'provider 500', retryAt: 6_000, now: 5_100 })
    expect(retried.leaseUntil).toBe(-1)
    expect((db.prepare('SELECT status, available_at, last_error FROM code_embed_jobs').get() as {
      status: string
      available_at: number
      last_error: string
    })).toEqual({ status: 'pending', available_at: 6_000, last_error: 'provider 500' })

    // Second and final attempt: the failure settles terminal.
    const [second] = claimEmbedJobs(db, { owner: 'w2', leaseMs: 1_000, now: 6_000 })
    failEmbedJob(db, { id: second!.id, owner: 'w2', error: 'provider 500 again', retryAt: 9_000, now: 6_100 })
    expect((db.prepare('SELECT status FROM code_embed_jobs').get() as { status: string }).status).toBe('failed')
    expect(claimEmbedJobs(db, { owner: 'w3', leaseMs: 1_000, now: 9_000 })).toEqual([])
    db.close()
  })

  it('resets a current-content terminal failure once and never loops indefinitely', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    enqueue(db, 'chunk:src/a.ts:0', 'embed-test', 'hash')
    for (const [index, owner] of ['w1', 'w2'].entries()) {
      const [job] = claimEmbedJobs(db, { owner, leaseMs: 1_000, now: 5_000 + index * 2_000 })
      failEmbedJob(db, { id: job!.id, owner, error: 'bad credential', retryAt: 6_000 + index * 2_000, now: 5_100 + index * 2_000 })
    }
    expect(resetFailedEmbedJobsForGeneration(db, 'legacy-model:embed-test', 10_000)).toBe(1)
    expect((db.prepare('SELECT status, attempts, reconcile_resets FROM code_embed_jobs').get() as {
      status: string
      attempts: number
      reconcile_resets: number
    })).toEqual({ status: 'pending', attempts: 0, reconcile_resets: 1 })

    for (const [index, owner] of ['w3', 'w4'].entries()) {
      const [job] = claimEmbedJobs(db, { owner, leaseMs: 1_000, now: 11_000 + index * 2_000 })
      failEmbedJob(db, { id: job!.id, owner, error: 'still bad', retryAt: 12_000 + index * 2_000, now: 11_100 + index * 2_000 })
    }
    expect(resetFailedEmbedJobsForGeneration(db, 'legacy-model:embed-test', 20_000)).toBe(0)
    expect((db.prepare('SELECT status FROM code_embed_jobs').get() as { status: string }).status).toBe('failed')
    db.close()
  })

  it('validates failure settlement inputs and the lease guard', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    enqueue(db, 'chunk:src/a.ts:0')
    const [job] = claimEmbedJobs(db, { owner: 'w1', leaseMs: 1_000, now: 5_000 })

    expect(() => failEmbedJob(db, { id: job!.id, owner: 'w1', error: '', retryAt: 6_000 })).toThrow(/non-empty/)
    expect(() => failEmbedJob(db, { id: job!.id, owner: 'w1', error: 'x'.repeat(2_001), retryAt: 6_000 }))
      .toThrow(/2000 Unicode code points/)
    expect(() => failEmbedJob(db, { id: job!.id, owner: 'w1', error: 'boom', retryAt: -1 })).toThrow(/retryAt/)
    expect(() => failEmbedJob(db, { id: job!.id, owner: 'w2', error: 'boom', retryAt: 6_000 })).toThrow(/not leased by w2/)
    expect(() => failEmbedJob(db, { id: 'code-embed-none', owner: 'w1', error: 'boom', retryAt: 6_000 }))
      .toThrow(/not found/)
    db.close()
  })

  it('records already-billed usage on a failure settlement and leaves usage untouched without it', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    enqueue(db, 'chunk:src/a.ts:0') // maxAttempts = 2
    const usageOf = (): unknown => {
      const raw = (db.prepare('SELECT usage_json FROM code_embed_jobs').get() as { usage_json: string | null }).usage_json
      return raw === null ? null : JSON.parse(raw)
    }

    const [first] = claimEmbedJobs(db, { owner: 'w1', leaseMs: 1_000, now: 5_000 })
    failEmbedJob(db, { id: first!.id, owner: 'w1', error: 'timeout after earlier batches', retryAt: 6_000, now: 5_100, usage: { promptTokens: 7 } })
    expect(usageOf()).toEqual({ promptTokens: 7 })

    // A settlement without usage must not erase the recorded spend.
    const [second] = claimEmbedJobs(db, { owner: 'w2', leaseMs: 1_000, now: 6_000 })
    failEmbedJob(db, { id: second!.id, owner: 'w2', error: 'timeout again', retryAt: 9_000, now: 6_100 })
    expect(usageOf()).toEqual({ promptTokens: 7 })
    db.close()
  })

  it('keeps two owners from interleaving one job: an expired lease re-claimed elsewhere refuses both settlements', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    enqueue(db, 'chunk:src/a.ts:0')

    // Worker A claims; its lease lapses while it still works the job.
    const [forA] = claimEmbedJobs(db, { owner: 'worker-a', leaseMs: 1_000, now: 5_000 })
    // Worker B re-claims the expired lease and now owns the row.
    const [forB] = claimEmbedJobs(db, { owner: 'worker-b', leaseMs: 1_000, now: 6_500 })
    expect(forB!.id).toBe(forA!.id)

    // A's late settlement attempts are refused in both directions; B's succeed.
    expect(() => completeEmbedJob(db, { id: forA!.id, owner: 'worker-a', usage: { promptTokens: 1 }, now: 6_600 }))
      .toThrow(/not leased by worker-a/)
    expect(() => failEmbedJob(db, { id: forA!.id, owner: 'worker-a', error: 'late failure', retryAt: 7_600, now: 6_600 }))
      .toThrow(/not leased by worker-a/)
    failEmbedJob(db, { id: forB!.id, owner: 'worker-b', error: 'provider 500', retryAt: 7_500, now: 6_600 })
    // B's claim burned the final attempt, so its settlement lands terminal.
    const row = db.prepare('SELECT status, last_error, lease_owner FROM code_embed_jobs').get() as {
      status: string
      last_error: string
      lease_owner: string | null
    }
    expect(row).toEqual({ status: 'failed', last_error: 'provider 500', lease_owner: null })
    db.close()
  })
})

describe('embedChunkInputs', () => {
  it('reads decoded text plus rowid, batching large id lists', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    const ids: string[] = []
    for (let index = 0; index < 250; index += 1) {
      const chunkId = `chunk:src/f.ts:${index}`
      insertChunk(db, 'src/f.ts', chunkId, `text ${index}`)
      ids.push(chunkId)
    }
    const inputs = embedChunkInputs(db, ids)
    expect(inputs.size).toBe(250)
    expect(inputs.get('chunk:src/f.ts:0')?.text).toBe('text 0')
    expect(inputs.get('chunk:src/f.ts:249')?.chunkRowid).toBeGreaterThan(0)
    // Unknown ids are absent, never fabricated.
    expect(inputs.has('chunk:src/missing.ts:0')).toBe(false)
    db.close()
  })

  it('decodes through the chunk-text codec so an unknown encoding fails loud', () => {
    expect(() => decodeChunkText('future-codec', 'x')).toThrow(/not supported/)
  })
})

describe('DEFAULT_EMBED_JOB_MAX_ATTEMPTS', () => {
  it('gives every enqueued job the default budget when no override is passed', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    enqueueEmbedJobs(db, [{ chunkId: 'chunk:src/a.ts:0', model: 'm', contentHash: 'h' }], { now: 1_000 })
    const row = db.prepare('SELECT max_attempts FROM code_embed_jobs').get() as { max_attempts: number }
    expect(row.max_attempts).toBe(DEFAULT_EMBED_JOB_MAX_ATTEMPTS)
    db.close()
  })
})

describe('chunkRevisionsForFiles', () => {
  /** Pre-insert one file so its committed content hash (not the fixture default) is observable. */
  function insertFileWithHash(db: DatabaseSync, filePath: string, hash: string): void {
    db.prepare(`
      INSERT OR IGNORE INTO files (
        file_path, language, content_hash, mtime, size, is_test_file, indexed_at
      ) VALUES (?, 'typescript', ?, 1.5, 10, 0, '2026-08-28T00:00:00Z')
    `).run(filePath, hash)
  }

  it('joins chunk ids with their files content hashes, deduplicating and skipping chunk-less paths', async () => {
    const db = await openCodeIndexDatabase(':memory:')
    insertFileWithHash(db, 'src/a.ts', 'hash-a')
    insertFileWithHash(db, 'src/b.ts', 'hash-b')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:0')
    insertChunk(db, 'src/a.ts', 'chunk:src/a.ts:1')
    insertChunk(db, 'src/b.ts', 'chunk:src/b.ts:0')

    const rows = chunkRevisionsForFiles(db, ['src/b.ts', 'src/a.ts', 'src/missing.ts', 'src/a.ts'])
    expect(rows).toEqual([
      { chunkId: 'chunk:src/a.ts:0', contentHash: 'hash-a' },
      { chunkId: 'chunk:src/a.ts:1', contentHash: 'hash-a' },
      { chunkId: 'chunk:src/b.ts:0', contentHash: 'hash-b' },
    ])
    expect(chunkRevisionsForFiles(db, ['src/missing.ts'])).toEqual([])
    expect(chunkRevisionsForFiles(db, [])).toEqual([])
    db.close()
  })
})
