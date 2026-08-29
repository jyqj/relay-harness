/**
 * Embedding tier for the local code index: the OpenAI-compatible client, the
 * SQLite-backed job queue composition, and the drain worker.
 *
 * The queue's SQL lives in the storage package (`code_embed_jobs` table and
 * its claim/settlement functions); this module composes it with the provider
 * client and the int8 quantizer so chunk text becomes a `chunks_vec` row with
 * one embedding-epoch transaction per vector batch. Provider wiring (which endpoint
 * serves which workspace) is the Service Provider's Config decision, not this
 * module's.
 *
 * @module @relay-harness/rlh-code-index-local/embed
 */

export { EmbeddingClient } from './client.ts'
export type { EmbeddingClientOptions, EmbedResult } from './client.ts'
export {
  EMBEDDING_CHUNKER_VERSION,
  EMBEDDING_NORMALIZATION_VERSION,
  EMBEDDING_PROVIDER_ID,
  EMBEDDING_QUANTIZER_VERSION,
  embeddingEndpointIdentity,
  resolveEmbeddingGeneration,
} from './generation.ts'
export type { EmbeddingGenerationInput } from './generation.ts'
export {
  EmbedError,
  EMBED_ABORTED,
  EMBED_DIMENSION_MISMATCH,
  EMBED_INVALID_CREDENTIAL,
  EMBED_PROVIDER_ERROR,
  EMBED_RESPONSE_INVALID,
  EMBED_TIMEOUT,
} from './errors.ts'
export {
  DEFAULT_EMBED_DRAIN_LEASE_MS,
  DEFAULT_EMBED_DRAIN_RETRY_MS,
  drainEmbedJobs,
} from './worker.ts'
export type {
  DrainEmbedJobsOptions,
  DrainEmbedJobsResult,
  DrainStopReason,
  EmbedderLike,
} from './worker.ts'
