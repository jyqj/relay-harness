/** Client-safe Prompt Enhancement result types. */

import type { JsonValue } from '@relay-harness/rlh-session/types'

/** Exact auxiliary model route that produced an enhanced draft. */
export interface PromptEnhancementModelProvenance {
  /** Registered LLM provider route. */
  readonly provider: string
  /** Provider-owned model id. */
  readonly model: string
}

/** Structured enhancement accepted from the configured provider. */
export interface PromptEnhancementResult {
  /** Exact draft supplied by the caller; never normalized or truncated. */
  readonly originalDraft: string
  /** Complete proposed replacement; accepting it remains a client action. */
  readonly enhancedDraft: string
  /** New assumptions made explicit by the proposal. */
  readonly assumptions: readonly string[]
  /** Questions the proposal leaves for the user instead of inventing answers. */
  readonly openQuestions: readonly string[]
  /** Exact auxiliary model route used for this proposal. */
  readonly model: PromptEnhancementModelProvenance
  /** Opaque trace projected by the configured Context Engine adapter, when supplied. */
  readonly contextTrace?: JsonValue
}

/** Provider-neutral failure facts safe to return to a client. */
export interface PromptEnhancementFailure {
  /** Stable machine-readable failure code. */
  readonly code: string
  /** User-readable failure summary with no stack or provider secret. */
  readonly message: string
}

/**
 * One enhancement attempt. Every branch carries the original draft, so a
 * caller can leave its editor untouched on cancellation or failure.
 */
export type PromptEnhancementOutcome =
  | { readonly kind: 'enhanced'; readonly result: PromptEnhancementResult }
  | {
    readonly kind: 'preserved'
    readonly reason: 'cancelled' | 'failed'
    readonly originalDraft: string
    readonly failure?: PromptEnhancementFailure
  }
