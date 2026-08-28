/**
 * Service Definition for the local context engine seam (`ctx.contextEngine`): a step-context
 * contributor registry and one deterministic `prepareStep` pass per claimed agent step.
 *
 * Contributors register with a unique branded-string id and run in registration order; each sees
 * the same claimed user messages and abort signal. The engine concatenates their messages and
 * evidence and returns `undefined` when nothing was contributed, so a step without context
 * contributions is byte-identical to a deployment without the engine.
 * @module @relay-harness/rlh-context-engine
 */

import { Context, Service } from '@relay-harness/cordis'
import { HarnessError } from '@relay-harness/rlh-llm'
import type {
  ContextEngineService,
  PreparedStepContext,
  StepContextContributor,
  StepContextInput,
} from './types.ts'

export { EvidenceId, SourceId } from './brand.ts'
export type {
  ContributedStepContext,
  ContextEngineService,
  CoverageCompleteness,
  CoverageRecord,
  Evidence,
  EvidenceFreshness,
  EvidenceVerification,
  NegativeFinding,
  PreparedStepContext,
  ProviderExplain,
  ProviderGeneration,
  ProviderHealthState,
  ResourceRef,
  StepContextContributor,
  StepContextInput,
} from './types.ts'

declare module '@relay-harness/cordis' {
  interface Context {
    contextEngine: ContextEngineService
  }
}

/**
 * Structured context-engine failure. Extends {@link HarnessError} with a stable `code`
 * (`CONTEXT_ENGINE_INVALID_CONTRIBUTOR`, `CONTEXT_ENGINE_CONFLICT`) that callers route on
 * instead of parsing `message`.
 */
export class ContextEngineError extends HarnessError {}

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
    return () => {
      this.contributors.delete(id)
    }
  }

  async prepareStep(input: StepContextInput): Promise<PreparedStepContext | undefined> {
    // Registration order, awaited sequentially: the packed message order stays deterministic
    // and reproducible across restarts. Parallel fan-out arrives with the retrieval planner.
    const messages = []
    const evidence = []
    for (const contributor of this.contributors.values()) {
      const contributed = await contributor.contribute(input)
      if (contributed === undefined) continue
      messages.push(contributed.message)
      if (contributed.evidence !== undefined) evidence.push(...contributed.evidence)
    }
    if (messages.length === 0) return undefined
    return { messages, evidence }
  }
}

export default ContextEngine
