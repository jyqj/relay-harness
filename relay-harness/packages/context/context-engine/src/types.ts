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
import type { JsonValue, SessionId, SessionOrigin } from '@relay-harness/rlh-session/types'

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
  /** Provider-owned, durable JSON payload; the engine never interprets it. */
  readonly domain?: JsonValue
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

/** Why context is being prepared; contributors use it to select purpose-specific retrieval and packing. */
export type ContextPurpose = 'agent_step' | 'prompt_enhancement'

/**
 * Durable identity of the caller whose context is being prepared.  Contributors must not retain
 * live Agent objects: this detached value is enough to address provider-local scope, correlate a
 * prepared observation with its host turn, and apply preset/subagent policy consistently to Agent
 * steps and auxiliary requests.
 */
export interface StepContextCaller {
  /** Durable Session identity shared by the live Agent and its event log. */
  readonly sessionId: SessionId
  /** Live Agent identity. Today it equals `sessionId`, but remains explicit at the seam. */
  readonly agentId: string
  /** Stable workspace partition selected by the caller (`cwd`, or `global` when absent). */
  readonly workspaceId: string
  /** Owning host turn for Agent-step preparation; absent for unsent auxiliary drafts. */
  readonly turn?: number
  /** Owning host step for Agent-step preparation; absent for unsent auxiliary drafts. */
  readonly step?: number
  /** Durable composition identity after any blank-session preset switch. */
  readonly agentPreset?: string
  /** Durable coarse origin used by contributors with subagent policy. */
  readonly origin?: SessionOrigin
}

/**
 * One preparation input to every contributor: purpose, user messages, abort signal, cwd, and a
 * detached durable caller identity. Working sets and explicit references arrive inside the
 * messages themselves (file mentions, session references), so request construction stays
 * deterministic without giving providers a live Agent object.
 */
export interface StepContextInput {
  /** The caller's purpose; contributors may decline purposes they do not support. */
  readonly purpose: ContextPurpose
  /** The user messages claimed for this step, in claim order. */
  readonly messages: readonly UserMessage[]
  /** Aborted when the step is cancelled; contributors must pass it through to their reads. */
  readonly signal: AbortSignal
  /** The step's working directory, from the session header; resolves relative message references. */
  readonly cwd: string
  /** Detached durable caller identity and policy metadata. */
  readonly caller: StepContextCaller
}

/**
 * One contributor's result for a step. `message` is model-visible and the contributor owns its
 * source attribution; `evidence` and `coverage` record what the message rests on. ContextEngine
 * detaches, lossless-JSON validates, and freezes the complete result before publication; evidence
 * ids must be non-empty and unique across the complete preparation. Returning `undefined`
 * contributes nothing.
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
 * prepared request, and see the same purpose and messages.
 */
export interface StepContextContributor {
  /** Stable contributor identity; unique within the registry. */
  readonly id: string
  /**
   * Contribute context for one step.
   * @param input - the purpose, messages, abort signal, and cwd for the preparation.
   * @returns the contributed context, or `undefined` when this step needs none.
   */
  contribute(input: StepContextInput): Promise<ContributedStepContext | undefined>
}

/**
 * One attributed contribution in a prepared step. Attribution stays attached to its message,
 * evidence, and coverage so AgentLoop can record which retrieval produced each model-visible
 * message even after the ordinary pre-step waterfall admits, removes, or rewrites messages.
 */
export interface PreparedContextContribution {
  /** Stable id of the contributor that produced this result. */
  readonly contributorId: string
  /** The contributor's proposed model-visible message. */
  readonly message: UserMessage
  /** Evidence records backing this contribution, in provider order. */
  readonly evidence: readonly Evidence[]
  /** What this contributor inspected; absent means coverage was not reported. */
  readonly coverage?: CoverageRecord
}

/**
 * A prepared context request: attributed model-visible messages and the evidence behind them.
 * `undefined` from {@link ContextEngineService.prepareStep} means no contributor produced
 * context this step.
 */
export interface PreparedStepContext {
  /** Attributed results in contributor registration order. */
  readonly contributions: readonly PreparedContextContribution[]
  /** Contributor messages in contributor registration order. */
  readonly messages: readonly UserMessage[]
  /** All evidence records from every contributing contributor, concatenated. */
  readonly evidence: readonly Evidence[]
  /** All reported coverage records in contributor registration order. */
  readonly coverage: readonly CoverageRecord[]
}

/**
 * Durable trace of one contribution prepared for an accepted step. `messageEventSeqs` identifies
 * only exact messages that survived `agent/pre-step` and entered the model-visible session
 * surface; an empty list records that the proposal was removed or rewritten before admission.
 */
export interface ContextPreparedContributionTrace {
  /** Stable id of the contributor that produced the proposal. */
  readonly contributorId: string
  /** Stable identity of the proposed message. */
  readonly messageId: UserMessage['id']
  /** Exact `user/message` event seqs carrying this unmodified proposal. */
  readonly messageEventSeqs: readonly number[]
  /** Evidence records backing the proposal, in provider order. */
  readonly evidence: readonly Evidence[]
  /** What the contributor inspected; absent means coverage was not reported. */
  readonly coverage?: CoverageRecord
}

/**
 * One durable context-preparation fact, appended by AgentLoop after the accepted step's messages
 * and before its model request. Messages remain reconstructable from `user/message`; this record
 * carries attribution, evidence, coverage, and admission links without becoming a second transcript.
 */
export interface ContextPreparedEventData {
  /** Owning turn. */
  readonly turn: number
  /** Owning step. */
  readonly step: number
  /** Prepared contributions in registry order. */
  readonly contributions: readonly ContextPreparedContributionTrace[]
}

declare module '@relay-harness/rlh-session/types' {
  interface SessionEventMap {
    /**
     * Log-only context-preparation trace for one accepted step. AgentLoop appends it after the
     * referenced `user/message` events and before dispatching the model request.
     */
    'context/prepared': ContextPreparedEventData
  }
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
   * Prepare context for one purpose-tagged request.
   * @param input - purpose, messages, abort signal, working directory, and durable caller identity.
   * @returns the collected context, or `undefined` when no contributor produced any.
   */
  prepareStep(input: StepContextInput): Promise<PreparedStepContext | undefined>
}
