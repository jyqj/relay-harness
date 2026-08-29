/**
 * Embedding job drain: claim, embed, quantize, commit, settle.
 *
 * One drain call walks the embedding queue to a stop condition. Each claimed
 * job runs the full pipeline — chunk text read, provider request, int8
 * quantization, one batch `chunks_vec` commit, then per-job usage settlement.
 * Every successful vector batch advances `embedding_epoch` once and leaves
 * runtime `evidence_epoch` untouched. Failures settle through the queue's
 * attempt budget; deterministic misconfigurations refuse to burn it and stop
 * the drain loudly instead.
 *
 * @module @relay-harness/rlh-code-index-local/embed/worker
 */

import type { DatabaseSync } from 'node:sqlite'
import type { QuantizedVectorInt8 } from '@relay-harness/rlh-code-index-search'
import { quantizeInt8 } from '@relay-harness/rlh-code-index-search'
import {
  claimEmbedJobs,
  completeEmbedJob,
  embedChunkInputs,
  failEmbedJob,
} from '@relay-harness/rlh-code-index-sqlite'
import { writeChunkVectors } from '@relay-harness/rlh-code-index-sqlite'
import type { EmbedResult } from './client.ts'
import {
  EmbedError,
  EMBED_ABORTED,
  EMBED_DIMENSION_MISMATCH,
  EMBED_INVALID_CREDENTIAL,
  EMBED_RESPONSE_INVALID,
} from './errors.ts'

/**
 * The client surface the drain consumes: the model identity that selects
 * claimable jobs plus the embed operation. `EmbeddingClient` satisfies it;
 * the structural type keeps the drain testable and lets callers compose
 * other embedders without the concrete class.
 */
export interface EmbedderLike {
  /** Embedding model identity; claims are filtered to this model. */
  readonly model: string
  /** Embed one batch of texts. See {@link EmbeddingClient.embed}. */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<EmbedResult>
}

/** Default lease duration for one claimed job (one minute). */
export const DEFAULT_EMBED_DRAIN_LEASE_MS = 60_000

/** Default delay before a failed job becomes claimable again. */
export const DEFAULT_EMBED_DRAIN_RETRY_MS = 1_000

/** Why a drain stopped, reported for observability. */
export type DrainStopReason =
  /** The queue had no claimable job. */
  | 'queue-empty'
  /** `jobsClaimed` reached `maxJobs`. */
  | 'job-budget'
  /** Cumulative prompt tokens reached `maxPromptTokens`. */
  | 'token-budget'
  /** The caller's signal aborted; the in-flight job's lease is left to expire. */
  | 'signal'

/** Result of one completed {@link drainEmbedJobs} call. */
export interface DrainEmbedJobsResult {
  readonly batchesClaimed: number
  readonly batchesWritten: number
  /** Jobs claimed over the drain's lifetime. */
  readonly jobsClaimed: number
  /** Jobs settled `completed` with a vector row committed. */
  readonly jobsCompleted: number
  /** Jobs settled back to `pending` or terminally `failed` after an error. */
  readonly jobsFailed: number
  /** Vector rows committed (equals `jobsCompleted`). */
  readonly vectorsWritten: number
  /** Provider spend accumulated over completed requests. */
  readonly promptTokens: number
  /** Settlements refused because the lease was lost mid-job (counted, not fatal). */
  readonly leaseSettlementsRefused: number
  /** Why the drain stopped. */
  readonly stoppedBecause: DrainStopReason
}

/** Mutable counters folded into the drain result. */
interface DrainCounters {
  batchesClaimed: number
  batchesWritten: number
  jobsClaimed: number
  jobsCompleted: number
  jobsFailed: number
  vectorsWritten: number
  promptTokens: number
  leaseSettlementsRefused: number
}

/** Options for {@link drainEmbedJobs}. */
export interface DrainEmbedJobsOptions {
  /** Admitted code-index store handle (closed by the caller, not the drain). */
  readonly db: DatabaseSync
  /** The embedding client; its `model` selects which jobs are claimed. */
  readonly client: EmbedderLike
  /**
   * Quantizer applied to each returned vector; defaults to
   * `quantizeInt8`. Injection exists so tests can pin exact stored bytes.
   */
  readonly quantize?: (vector: Float32Array) => QuantizedVectorInt8
  /** Worker identity stamped onto every lease; unique per live worker. */
  readonly owner: string
  /** Complete generation id claimed and stamped onto vector rows. */
  readonly generationId?: string
  /** Jobs embedded and committed together; defaults to one for direct callers. */
  readonly batchSize?: number
  /** Upper bound on jobs claimed this drain. */
  readonly maxJobs: number
  /** Upper bound on scheduled prompt-token spend this drain. */
  readonly maxPromptTokens: number
  /** Lease duration per claim; defaults to {@link DEFAULT_EMBED_DRAIN_LEASE_MS}. */
  readonly leaseMs?: number
  /** Delay before a failed job is claimable again; defaults to {@link DEFAULT_EMBED_DRAIN_RETRY_MS}. */
  readonly retryDelayMs?: number
  /** Caller cancellation; checked between jobs and fused into provider calls. */
  readonly signal?: AbortSignal
  /** Epoch-ms clock; defaults to wall-clock now. */
  readonly now?: () => number
}

/**
 * Drain the embedding queue until a budget, the queue, or the caller's signal
 * stops it.
 *
 * Per batch: claim leases → batch-read chunk text → embed → quantize → commit
 * all vector rows in one embedding-epoch transaction → settle each job with
 * its allocated usage. The
 * token budget is checked before each claim, so the drain never starts a job
 * it could not pay for; the final job may overshoot the cap by its own spend,
 * which no pre-claim check can predict. Abort semantics follow the reference
 * worker: a caller abort stops the drain without settling the in-flight job,
 * whose lease expires and hands the attempt to a later claim. A per-batch
 * deadline (`EMBED_TIMEOUT`) is the deterministic-failure path's symmetric
 * transient twin: the job settles through the attempt budget (partial spend
 * recorded onto `usage_json`) and the drain continues with the next job. A
 * deterministic misconfiguration (`EMBED_DIMENSION_MISMATCH`,
 * `EMBED_INVALID_CREDENTIAL`) is settled through the queue and then rethrown —
 * retrying cannot succeed, so the drain refuses to burn the remaining attempt
 * budget queue-wide.
 * @param options - store, client, budgets, identity, and clock.
 * @returns per-drain counters and the stop reason.
 * @throws {EmbedError} rethrown after settlement for deterministic failures.
 */
export async function drainEmbedJobs(options: DrainEmbedJobsOptions): Promise<DrainEmbedJobsResult> {
  const quantize = options.quantize ?? quantizeInt8
  const now = options.now ?? Date.now
  const leaseMs = options.leaseMs ?? DEFAULT_EMBED_DRAIN_LEASE_MS
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_EMBED_DRAIN_RETRY_MS
  const batchSize = options.batchSize ?? 1
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('embed drain batchSize must be a positive safe integer')
  const counters: DrainCounters = {
    batchesClaimed: 0,
    batchesWritten: 0,
    jobsClaimed: 0,
    jobsCompleted: 0,
    jobsFailed: 0,
    vectorsWritten: 0,
    promptTokens: 0,
    leaseSettlementsRefused: 0,
  }
  let aborted = false

  while (counters.jobsClaimed < options.maxJobs && counters.promptTokens < options.maxPromptTokens) {
    if (options.signal?.aborted) {
      aborted = true
      break
    }
    const jobs = claimEmbedJobs(options.db, {
      owner: options.owner,
      leaseMs,
      limit: Math.min(batchSize, options.maxJobs - counters.jobsClaimed),
      ...(options.generationId === undefined
        ? { model: options.client.model }
        : { generationId: options.generationId }),
      now: now(),
    })
    if (jobs.length === 0) break
    counters.batchesClaimed += 1
    counters.jobsClaimed += jobs.length

    const inputByChunk = embedChunkInputs(options.db, jobs.map(job => job.chunkId))
    const ready = jobs.flatMap((job) => {
      const input = inputByChunk.get(job.chunkId)
      if (input !== undefined) return [{ job, input }]
      settleFailure(options, counters, job.id, 'the chunk row disappeared before embedding', retryDelayMs, now)
      return []
    })
    if (ready.length === 0) continue
    try {
      const { vectors, promptTokens } = await options.client.embed(ready.map(item => item.input.text), options.signal)
      if (vectors.length !== ready.length) {
        throw new EmbedError(
          ready.length === 1 && vectors.length === 0
            ? 'the embedding endpoint returned no vector for the job input'
            : `the embedding endpoint returned ${vectors.length} vectors for ${ready.length} job inputs`,
          EMBED_RESPONSE_INVALID,
        )
      }
      if (!Number.isSafeInteger(promptTokens) || promptTokens < 0) {
        throw new EmbedError('the embedding endpoint returned invalid prompt-token usage', EMBED_RESPONSE_INVALID)
      }
      counters.promptTokens += promptTokens
      writeChunkVectors(options.db, ready.map((item, index) => {
        const vector = vectors[index] as Float32Array
        const quantized = quantize(vector)
        return {
          chunkId: item.job.chunkId,
          chunkRowid: item.input.chunkRowid,
          generationId: item.job.generationId,
          model: options.client.model,
          dim: vector.length,
          scale: quantized.scale,
          q: new Uint8Array(quantized.q.buffer),
          norm: quantized.norm,
        }
      }))
      counters.batchesWritten += 1
      const usage = allocatePromptTokens(promptTokens, ready.map(item => item.input.text))
      for (let index = 0; index < ready.length; index++) {
        settleCompletion(options, counters, (ready[index] as typeof ready[number]).job.id, usage[index] ?? 0, now)
      }
    } catch (error: unknown) {
      if (options.signal?.aborted || (error instanceof EmbedError && error.code === EMBED_ABORTED)) {
        aborted = true
        break
      }
      if (error instanceof EmbedError
        && (error.code === EMBED_DIMENSION_MISMATCH || error.code === EMBED_INVALID_CREDENTIAL)) {
        const partialUsage = error.promptTokensUsed === undefined
          ? undefined
          : allocatePromptTokens(error.promptTokensUsed, ready.map(item => item.input.text))
        for (let index = 0; index < ready.length; index++) {
          const item = ready[index] as typeof ready[number]
          settleFailure(options, counters, item.job.id, error.message, retryDelayMs, now, partialUsage?.[index])
        }
        throw error
      }
      // A per-batch deadline (EMBED_TIMEOUT) is a deterministic per-attempt
      // failure, not an abort: settle the job through the attempt budget and
      // move on to the next one instead of stopping the whole drain.
      const partialUsage = error instanceof EmbedError && error.promptTokensUsed !== undefined
        ? allocatePromptTokens(error.promptTokensUsed, ready.map(item => item.input.text))
        : undefined
      for (let index = 0; index < ready.length; index++) {
        const item = ready[index] as typeof ready[number]
        settleFailure(
          options,
          counters,
          item.job.id,
          error instanceof Error ? error.message : String(error),
          retryDelayMs,
          now,
          partialUsage?.[index],
        )
      }
    }
  }

  const stoppedBecause: DrainStopReason = aborted
    ? 'signal'
    : counters.jobsClaimed >= options.maxJobs
      ? 'job-budget'
      : counters.promptTokens >= options.maxPromptTokens
        ? 'token-budget'
        : 'queue-empty'
  return { ...counters, stoppedBecause } satisfies DrainEmbedJobsResult
}

/** Deterministically distribute aggregate provider usage without losing a token. */
function allocatePromptTokens(total: number, texts: readonly string[]): number[] {
  if (texts.length === 0) return []
  const weights = texts.map(text => Math.max(1, Math.ceil(text.length / 4)))
  const weightTotal = weights.reduce((sum, weight) => sum + weight, 0)
  const allocated = weights.map(weight => Math.floor(total * weight / weightTotal))
  let remainder = total - allocated.reduce((sum, value) => sum + value, 0)
  for (let index = 0; remainder > 0; index = (index + 1) % allocated.length) {
    allocated[index] = (allocated[index] ?? 0) + 1
    remainder--
  }
  return allocated
}

/** Settle one job as completed, counting refused settlements without failing. */
function settleCompletion(
  options: DrainEmbedJobsOptions,
  counters: DrainCounters,
  jobId: string,
  promptTokens: number,
  now: () => number,
): void {
  try {
    completeEmbedJob(options.db, { id: jobId, owner: options.owner, usage: { promptTokens }, now: now() })
    counters.jobsCompleted += 1
    counters.vectorsWritten += 1
  } catch {
    // The lease expired mid-job and another worker re-claimed it; our vector
    // row was still committed and the winner will commit its own. Counted for
    // observability, never fatal.
    counters.leaseSettlementsRefused += 1
  }
}

/** Settle one job as failed through the queue's attempt budget, recording any spend billed before the failure. */
function settleFailure(
  options: DrainEmbedJobsOptions,
  counters: DrainCounters,
  jobId: string,
  error: string,
  retryDelayMs: number,
  now: () => number,
  promptTokensUsed?: number,
): void {
  try {
    failEmbedJob(options.db, {
      id: jobId,
      owner: options.owner,
      error,
      retryAt: now() + retryDelayMs,
      now: now(),
      ...(promptTokensUsed === undefined ? {} : { usage: { promptTokens: promptTokensUsed } }),
    })
    counters.jobsFailed += 1
  } catch {
    counters.leaseSettlementsRefused += 1
  }
}
