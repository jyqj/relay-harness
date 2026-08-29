/**
 * Structured failure codes for the embedding client.
 *
 * @module @relay-harness/rlh-code-index-local/embed/errors
 */

import { HarnessError } from '@relay-harness/rlh-llm'

/** The stored or configured credential is present but unusable (empty or header-illegal). */
export const EMBED_INVALID_CREDENTIAL = 'EMBED_INVALID_CREDENTIAL'

/** The endpoint answered, but a returned vector's dimensionality contradicts the configuration. */
export const EMBED_DIMENSION_MISMATCH = 'EMBED_DIMENSION_MISMATCH'

/** The endpoint refused or failed the request (HTTP error status or transport failure). */
export const EMBED_PROVIDER_ERROR = 'EMBED_PROVIDER_ERROR'

/** The caller's signal cancelled the request. */
export const EMBED_ABORTED = 'EMBED_ABORTED'

/**
 * A wire request's deadline elapsed before the endpoint answered. Distinct
 * from {@link EMBED_ABORTED}: a timeout is a deterministic per-attempt failure
 * the drain settles through the attempt budget and moves past, while an abort
 * stops the whole drain without settling.
 */
export const EMBED_TIMEOUT = 'EMBED_TIMEOUT'

/** The endpoint answered 2xx but the body is not a usable embeddings reply (non-JSON, over the read ceiling, wrong record count). */
export const EMBED_RESPONSE_INVALID = 'EMBED_RESPONSE_INVALID'

/**
 * Structured embedding failure. Extends {@link HarnessError} with a stable
 * `code` (`EMBED_*`) that the drain and its callers route on instead of
 * parsing `message`. Deterministic codes (`EMBED_DIMENSION_MISMATCH`,
 * `EMBED_INVALID_CREDENTIAL`) mean retrying cannot succeed; the drain stops
 * loudly on them instead of burning the queue's attempt budget.
 */
export class EmbedError extends HarnessError {
  /**
   * Prompt tokens already billed by successful wire batches earlier in the
   * same `embed` call, attached where the failure leaves the client so a
   * failed job can still record its partial spend; `undefined` when the
   * failure carried no partial spend.
   */
  promptTokensUsed: number | undefined = undefined
}
