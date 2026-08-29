/**
 * Service Definition for the local context engine seam (`ctx.contextEngine`): a step-context
 * contributor registry and one deterministic, purpose-tagged `prepareStep` pass per request.
 *
 * Contributors register with a unique branded-string id and run in registration order; each sees
 * the same purpose, user messages, abort signal, and durable caller identity. The engine concatenates their messages,
 * evidence, and coverage and returns `undefined` when nothing was contributed, so a request without context
 * contributions is byte-identical to a deployment without the engine.
 * @module @relay-harness/rlh-context-engine
 */

import { Context, Service } from '@relay-harness/cordis'
import { deepFreeze, HarnessError } from '@relay-harness/rlh-llm'
import { snapshotJsonValue } from '@relay-harness/rlh-session'
import type {
  ContributedStepContext,
  ContextEngineService,
  PreparedStepContext,
  StepContextContributor,
  StepContextInput,
} from './types.ts'

export { EvidenceId, SourceId } from './brand.ts'
export type {
  ContributedStepContext,
  ContextPreparedContributionTrace,
  ContextPreparedEventData,
  ContextPurpose,
  ContextEngineService,
  CoverageCompleteness,
  CoverageRecord,
  Evidence,
  EvidenceFreshness,
  EvidenceVerification,
  NegativeFinding,
  PreparedContextContribution,
  PreparedStepContext,
  ProviderExplain,
  ProviderGeneration,
  ProviderHealthState,
  ResourceRef,
  StepContextContributor,
  StepContextCaller,
  StepContextInput,
} from './types.ts'

declare module '@relay-harness/cordis' {
  interface Context {
    contextEngine: ContextEngineService
  }
}

/**
 * Structured context-engine failure. Extends {@link HarnessError} with a stable `code`
 * (`CONTEXT_ENGINE_INVALID_CONTRIBUTOR`, `CONTEXT_ENGINE_CONFLICT`, or
 * `CONTEXT_ENGINE_INVALID_CONTRIBUTION`) that callers route on instead of parsing `message`.
 */
export class ContextEngineError extends HarnessError {}

/**
 * Detach one provider-owned result at the Context Engine boundary.
 *
 * Contributors are allowed to retain their own objects and may complete on an arbitrary async
 * boundary.  Neither AgentLoop nor Prompt Enhancement may therefore borrow those objects until a
 * later durable append/Remote serialization.  Snapshotting here also makes malformed `domain`
 * payloads fail before any model-visible message can be admitted.
 */
function snapshotContribution(
  contributorId: string,
  contribution: ContributedStepContext,
): ContributedStepContext {
  const snapshot = snapshotJsonValue(contribution)
  if (snapshot === undefined) {
    throw new ContextEngineError(
      `context-engine contributor "${contributorId}" returned a non-JSON-serializable contribution`,
      'CONTEXT_ENGINE_INVALID_CONTRIBUTION',
    )
  }
  return deepFreeze(snapshot)
}

/**
 * `ctx.contextEngine`. Holds the contributor registry; registrations are validated before any
 * mutation, so an invalid or conflicting registration publishes nothing, and its disposer
 * removes exactly its own entry.
 */
export class ContextEngine extends Service implements ContextEngineService {
  private readonly contributors = new Map<string, StepContextContributor>()

  constructor(ctx: Context) {
    super(ctx, 'contextEngine')
  }

  registerContributor(contributor: StepContextContributor): () => void {
    // Validate everything BEFORE any mutation: an invalid or conflicting registration must
    // publish nothing (fail-loud, all-or-nothing).
    const id = contributor.id
    if (id.trim() === '') {
      throw new ContextEngineError(
        'a context-engine contributor id must be a non-empty string',
        'CONTEXT_ENGINE_INVALID_CONTRIBUTOR',
      )
    }
    if (this.contributors.has(id)) {
      throw new ContextEngineError(
        `a context-engine contributor with id "${id}" is already registered`,
        'CONTEXT_ENGINE_CONFLICT',
      )
    }
    this.contributors.set(id, contributor)
    let active = true
    return () => {
      if (!active) return
      active = false
      // The id may have been freed and re-used after this generation was
      // disposed. A stale/double disposer must never delete that successor.
      if (this.contributors.get(id) === contributor) this.contributors.delete(id)
    }
  }

  async prepareStep(input: StepContextInput): Promise<PreparedStepContext | undefined> {
    // Registration order, awaited sequentially: the packed message order stays deterministic
    // and reproducible across restarts. Parallel fan-out arrives with the retrieval planner.
    const contributions = []
    const messages = []
    const evidence = []
    const coverage = []
    const evidenceIds = new Set<string>()
    for (const contributor of this.contributors.values()) {
      input.signal.throwIfAborted()
      const returned = await contributor.contribute(input)
      input.signal.throwIfAborted()
      if (returned === undefined) continue
      const contributed = snapshotContribution(contributor.id, returned)
      for (const item of contributed.evidence ?? []) {
        if (item.evidenceId.trim() === '' || evidenceIds.has(item.evidenceId)) {
          throw new ContextEngineError(
            `context-engine contributor "${contributor.id}" returned duplicate or empty evidence id "${item.evidenceId}"`,
            'CONTEXT_ENGINE_INVALID_CONTRIBUTION',
          )
        }
        evidenceIds.add(item.evidenceId)
      }
      const contribution = {
        contributorId: contributor.id,
        message: contributed.message,
        evidence: contributed.evidence ?? [],
        ...contributed.coverage === undefined ? {} : { coverage: contributed.coverage },
      }
      contributions.push(contribution)
      messages.push(contributed.message)
      if (contributed.evidence !== undefined) evidence.push(...contributed.evidence)
      if (contributed.coverage !== undefined) coverage.push(contributed.coverage)
    }
    input.signal.throwIfAborted()
    if (messages.length === 0) return undefined
    return deepFreeze({ contributions, messages, evidence, coverage })
  }
}

export default ContextEngine
