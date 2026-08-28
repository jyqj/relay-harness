/**
 * Context-engine vocabulary: resource addressing, the evidence protocol, retrieval coverage and
 * negative findings, knowledge-provider observability, and the step-context seam. Types only — the
 * {@link ContextEngineError} taxonomy and the branded id factories are runtime and live in
 * `index.ts` and `brand.ts`. The projected contracts live in the
 * [context-engine subsystem page](../../../docs/subsystems/context-engine.md); the design
 * authority is ADR-0006 in the Relay root repository (outside this repository).
 * @module @relay-harness/rlh-context-engine/types
 */

import type { SourceId, EvidenceId } from './brand.ts'
import type { UserMessage } from '@relay-harness/rlh-llm'

/**
 * One addressable resource inside a registered source. `key` and `revision` are opaque to the
 * engine: a file tree uses paths and stat identities, a session corpus uses ids and event seqs,
 * a memory scope uses entry ids and revision numbers.
 */
export interface ResourceRef {
  /** The source that owns and addresses the resource. */
  readonly sourceId: SourceId
  /** Source-local opaque resource key (never a bare cross-source path). */
  readonly key: string
  /** Source-local opaque revision; omitted marks `revision unknown`, never "any revision". */
  readonly revision?: string
}

/**
 * Verification outcome of one evidence record. Mechanical verification (digest and revision
 * agreement at hydration) runs unconditionally; semantic verification only under an explicit
 * obligation, so most records stay `unverified` by design rather than by omission.
 */
export type EvidenceVerification =
  | 'verified'
  | 'partially-verified'
  | 'unverified'
  | 'contradicted'
  | 'unavailable'

/**
 * Freshness of an evidence record relative to its source revision. `current` means the revision
 * was observed at acquisition; staleness is detected by comparing the bound revision against the
 * source at hydration.
 */
export type EvidenceFreshness = 'current' | 'possibly-stale' | 'stale' | 'unknown'

/**
 * One admitted observation bound to a source revision. A raw search hit is not evidence: only
 * records that passed admission (revision present or explicitly unknown, provenance attributed)
 * carry this type. `domain` holds the provider-owned payload (code graph fields, layout, trust)
 * and stays opaque to the engine.
 */
export interface Evidence {
  /** Identity of this record within one prepared step context. */
  readonly evidenceId: EvidenceId
  /** The resource the observation is bound to. */
  readonly resource: ResourceRef
  /** Content digest of the observation, when it carried inline content. */
  readonly digest?: string
  /** Whether the observation's content was truncated by a budget. */
  readonly truncated: boolean
  /** Freshness relative to the bound revision at acquisition. */
  readonly freshness: EvidenceFreshness
  /** Verification outcome; `unverified` is an explicit state, not a default. */
  readonly verification: EvidenceVerification
  /** Provider-owned domain payload; the engine never interprets it. */
  readonly domain?: unknown
}

/**
 * Completeness classification of one coverage record. `exhaustive` alone supports high-confidence
 * negative claims; `bounded` names an explicit scope, `best-effort` an implicit one.
 */
export type CoverageCompleteness = 'exhaustive' | 'bounded' | 'best-effort' | 'unknown'

/**
 * What a retrieval actually inspected: the scopes searched, the scopes deliberately skipped and
 * why, and the completeness classification. A zero-hit result without a coverage record reads as
 * "not found here", never as "does not exist".
 */
export interface CoverageRecord {
  /** Scopes actually inspected (directories, sources, patterns), as specific as available. */
  readonly searched: readonly string[]
  /** Scopes a consumer might expect to be covered but were deliberately skipped. */
  readonly notSearched: readonly string[]
  /** One-sentence justification of the searched/not-searched split. */
  readonly rationale?: string
  /** Completeness classification of the inspection. */
  readonly completeness: CoverageCompleteness
}

/**
 * One negative claim ("X does not exist") with the scopes checked to support it. An empty
 * `checked` list is invalid: a negative claim without inspected scopes is not assertable.
 */
export interface NegativeFinding {
  /** The negative claim in one sentence. */
  readonly claim: string
  /** Files, directories, or patterns actually checked; at least one entry. */
  readonly checked: readonly string[]
  /** `high` requires exhaustive inspection; `medium` most-likely locations; `low` spot checks. */
  readonly confidence: 'high' | 'medium' | 'low'
}

/**
 * Lifecycle state of one knowledge provider. `degraded` covers partial index closure and budget
 * exhaustion; queries still run but their results carry the degraded generation.
 */
export type ProviderHealthState =
  | 'uninitialized'
  | 'syncing'
  | 'ready'
  | 'degraded'
  | 'stale'
  | 'rebuilding'
  | 'failed'

/**
 * Two-clock generation of one knowledge provider's index: `indexEpoch` advances on index-content
 * commits, `evidenceEpoch` only on runtime-evidence ingestion, so evidence writes do not
 * invalidate index-only caches. Consumers compare the pair as a cache key.
 */
export interface ProviderGeneration {
  /** Generation of index content (file batches, graph rebuilds, full rebuilds). */
  readonly indexEpoch: number
  /** Generation of runtime-evidence ingestion alone. */
  readonly evidenceEpoch: number
}

/**
 * Why one provider response is partial rather than complete. `truncatedReason` is a stable token
 * (`output_budget`, `default_limit`, `max_depth`, `db_error:<op>`, …), never free text, so
 * consumers can assert on it. Read errors are degraded-not-failed outcomes.
 */
export interface ProviderExplain {
  /** Whether any budget or read error reduced the response. */
  readonly truncated: boolean
  /** Stable token of the first truncation cause, when truncated. */
  readonly truncatedReason?: string
  /** Degraded database or provider reads, as `<op>: <error>` entries. */
  readonly readErrors: readonly string[]
}

/**
 * One step's input to every contributor: the claimed user messages and the step's abort signal.
 * The engine adds nothing else; working sets and explicit references arrive inside the messages
 * themselves (file mentions, session references), so request construction stays deterministic.
 */
export interface StepContextInput {
  /** The user messages claimed for this step, in claim order. */
  readonly messages: readonly UserMessage[]
  /** Aborted when the step is cancelled; contributors must pass it through to their reads. */
  readonly signal: AbortSignal
  /** The step's working directory, from the session header; resolves relative message references. */
  readonly cwd: string
}

/**
 * One contributor's result for a step. `message` is model-visible and the contributor owns its
 * source attribution; `evidence` and `coverage` record what the message rests on. Returning
 * `undefined` contributes nothing.
 */
export interface ContributedStepContext {
  /** The model-visible context message; appended after the claimed messages. */
  readonly message: UserMessage
  /** Evidence records backing the message, revision-bound. */
  readonly evidence?: readonly Evidence[]
  /** What the contributor actually inspected to produce the message. */
  readonly coverage?: CoverageRecord
}

/**
 * One registered step-context contributor. Contributors run in registration order, once per
 * prepared step, and see the same claimed messages.
 */
export interface StepContextContributor {
  /** Stable contributor identity; unique within the registry. */
  readonly id: string
  /**
   * Contribute context for one step.
   * @param input - the claimed messages and abort signal for the step.
   * @returns the contributed context, or `undefined` when this step needs none.
   */
  contribute(input: StepContextInput): Promise<ContributedStepContext | undefined>
}

/**
 * A prepared step context: the collected model-visible messages and the evidence behind them.
 * `undefined` from {@link ContextEngineService.prepareStep} means no contributor produced
 * context this step.
 */
export interface PreparedStepContext {
  /** Contributor messages in contributor registration order. */
  readonly messages: readonly UserMessage[]
  /** All evidence records from every contributing contributor, concatenated. */
  readonly evidence: readonly Evidence[]
}

/**
 * `ctx.contextEngine`. Owns the contributor registry and the step preparation call; retrieval
 * planning, hydration, and packing enrich `prepareStep` inside implementations of this seam.
 */
export interface ContextEngineService {
  /**
   * Register one step-context contributor.
   * @param contributor - the contributor with a unique non-empty id.
   * @returns a disposer removing the registration.
   */
  registerContributor(contributor: StepContextContributor): () => void
  /**
   * Prepare the step context for one claimed step.
   * @param input - the claimed messages and abort signal.
   * @returns the collected context, or `undefined` when no contributor produced any.
   */
  prepareStep(input: StepContextInput): Promise<PreparedStepContext | undefined>
}
