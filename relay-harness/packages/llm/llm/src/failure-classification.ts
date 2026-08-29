/**
 * Structured recovery classification for a normalized model-request failure.
 *
 * The adapter boundary already detaches serializable facts (`LlmFailure`);
 * this module folds those facts into the recovery class a policy executor
 * routes on, so `rlh-llm-retry` (and future credential-pool or fallback
 * policies) share one classification instead of re-deriving it inline.
 *
 * @module @relay-harness/rlh-llm/failure-classification
 */

import { CONTEXT_WINDOW_EXCEEDED_CODE, EMPTY_RESPONSE_CODE } from './error.ts'
import type { LlmFailure } from './types.ts'

/**
 * Failure codes whose repetition can succeed with no change to the request:
 * transient rate, server, timeout, transport, and degenerate-completion
 * failures. Membership here says nothing about policy eligibility — a normal
 * retry policy still gates on its own configured `retryableCodes`.
 */
export const TRANSIENT_FAILURE_CODES: readonly string[] = Object.freeze([
  EMPTY_RESPONSE_CODE,
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
])

/**
 * Recovery class of one normalized failure:
 * - `local-retryable` — transient; a locally scheduled backoff retry may succeed.
 * - `provider-scheduled` — the provider named a resume time; waiting that
 *   delay (bounded by policy) is the precise recovery, whatever the code.
 * - `context-overflow` — the request exceeded the model context window;
 *   recovery is compaction, never a wait.
 * - `terminal` — repeating the same request cannot help (quota without a
 *   named reset, auth, invalid request, unrecognized classes).
 */
export type LlmFailureRecovery =
  | { readonly kind: 'local-retryable' }
  | { readonly kind: 'provider-scheduled'; readonly delayMs: number }
  | { readonly kind: 'context-overflow' }
  | { readonly kind: 'terminal' }

/**
 * Classify one normalized failure into its recovery class.
 *
 * Precedence is deliberate: context overflow is never wait-recoverable even
 * when a provider attaches a delay; a named resume time then beats the code
 * taxonomy because the provider's own schedule is the strongest recovery
 * signal (a `QUOTA` with a reset time is periodic, one without is terminal);
 * the transient-code set decides what remains.
 * @param failure - serializable facts normalized at the final adapter boundary.
 * @returns the recovery class a policy executor routes on.
 */
export function classifyLlmFailure(failure: LlmFailure): LlmFailureRecovery {
  if (failure.code === CONTEXT_WINDOW_EXCEEDED_CODE) return { kind: 'context-overflow' }
  const delay = failure.providerRetryAfterMs
  if (delay !== undefined && Number.isFinite(delay) && delay > 0) {
    return { kind: 'provider-scheduled', delayMs: delay }
  }
  if (TRANSIENT_FAILURE_CODES.includes(failure.code)) return { kind: 'local-retryable' }
  return { kind: 'terminal' }
}
