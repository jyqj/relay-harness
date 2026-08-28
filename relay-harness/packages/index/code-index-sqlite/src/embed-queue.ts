/**
 * Embedding job queue over the derived SQLite store.
 *
 * The queue decouples chunk indexing from embedding generation: the indexer
 * enqueues one job per new chunk text, and an out-of-process worker drains the
 * queue through the embedding provider at its own pace. Lease semantics
 * (single-writer claims under `BEGIN IMMEDIATE`, expiry reclaim, attempts
 * exhaustion) are ported from the memory store's extraction jobs; the queue
 * SQL lives here so the database handle never crosses the package boundary —
 * the drain worker in the local package composes these functions with its
 * embedding client, it never touches the tables itself.
 *
 * @module @relay-harness/rlh-code-index-sqlite/embed-queue
 */

import type { DatabaseSync } from 'node:sqlite'
import { decodeChunkText } from './codec.ts'

/** `IN (...)` batching cap mirroring the writer's `SQLITE_MAX_VARIABLE_NUMBER` guard. */
const SQL_IN_BATCH_SIZE = 200

/** Upper bound on stored `last_error` text, mirroring the memory store's queue. */
const MAX_LAST_ERROR_CODE_POINTS = 2_000

/** One chunk text awaiting its embedding, as the indexer submits it. */
export interface EmbedJobInput {
  /** Chunk to embed; an existing `chunks` row id (`chunk:<file>:<index>`). */
  readonly chunkId: string
  /** Embedding model identity the job targets. */
  readonly model: string
  /** Hash of the chunk text revision (`@relay-harness/rlh-code-index-local/hash`). */
  readonly contentHash: string
  /**
   * Pre-serialized JSON annotation riding with the job. The drain reads chunk
   * text from the `chunks` table itself, so nothing is required here; the
   * column exists for queue-schema parity with the reference implementation
   * and stays `'{}'` until a writer needs routing hints.
   */
  readonly payloadJson?: string
}

/** Counts reported by one committed {@link enqueueEmbedJobs} call. */
export interface EnqueueEmbedJobsResult {
  /** Rows actually inserted (first sighting of each identity). */
  readonly enqueued: number
  /** Inputs ignored because their identity was already queued. */
  readonly duplicates: number
}

/** One claimable/claimed queue row in caller-facing form. */
export interface EmbedJob {
  /** Primary key, derived from the job's identity (stable across re-enqueues). */
  readonly id: string
  /** Chunk the job embeds. */
  readonly chunkId: string
  /** Embedding model identity. */
  readonly model: string
  /** Hash of the chunk text revision the job targets. */
  readonly contentHash: string
  /** Attempts consumed so far; the claim that owns the lease is attempt `attempts`. */
  readonly attempts: number
  /** Terminal failure threshold; `attempts >= maxAttempts` refuses further claims. */
  readonly maxAttempts: number
  /** Epoch-ms instant the current lease expires; `-1` when unleased. */
  readonly leaseUntil: number
  /** Epoch-ms creation instant, ordering claims oldest-first. */
  readonly createdAt: number
}

/**
 * Enqueue embedding jobs idempotently: an input whose
 * `(chunk_id, model, content_hash)` identity (or its derived `dedupe_key`) is
 * already queued is ignored, so re-running an indexer pass adds nothing and a
 * content revision is a distinct job. Fail-closed by foreign key: an unknown
 * chunk id aborts the whole batch and nothing is inserted.
 *
 * Queue rows are workflow state, not retrieval content: this transaction does
 * not bump either epoch clock.
 * @param db - admitted handle; must not have another transaction open.
 * @param items - jobs to enqueue.
 * @param options - clock injection and the per-job attempt budget; both
 *   default here so the indexer needs no queue internals.
 * @returns inserted versus ignored counts, observable only after the COMMIT.
 * @throws Any statement failure aborts the whole batch.
 */
export function enqueueEmbedJobs(
  db: DatabaseSync,
  items: readonly EmbedJobInput[],
  options: EnqueueEmbedJobsOptions = {},
): EnqueueEmbedJobsResult {
  const now = options.now ?? Date.now()
  const maxAttempts = options.maxAttempts ?? DEFAULT_EMBED_JOB_MAX_ATTEMPTS
  assertPositiveSafeInteger('embed job maxAttempts', maxAttempts)
  db.exec('BEGIN IMMEDIATE')
  try {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO code_embed_jobs (
        id, dedupe_key, chunk_id, model, content_hash, payload_json,
        status, max_attempts, available_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `)
    let enqueued = 0
    for (const item of items) {
      // The unit separator cannot appear in a model name, chunk id, or hex
      // hash, so the joined identity is unambiguous; only equality reads it.
      const dedupeKey = [item.model, item.chunkId, item.contentHash].join('\u001f')
      const inserted = insert.run(
        `code-embed-${dedupeKey}`,
        dedupeKey,
        item.chunkId,
        item.model,
        item.contentHash,
        item.payloadJson ?? '{}',
        maxAttempts,
        now,
        now,
        now,
      ).changes
      enqueued += Number(inserted) // StatementResultingChanges.changes is number|bigint.
    }
    db.exec('COMMIT')
    return { enqueued, duplicates: items.length - enqueued }
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Clock and budget injection for {@link enqueueEmbedJobs}. */
export interface EnqueueEmbedJobsOptions {
  /** Epoch-ms enqueue instant; defaults to wall-clock now. */
  readonly now?: number
  /** Attempts a job gets before terminal failure; defaults to {@link DEFAULT_EMBED_JOB_MAX_ATTEMPTS}. */
  readonly maxAttempts?: number
}

/** Default attempt budget per embed job (one try plus two retries). */
export const DEFAULT_EMBED_JOB_MAX_ATTEMPTS = 3

/** Options for {@link claimEmbedJobs}. */
export interface ClaimEmbedJobsOptions {
  /** Worker identity stamped onto the lease; must be unique per live worker. */
  readonly owner: string
  /** Lease duration in milliseconds; the claim expires at `now + leaseMs`. */
  readonly leaseMs: number
  /** Maximum jobs to claim in this transaction; defaults to `1`. */
  readonly limit?: number
  /** Restrict claims to one model's jobs; omit to claim any model. */
  readonly model?: string
  /** Epoch-ms claim instant; defaults to wall-clock now. */
  readonly now?: number
}

/**
 * Claim due jobs for one worker, atomically.
 *
 * Inside one `BEGIN IMMEDIATE` transaction the claim (1) settles jobs whose
 * lease expired on their FINAL attempt to terminal `failed`, (2) selects due
 * candidates — `pending` past `available_at` or `running` past `lease_until` —
 * oldest first, and (3) re-stamps each selected row `running` with a fresh
 * attempt count and lease. Two workers therefore never hold the same job:
 * whichever claim transaction commits first owns the row, and the loser's
 * re-read finds it leased. A claimed job's `attempts` is already incremented,
 * so a worker that dies mid-job burns exactly one attempt per lease it held.
 * @param db - admitted handle; must not have another transaction open.
 * @param options - owner, lease duration, batch size, model filter, clock.
 * @returns the claimed jobs in claim order (oldest first).
 */
export function claimEmbedJobs(db: DatabaseSync, options: ClaimEmbedJobsOptions): EmbedJob[] {
  if (options.owner.length === 0) throw new Error('embed job claim owner must be a non-empty string')
  assertPositiveSafeInteger('embed job leaseMs', options.leaseMs)
  const limit = options.limit ?? 1
  assertPositiveSafeInteger('embed job claim limit', limit)
  const now = options.now ?? Date.now()
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('embed job claim now must be a non-negative safe integer')
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`
      UPDATE code_embed_jobs
      SET status = 'failed', lease_owner = NULL, lease_until = NULL,
          last_error = 'embed worker lease expired after final attempt', updated_at = ?
      WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?
        AND attempts >= max_attempts
    `).run(now, now)
    const modelClause = options.model === undefined ? '' : 'AND model = ?'
    const modelBinds = options.model === undefined ? [] : [options.model]
    const candidates = db.prepare(`
      SELECT id FROM code_embed_jobs
      WHERE attempts < max_attempts AND (
        (status = 'pending' AND available_at <= ?)
        OR (status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?)
      ) ${modelClause}
      ORDER BY available_at ASC, created_at ASC, id ASC
      LIMIT ?
    `).all(now, now, ...modelBinds, limit) as Array<{ id: string }>
    const claim = db.prepare(`
      UPDATE code_embed_jobs
      SET status = 'running', attempts = attempts + 1, lease_owner = ?, lease_until = ?, updated_at = ?
      WHERE id = ?
    `)
    const claimed: EmbedJob[] = []
    for (const candidate of candidates) {
      claim.run(options.owner, now + options.leaseMs, now, candidate.id)
      claimed.push(parseEmbedJobRow(readJobRow(db, candidate.id)))
    }
    db.exec('COMMIT')
    return claimed
  } catch (error: unknown) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Input for {@link completeEmbedJob}. */
export interface CompleteEmbedJobInput {
  /** Job id as returned by the claim. */
  readonly id: string
  /** The claiming worker's identity; a foreign or expired lease refuses. */
  readonly owner: string
  /** Provider spend to record on the job (serialized into `usage_json`). */
  readonly usage: EmbedJobUsage
  /** Epoch-ms completion instant; defaults to wall-clock now. */
  readonly now?: number
}

/** Provider spend recorded on one completed embed job. */
export interface EmbedJobUsage {
  /** Prompt tokens the provider billed for this job's input text. */
  readonly promptTokens: number
}

/**
 * Settle a claimed job as `completed`, recording its usage and clearing the
 * lease. The vector itself is NOT stored here — a completed job's result is
 * its `chunks_vec` row, written inside its own evidence-epoch transaction by
 * the drain; `result_json` stays NULL by contract.
 * @param db - admitted handle.
 * @param input - job id, owning worker, usage, clock.
 * @returns the settled job row.
 * @throws when the job is not currently leased by `owner` with an unexpired
 *   lease — it was completed, failed, or re-claimed elsewhere; the caller
 *   must treat its own work as wasted instead of retrying the settlement.
 */
export function completeEmbedJob(db: DatabaseSync, input: CompleteEmbedJobInput): EmbedJob {
  const now = input.now ?? Date.now()
  const changed = db.prepare(`
    UPDATE code_embed_jobs
    SET status = 'completed', usage_json = ?, lease_owner = NULL,
        lease_until = NULL, last_error = NULL, updated_at = ?
    WHERE id = ? AND status = 'running' AND lease_owner = ?
      AND lease_until IS NOT NULL AND lease_until > ?
  `).run(JSON.stringify(input.usage), now, input.id, input.owner, now).changes
  if (changed !== 1) throw new Error(`embed job ${input.id} is not leased by ${input.owner}`)
  return parseEmbedJobRow(readJobRow(db, input.id))
}

/** Input for {@link failEmbedJob}. */
export interface FailEmbedJobInput {
  /** Job id as returned by the claim. */
  readonly id: string
  /** The claiming worker's identity; a foreign or expired lease refuses. */
  readonly owner: string
  /** Failure description stored on the job (capped at 2000 Unicode code points). */
  readonly error: string
  /** Epoch-ms instant the retry becomes claimable (only for non-terminal failures). */
  readonly retryAt: number
  /**
   * Provider spend already billed before the failure (a timeout after earlier
   * wire batches succeeded). Recorded into `usage_json` when present;
   * omitted leaves any stored usage untouched.
   */
  readonly usage?: EmbedJobUsage
  /** Epoch-ms settlement instant; defaults to wall-clock now. */
  readonly now?: number
}

/**
 * Settle a claimed job as failed. With attempts remaining the job returns to
 * `pending`, claimable again from `retryAt`; on the final attempt it becomes
 * terminally `failed` and no claim can ever select it again.
 * @param db - admitted handle.
 * @param input - job id, owning worker, error text, retry instant, optional
 *   already-billed usage, clock.
 * @returns the settled job row.
 * @throws when the lease guard fails (see {@link completeEmbedJob}), the error
 *   text is empty or overlong, or `retryAt` is not a non-negative safe
 *   integer.
 */
export function failEmbedJob(db: DatabaseSync, input: FailEmbedJobInput): EmbedJob {
  if (input.error.length === 0) throw new Error('embed job failure error must be a non-empty string')
  if (Array.from(input.error).length > MAX_LAST_ERROR_CODE_POINTS) {
    throw new Error(`embed job failure error must not exceed ${MAX_LAST_ERROR_CODE_POINTS} Unicode code points`)
  }
  if (!Number.isSafeInteger(input.retryAt) || input.retryAt < 0) {
    throw new Error('embed job failure retryAt must be a non-negative safe integer')
  }
  const now = input.now ?? Date.now()
  const row = readJobRow(db, input.id)
  const job = parseEmbedJobRow(row)
  // This pre-check is the lease guard: node:sqlite statements are
  // synchronous, so no interleaving can invalidate it before the UPDATE runs.
  if (row.status !== 'running' || row.lease_owner !== input.owner
    || row.lease_until === null || row.lease_until <= now) {
    throw new Error(`embed job ${input.id} is not leased by ${input.owner}`)
  }
  const terminal = job.attempts >= job.maxAttempts
  // COALESCE keeps a settlement without usage from erasing spend already
  // recorded on the row.
  db.prepare(`
    UPDATE code_embed_jobs
    SET status = ?, available_at = ?, lease_owner = NULL, lease_until = NULL,
        last_error = ?, usage_json = COALESCE(?, usage_json), updated_at = ?
    WHERE id = ? AND status = 'running' AND lease_owner = ?
  `).run(
    terminal ? 'failed' : 'pending',
    input.retryAt,
    input.error,
    input.usage === undefined ? null : JSON.stringify(input.usage),
    now,
    input.id,
    input.owner,
  )
  return parseEmbedJobRow(readJobRow(db, input.id))
}

/**
 * Count one model's jobs still waiting to be claimed (status `pending`).
 * Running jobs are not counted: their spend is in flight, and an abandoned
 * lease re-enters the pending count only when its reclaim actually happens.
 * The number is the cost-governance gauge — backlog depth against the
 * drain's job/token budget — not a monthly accounting total.
 * @param db - admitted handle.
 * @param model - embedding model identity to count.
 * @returns the pending job count.
 */
export function pendingEmbedCount(db: DatabaseSync, model: string): number {
  // COUNT(*) always answers exactly one row.
  const row = db.prepare(
    "SELECT COUNT(*) AS n FROM code_embed_jobs WHERE status = 'pending' AND model = ?",
  ).get(model) as { n: number }
  return row.n
}

/** One chunk's drain inputs read back from the `chunks` table. */
export interface EmbedChunkInput {
  /** Decoded chunk text; the embedding request's input. */
  readonly text: string
  /** `chunks.rowid`, denormalized into the eventual `chunks_vec` row. */
  readonly chunkRowid: number
}

/**
 * Read the drain inputs for the given chunk ids: decoded text plus rowid, in
 * one batched lookup. Ids without a `chunks` row are simply absent from the
 * result — the drain turns each absence into a job failure rather than a
 * silent skip.
 * @param db - admitted handle.
 * @param chunkIds - chunk ids to read.
 * @returns inputs keyed by chunk id.
 */
export function embedChunkInputs(db: DatabaseSync, chunkIds: readonly string[]): Map<string, EmbedChunkInput> {
  const inputs = new Map<string, EmbedChunkInput>()
  for (let start = 0; start < chunkIds.length; start += SQL_IN_BATCH_SIZE) {
    const batch = chunkIds.slice(start, start + SQL_IN_BATCH_SIZE)
    const placeholders = batch.map(() => '?').join(', ')
    const rows = db.prepare(
      `SELECT chunk_id, rowid, text, text_encoding FROM chunks WHERE chunk_id IN (${placeholders})`,
    ).all(...batch) as Array<{
      chunk_id: string
      rowid: number | bigint
      text: string
      text_encoding: string
    }>
    for (const row of rows) {
      inputs.set(row.chunk_id, {
        text: decodeChunkText(row.text_encoding, row.text),
        chunkRowid: Number(row.rowid),
      })
    }
  }
  return inputs
}

/** One chunk's queue identity inputs, joined with its file's content revision. */
export interface ChunkRevisionRow {
  readonly chunkId: string
  /** The owning `files.content_hash`; the chunk text revision marker a re-enqueue dedupes on. */
  readonly contentHash: string
}

/**
 * Read the embedding-job inputs for every chunk of the given files: chunk ids
 * joined with their file's committed content hash, in one batched lookup.
 * Files without chunk rows (oversized payloads record none) contribute
 * nothing; paths removed before the read contribute nothing with their
 * cascaded chunks. The refresh path feeds the just-committed batch here so
 * each pass enqueues exactly its own new work.
 * @param db - admitted handle.
 * @param files - workspace-relative file paths to read.
 * @returns rows in store-deterministic (chunk id) order.
 */
export function chunkRevisionsForFiles(db: DatabaseSync, files: readonly string[]): readonly ChunkRevisionRow[] {
  const wanted = [...new Set(files)].sort()
  const rows: ChunkRevisionRow[] = []
  for (let start = 0; start < wanted.length; start += SQL_IN_BATCH_SIZE) {
    const batch = wanted.slice(start, start + SQL_IN_BATCH_SIZE)
    const placeholders = batch.map(() => '?').join(', ')
    const found = db.prepare(
      'SELECT c.chunk_id AS chunkId, f.content_hash AS contentHash '
      + 'FROM chunks c JOIN files f ON f.file_path = c.file_path '
      + `WHERE c.file_path IN (${placeholders}) `
      + 'ORDER BY c.chunk_id ASC',
    ).all(...batch) as Array<{ chunkId: string; contentHash: string }>
    for (const row of found) rows.push({ chunkId: row.chunkId, contentHash: row.contentHash })
  }
  return rows
}

interface JobRow {
  id: string
  chunk_id: string
  model: string
  content_hash: string
  attempts: number
  max_attempts: number
  lease_until: number | null
  created_at: number
  status: string
  lease_owner: string | null
}

/** Read one raw job row, throwing when the id is unknown. */
function readJobRow(db: DatabaseSync, id: string): JobRow {
  const row = db.prepare('SELECT * FROM code_embed_jobs WHERE id = ?').get(id) as JobRow | undefined
  if (row === undefined) throw new Error(`embed job ${id} was not found`)
  return row
}

/** Project one raw row into the caller-facing job record. */
function parseEmbedJobRow(row: JobRow): EmbedJob {
  return {
    id: row.id,
    chunkId: row.chunk_id,
    model: row.model,
    contentHash: row.content_hash,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    leaseUntil: row.lease_until === null ? -1 : row.lease_until,
    createdAt: row.created_at,
  }
}

/** Refuse anything but a positive safe integer (shared queue validation). */
function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`)
  }
}
