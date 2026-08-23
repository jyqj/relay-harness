/** Durable automatic-memory-extraction job seam. */

import { Context, Service } from '@deepseek-ai/cordis'
import type {
  ClaimMemoryExtractionInput,
  CompleteMemoryExtractionInput,
  EnqueueMemoryExtractionInput,
  FailMemoryExtractionInput,
  MemoryExtractionJob,
  MemoryExtractionJobId,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memoryExtractionQueue: MemoryExtractionQueue
  }
}

/** Provider-neutral durable queue used by turn capture and extractor workers. */
export abstract class MemoryExtractionQueue extends Service {
  constructor(ctx: Context) {
    super(ctx, 'memoryExtractionQueue')
  }

  /**
   * Idempotently admit one completed-turn source snapshot.
   * @param input - exact Scope, source hash, route, bounded sources, and retry cap.
   * @returns existing or newly committed job for the dedupe identity.
   */
  abstract enqueue(input: EnqueueMemoryExtractionInput): Promise<MemoryExtractionJob>

  /**
   * Atomically claim the oldest available job or reclaim one whose lease expired.
   * @param input - worker identity, lease duration, and optional deterministic clock.
   * @returns claimed running job, or undefined when none is available.
   */
  abstract claim(input: ClaimMemoryExtractionInput): Promise<MemoryExtractionJob | undefined>

  /**
   * Commit one successful extraction under the current lease.
   * @param input - job, worker identity, and terminal result.
   * @returns completed job.
   */
  abstract complete(input: CompleteMemoryExtractionInput): Promise<MemoryExtractionJob>

  /**
   * Settle one failed attempt as pending retry or terminal failed.
   * @param input - job, worker identity, error, and requested retry time.
   * @returns updated job.
   */
  abstract fail(input: FailMemoryExtractionInput): Promise<MemoryExtractionJob>

  /**
   * Read one job for diagnostics and tests.
   * @param id - durable job identity.
   * @returns current job, or undefined when absent.
   */
  abstract read(id: MemoryExtractionJobId): Promise<MemoryExtractionJob | undefined>
}

export default MemoryExtractionQueue
