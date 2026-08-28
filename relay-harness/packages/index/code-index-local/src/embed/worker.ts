/**
 * Embedding job drain: claim, embed, quantize, commit, settle.
 *
 * One drain call walks the embedding queue to a stop condition. Each claimed
 * job runs the full pipeline — chunk text read, provider request, int8
 * quantization, `chunks_vec` commit inside its own evidence-epoch
 * transaction, completion settlement with the recorded usage — so every
 * commit moves `evidence_epoch` exactly once and a drained job leaves one
 * vector row plus one usage record. Failures settle through the queue's
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
 * Per job: claim (one attempt burned) → read the chunk text
 * (`embedChunkInputs`) → embed → quantize → commit the vector row in one
 * evidence-epoch transaction → complete with the job's recorded usage. The
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
  const counters: DrainCounters = {
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
    const [job] = claimEmbedJobs(options.db, {
      owner: options.owner,
      leaseMs,
      limit: 1,
      model: options.client.model,
      now: now(),
    })
    if (job === undefined) break
    counters.jobsClaimed += 1

    const input = embedChunkInputs(options.db, [job.chunkId]).get(job.chunkId)
    if (input === undefined) {
      settleFailure(options, counters, job.id, 'the chunk row disappeared before embedding', retryDelayMs, now)
      continue
    }
    try {
      const { vectors, promptTokens } = await options.client.embed([input.text], options.signal)
      // One input in, one vector out is the client's contract; the guard
      // turns a contract breach into a routable queue failure.
      const [vector] = vectors
      if (vector === undefined) {
        throw new EmbedError('the embedding endpoint returned no vector for the job input', EMBED_RESPONSE_INVALID)
      }
      counters.promptTokens += promptTokens
      const quantized = quantize(vector)
      writeChunkVectors(options.db, [{
        chunkId: job.chunkId,
        chunkRowid: input.chunkRowid,
        model: options.client.model,
        dim: vector.length,
        scale: quantized.scale,
        q: new Uint8Array(quantized.q.buffer),
        norm: quantized.norm,
      }])
      settleCompletion(options, counters, job.id, promptTokens, now)
    } catch (error: unknown) {
      if (options.signal?.aborted || (error instanceof EmbedError && error.code === EMBED_ABORTED)) {
        aborted = true
        break
      }
      if (error instanceof EmbedError
        && (error.code === EMBED_DIMENSION_MISMATCH || error.code === EMBED_INVALID_CREDENTIAL)) {
        settleFailure(options, counters, job.id, error.message, retryDelayMs, now, error.promptTokensUsed)
        throw error
      }
      // A per-batch deadline (EMBED_TIMEOUT) is a deterministic per-attempt
      // failure, not an abort: settle the job through the attempt budget and
      // move on to the next one instead of stopping the whole drain.
      settleFailure(
        options,
        counters,
        job.id,
        error instanceof Error ? error.message : String(error),
        retryDelayMs,
        now,
        error instanceof EmbedError ? error.promptTokensUsed : undefined,
      )
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
