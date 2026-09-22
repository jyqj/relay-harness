/**
 * Service Definition and deterministic control plane for the local context engine seam
 * (`ctx.contextEngine`): purpose-aware retrieval planning, provider deadlines, and packing.
 *
 * Contributors register with a unique id and retain provider-local retrieval. The engine assigns
 * local budgets, isolates cancellation, prioritizes explicit references, suppresses duplicates,
 * and returns an immutable selected/rejected trace beside admitted evidence.
 * @module @relay-harness/rlh-context-engine
 */

import { Context, Service } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import { deepFreeze, HarnessError } from '@relay-harness/rlh-llm'
import { snapshotJsonValue } from '@relay-harness/rlh-session'
import type {
  ContributedStepContext,
  ContextContributionBatch,
  ContextContributorDescription,
  ContextRetrievalInput,
  ContextCandidateDecision,
  ContextCandidateSelection,
  ContextPrepareInput,
  ContextRetrievalPlan,
  ContributorContextBudget,
  ContextEngineService,
  PreparedContextContribution,
  PreparedStepContext,
  StepContextContributor,
} from './types.ts'

import { measureContextMessage } from './budget.ts'
export { contextMessageFits, fitContextContribution, measureContextMessage } from './budget.ts'

export { EvidenceId, SourceId } from './brand.ts'
export type {
  ContributedStepContext,
  ContextContributionBatch,
  ContextContributorDescription,
  ContextRetrievalInput,
  ContextBudget,
  ContextCandidateDecision,
  ContextCandidateSelection,
  ContextPrepareInput,
  ContextPreparedContributionTrace,
  ContextPreparedEventData,
  ContextPurpose,
  ContextRetrievalPlan,
  ContextRetrievalPlanEntry,
  ContextSelectionPriority,
  ContributorContextBudget,
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
 * (`CONTEXT_ENGINE_INVALID_CONFIG`, `CONTEXT_ENGINE_INVALID_CONTRIBUTOR`, `CONTEXT_ENGINE_CONFLICT`, or
 * `CONTEXT_ENGINE_INVALID_CONTRIBUTION`) that callers route on instead of parsing `message`.
 */
export class ContextEngineError extends HarnessError {}

/** Provider-owned non-evidence outcome; only stable classifications enter the preparation trace. */
export class ContextProviderError extends Error {
  /**
   * Classify a provider outcome without retaining its raw query or exception.
   * @param outcome - whether retrieval declined, degraded, or failed.
   * @param reason - stable provider-stage classification.
   */
  constructor(
    readonly outcome: 'declined' | 'degraded' | 'error',
    readonly reason: 'search_failed' | 'search_degraded'
      | 'hydration_failed' | 'hydration_unavailable' | 'budget_exhausted',
  ) {
    super(`context provider ${outcome}: ${reason}`)
  }
}

/** Default complete preparation wall-clock allowance. */
export const DEFAULT_PREPARE_TIMEOUT_MS = 5_000
/** Default maximum number of concurrent provider reads in one preparation. */
export const DEFAULT_MAX_CONCURRENT_CONTRIBUTORS = 4

/** Default complete model-visible context allowance per preparation. */
export const DEFAULT_MAX_CONTEXT_CHARS = 64_000
/** Default estimated-token allowance per preparation. */
export const DEFAULT_MAX_CONTEXT_TOKENS = 16_000
/** Default character allowance exposed to each provider. */
export const DEFAULT_MAX_CONTRIBUTOR_CHARS = 64_000
/** Default estimated-token allowance exposed to each provider. */
export const DEFAULT_MAX_CONTRIBUTOR_TOKENS = 16_000
/** Default wall-clock allowance for one provider read. */
export const DEFAULT_CONTRIBUTOR_TIMEOUT_MS = 5_000
/** Largest timeout representable without Node timer overflow. */
export const MAX_CONTRIBUTOR_TIMEOUT_MS = 2_147_483_647

/** Loader policy for deterministic retrieval planning and packing. */
export interface Config {
  /** Complete Unicode-code-point allowance across selected context messages. */
  readonly maxChars?: number
  /** Complete estimated-token allowance across selected context messages. */
  readonly maxTokens?: number
  /** Maximum Unicode-code-point allowance assigned to one provider. */
  readonly maxContributorChars?: number
  /** Maximum estimated-token allowance assigned to one provider. */
  readonly maxContributorTokens?: number
  /** Wall-clock allowance for one provider before its late result is ignored. */
  readonly contributorTimeoutMs?: number
  /** Complete preparation allowance, including time waiting for a provider slot. */
  readonly prepareTimeoutMs?: number
  /** Maximum concurrent provider reads in one preparation. */
  readonly maxConcurrentContributors?: number
}

interface ResolvedConfig {
  readonly maxChars: number
  readonly maxTokens: number
  readonly maxContributorChars: number
  readonly maxContributorTokens: number
  readonly contributorTimeoutMs: number
  readonly prepareTimeoutMs: number
  readonly maxConcurrentContributors: number
}

interface Registration {
  readonly contributor: StepContextContributor
  readonly generation: number
  readonly controller: AbortController
}

interface Candidate {
  readonly registration: Registration
  readonly registrationOrder: number
  readonly candidateOrder: number
  readonly contributed: ContributedStepContext
  readonly selection: ContextCandidateSelection
  readonly chars: number
  readonly tokens: number
  readonly dedupeKey: string
}

type ContributorRun =
  | { readonly kind: 'returned'; readonly value: ContextContributionBatch | undefined }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'disposed' }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'unavailable'; readonly reasons: readonly string[] }

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
  contribution: ContextContributionBatch,
): ContextContributionBatch {
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
  static Config: z<Config> = z.object({
    maxChars: z.natural().min(1).default(DEFAULT_MAX_CONTEXT_CHARS),
    maxTokens: z.natural().min(1).default(DEFAULT_MAX_CONTEXT_TOKENS),
    maxContributorChars: z.natural().min(1).default(DEFAULT_MAX_CONTRIBUTOR_CHARS),
    maxContributorTokens: z.natural().min(1).default(DEFAULT_MAX_CONTRIBUTOR_TOKENS),
    contributorTimeoutMs: z.natural().min(1).max(MAX_CONTRIBUTOR_TIMEOUT_MS)
      .default(DEFAULT_CONTRIBUTOR_TIMEOUT_MS),
    prepareTimeoutMs: z.natural().min(1).max(MAX_CONTRIBUTOR_TIMEOUT_MS).default(DEFAULT_PREPARE_TIMEOUT_MS),
    maxConcurrentContributors: z.natural().min(1).default(DEFAULT_MAX_CONCURRENT_CONTRIBUTORS),
  })

  private readonly contributors = new Map<string, Registration>()
  private readonly config: ResolvedConfig
  private nextGeneration = 1
  private readonly lifetime = new AbortController()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'contextEngine')
    this.config = {
      maxChars: config.maxChars ?? DEFAULT_MAX_CONTEXT_CHARS,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
      maxContributorChars: config.maxContributorChars ?? DEFAULT_MAX_CONTRIBUTOR_CHARS,
      maxContributorTokens: config.maxContributorTokens ?? DEFAULT_MAX_CONTRIBUTOR_TOKENS,
      contributorTimeoutMs: config.contributorTimeoutMs ?? DEFAULT_CONTRIBUTOR_TIMEOUT_MS,
      prepareTimeoutMs: config.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS,
      maxConcurrentContributors: config.maxConcurrentContributors ?? DEFAULT_MAX_CONCURRENT_CONTRIBUTORS,
    }
    validateConfig(this.config)
    ctx.effect(() => () => { this.lifetime.abort(new Error('context engine disposed')) })
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
    const registration: Registration = { contributor, generation: this.nextGeneration, controller: new AbortController() }
    this.nextGeneration += 1
    this.contributors.set(id, registration)
    let active = true
    return () => {
      if (!active) return
      active = false
      registration.controller.abort()
      // The id may have been freed and re-used after this generation was
      // disposed. A stale/double disposer must never delete that successor.
      if (this.contributors.get(id) === registration) this.contributors.delete(id)
    }
  }

  describeContributors(): readonly ContextContributorDescription[] {
    return deepFreeze([...this.contributors.values()].map(({ contributor }) => ({
      id: contributor.id,
      purposes: [...(contributor.purposes ?? ['agent_step', 'prompt_enhancement'])],
    })))
  }

  async retrieve(input: ContextRetrievalInput): Promise<PreparedStepContext> {
    const query = input.query.trim()
    if (query === '') throw new ContextEngineError('context retrieval query must not be empty', 'CONTEXT_ENGINE_INVALID_REQUEST')
    for (const id of input.contributors ?? []) {
      if (!this.contributors.has(id)) {
        throw new ContextEngineError(`unknown context source: ${id}`, 'CONTEXT_ENGINE_UNKNOWN_SOURCE')
      }
    }
    if (input.budget !== undefined) validateConfigValues(input.budget)
    return this.prepare({ ...input, purpose: 'tool_retrieval', messages: [] }, input)
  }

  async prepareStep(input: ContextPrepareInput): Promise<PreparedStepContext | undefined> {
    const prepared = await this.prepare(input)
    return prepared.contributions.length === 0
      && prepared.decisions.every(decision => decision.reasons.length === 1 && decision.reasons[0] === 'declined')
      ? undefined : prepared
  }

  private async prepare(input: ContextPrepareInput, retrieval?: ContextRetrievalInput): Promise<PreparedStepContext> {
    input.signal.throwIfAborted()
    if (input.limits !== undefined) validateConfigValues(input.limits)
    const registrations = [...this.contributors.values()]
    const plan = this.plan(input, registrations, retrieval)
    const candidates: Candidate[] = []
    const decisions: ContextCandidateDecision[] = []
    const operation = new AbortController()
    const signal = AbortSignal.any([input.signal, this.lifetime.signal])
    signal.throwIfAborted()
    const deadlineAt = Math.min(Date.now() + this.config.prepareTimeoutMs, input.deadlineAt ?? Number.POSITIVE_INFINITY)
    const timer = setTimeout(() => { operation.abort() }, Math.max(0, deadlineAt - Date.now()))
    const runs = new Map<number, ContributorRun>()
    const pending = registrations.entries()
    const worker = async () => {
      while (true) {
        signal.throwIfAborted()
        const item = pending.next()
        if (item.done) return
        const [order, registration] = item.value
        const entry = plan.contributors[order]
        if (entry?.eligible !== true || entry.budget === undefined) continue
        runs.set(order, operation.signal.aborted || Date.now() >= deadlineAt
          ? { kind: 'deadline' }
          : await this.runContributor(
            registration,
            { ...input, signal, ...(retrieval === undefined ? {} : { query: retrieval.query.trim() }) },
            entry.budget, operation.signal, deadlineAt,
          ))
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(registrations.length, this.config.maxConcurrentContributors) }, worker))
    } finally {
      clearTimeout(timer)
      operation.abort()
    }
    signal.throwIfAborted()
    for (const [registrationOrder, registration] of registrations.entries()) {
      const contributor = registration.contributor
      const completed = runs.get(registrationOrder)
      if (completed === undefined) continue
      const run: ContributorRun = registration.controller.signal.aborted
        ? { kind: 'disposed' } : completed
      if (run.kind !== 'returned') {
        decisions.push({ contributorId: contributor.id, outcome: 'rejected', reasons:
          run.kind === 'unavailable' ? run.reasons : [run.kind] })
        continue
      }
      const returned = run.value
      if (returned === undefined) {
        decisions.push({ contributorId: contributor.id, outcome: 'rejected', reasons: ['declined'] })
        continue
      }
      const batch = contributionItems(returned)
      if (batch.length === 0) {
        decisions.push({ contributorId: contributor.id, outcome: 'rejected', reasons: ['declined'] })
      }
      const messageIds = new Set<string>()
      for (const [candidateOrder, contributed] of batch.entries()) {
        if (messageIds.has(contributed.message.id)) {
          throw new ContextEngineError('a provider repeated a candidate message id', 'CONTEXT_ENGINE_INVALID_CONTRIBUTION')
        }
        messageIds.add(contributed.message.id)
        const contributorEvidenceIds = new Set<string>()
        for (const item of contributed.evidence ?? []) {
          if (item.evidenceId.trim() === '' || contributorEvidenceIds.has(item.evidenceId)) {
            throw new ContextEngineError(
              `context-engine contributor "${contributor.id}" returned duplicate or empty evidence id "${item.evidenceId}"`,
              'CONTEXT_ENGINE_INVALID_CONTRIBUTION',
            )
          }
          contributorEvidenceIds.add(item.evidenceId)
        }
        const selection: ContextCandidateSelection = contributed.selection ?? {
          priority: 'provider', reasons: ['provider_candidate'],
        }
        if (selection.rank !== undefined && (!Number.isSafeInteger(selection.rank) || selection.rank < 0)) {
          throw new ContextEngineError('candidate rank must be a non-negative safe integer', 'CONTEXT_ENGINE_INVALID_CONTRIBUTION')
        }
        const { chars, tokens } = measureContextMessage(this.ctx, contributed.message)
        candidates.push({
          registration, registrationOrder, candidateOrder, contributed, selection, chars, tokens,
          dedupeKey: selection.dedupeKey ?? JSON.stringify([contributor.id, contributed.message.source, contributed.message.content]),
        })
      }
    }
    input.signal.throwIfAborted()
    const packed = packCandidates(candidates, plan, decisions)
    validateSelectedEvidenceIds(packed.contributions)
    return deepFreeze({ plan, decisions, ...packed })
  }

  private plan(
    input: ContextPrepareInput, registrations: readonly Registration[], retrieval?: ContextRetrievalInput,
  ): ContextRetrievalPlan {
    const purpose = input.purpose
    const totalBudget = {
      maxChars: Math.min(
        this.config.maxChars, input.limits?.maxChars ?? this.config.maxChars, retrieval?.budget?.maxChars ?? this.config.maxChars,
      ),
      maxTokens: Math.min(
        this.config.maxTokens, input.limits?.maxTokens ?? this.config.maxTokens, retrieval?.budget?.maxTokens ?? this.config.maxTokens,
      ),
    }
    const localBudget = {
      maxChars: Math.min(this.config.maxContributorChars, totalBudget.maxChars),
      maxTokens: Math.min(this.config.maxContributorTokens, totalBudget.maxTokens),
      timeoutMs: this.config.contributorTimeoutMs,
    }
    return deepFreeze({
      purpose,
      budget: totalBudget,
      contributors: registrations.map(({ contributor }) => {
        const requested = retrieval?.contributors === undefined || retrieval.contributors.includes(contributor.id)
        const supported = contributor.purposes?.includes(purpose) ?? purpose !== 'tool_retrieval'
        const eligible = requested && supported
        return {
          contributorId: contributor.id,
          eligible,
          reason: !requested ? 'not_requested' as const : supported ? 'purpose_supported' as const : 'purpose_not_supported' as const,
          ...eligible ? { budget: localBudget } : {},
        }
      }),
    })
  }

  /** Bound one provider generation to the preparation, parent, registration, and local timeout. */
  private async runContributor(
    registration: Registration,
    input: ContextPrepareInput & { readonly query?: string },
    budget: Omit<ContributorContextBudget, 'deadlineAt'>,
    preparationSignal: AbortSignal,
    preparationDeadlineAt: number,
  ): Promise<ContributorRun> {
    const controller = new AbortController()
    const signal = AbortSignal.any([input.signal, preparationSignal, registration.controller.signal, controller.signal])
    const deadlineAt = Math.min(Date.now() + budget.timeoutMs, preparationDeadlineAt)
    const abortResult = (): ContributorRun => registration.controller.signal.aborted
      ? { kind: 'disposed' }
      : preparationSignal.aborted ? { kind: 'deadline' } : { kind: 'timeout' }
    input.signal.throwIfAborted()
    if (registration.controller.signal.aborted || preparationSignal.aborted) return abortResult()
    let settleAbort!: (result: ContributorRun) => void
    const aborted = new Promise<ContributorRun>((resolve) => { settleAbort = resolve })
    const onAbort = () => { settleAbort(abortResult()) }
    signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { controller.abort() }, budget.timeoutMs)
    const work = Promise.resolve().then(() => {
      signal.throwIfAborted()
      return registration.contributor.contribute({
        ...input, signal,
        budget: { ...budget, timeoutMs: Math.max(0, deadlineAt - Date.now()), deadlineAt },
      })
    }).then(
      value => ({ kind: 'returned' as const, value }),
      (error: unknown) => ({ kind: 'error' as const, error }),
    )
    try {
      const result = await Promise.race([work, aborted])
      input.signal.throwIfAborted()
      if (signal.aborted) return abortResult()
      if (Date.now() >= preparationDeadlineAt) return { kind: 'deadline' }
      if (Date.now() >= deadlineAt) return { kind: 'timeout' }
      if (result.kind === 'error') {
        if (result.error instanceof ContextEngineError) throw result.error
        return { kind: 'unavailable', reasons: result.error instanceof ContextProviderError
          ? [result.error.outcome, result.error.reason] : ['error', 'provider_failed'] }
      }
      return result.kind === 'returned' && result.value !== undefined
        ? { kind: 'returned', value: snapshotContribution(registration.contributor.id, result.value) }
        : result
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      controller.abort()
    }
  }
}

/** Evidence identity is global only across candidates that survive duplicate/budget packing. */
function validateSelectedEvidenceIds(contributions: readonly PreparedContextContribution[]): void {
  const evidenceIds = new Set<string>()
  for (const contribution of contributions) {
    for (const evidence of contribution.evidence) {
      if (evidenceIds.has(evidence.evidenceId)) {
        throw new ContextEngineError(
          `context-engine selected duplicate evidence id "${evidence.evidenceId}"`,
          'CONTEXT_ENGINE_INVALID_CONTRIBUTION',
        )
      }
      evidenceIds.add(evidence.evidenceId)
    }
  }
}

/** Deterministically pack whole provider messages, preferring direct user references. */
function packCandidates(
  candidates: readonly Candidate[],
  plan: ContextRetrievalPlan,
  decisions: ContextCandidateDecision[],
): Pick<PreparedStepContext, 'contributions' | 'messages' | 'evidence' | 'coverage'> {
  const ranked = [...candidates].sort((left, right) =>
    priorityRank(left.selection.priority) - priorityRank(right.selection.priority)
    || (left.selection.rank ?? left.candidateOrder) - (right.selection.rank ?? right.candidateOrder)
    || compareSourceIds(left.registration.contributor.id, right.registration.contributor.id)
    || left.candidateOrder - right.candidateOrder)
  const spent = new Map<string, { chars: number; tokens: number }>()
  const selected: Candidate[] = []
  const dedupeKeys = new Set<string>()
  let chars = 0
  let tokens = 0
  for (const candidate of ranked) {
    const local = plan.contributors[candidate.registrationOrder]?.budget
    const previous = spent.get(candidate.registration.contributor.id) ?? { chars: 0, tokens: 0 }
    let reason: string | undefined
    if (local !== undefined && previous.chars + candidate.chars > local.maxChars) reason = 'contributor_char_budget'
    else if (local !== undefined && previous.tokens + candidate.tokens > local.maxTokens) reason = 'contributor_token_budget'
    else if (dedupeKeys.has(candidate.dedupeKey)) reason = 'duplicate'
    else if (chars + candidate.chars > plan.budget.maxChars) reason = 'total_char_budget'
    else if (tokens + candidate.tokens > plan.budget.maxTokens) reason = 'total_token_budget'
    if (reason !== undefined) {
      decisions.push(candidateDecision(candidate, 'rejected', [reason]))
      continue
    }
    selected.push(candidate)
    spent.set(candidate.registration.contributor.id, {
      chars: previous.chars + candidate.chars, tokens: previous.tokens + candidate.tokens,
    })
    dedupeKeys.add(candidate.dedupeKey)
    chars += candidate.chars
    tokens += candidate.tokens
    decisions.push(candidateDecision(candidate, 'selected', [
      ...candidate.selection.reasons,
      candidate.selection.priority === 'explicit-reference' ? 'explicit_reference_priority' : 'source_rank',
      'within_budget',
    ]))
  }
  const contributions: PreparedContextContribution[] = selected
    .sort((left, right) => left.registrationOrder - right.registrationOrder)
    .map(candidate => ({
      contributorId: candidate.registration.contributor.id,
      message: candidate.contributed.message,
      evidence: candidate.contributed.evidence ?? [],
      ...candidate.contributed.coverage === undefined ? {} : { coverage: candidate.contributed.coverage },
    }))
  return {
    contributions,
    messages: contributions.map(contribution => contribution.message),
    evidence: contributions.flatMap(contribution => contribution.evidence),
    coverage: candidates.flatMap(candidate => candidate.contributed.coverage === undefined ? [] : [candidate.contributed.coverage]),
  }
}

function candidateDecision(
  candidate: Candidate,
  outcome: ContextCandidateDecision['outcome'],
  reasons: readonly string[],
): ContextCandidateDecision {
  return {
    contributorId: candidate.registration.contributor.id,
    messageId: candidate.contributed.message.id,
    outcome,
    reasons,
    priority: candidate.selection.priority,
    chars: candidate.chars,
    tokens: candidate.tokens,
  }
}

function priorityRank(priority: ContextCandidateSelection['priority']): number {
  return priority === 'explicit-reference' ? 0 : 1
}

function validateConfigValues(config: object): void {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ContextEngineError(
        `context-engine ${name} must be a positive safe integer`,
        'CONTEXT_ENGINE_INVALID_CONFIG',
      )
    }
  }
}

function validateConfig(config: ResolvedConfig): void {
  validateConfigValues(config)
  if (config.contributorTimeoutMs > MAX_CONTRIBUTOR_TIMEOUT_MS || config.prepareTimeoutMs > MAX_CONTRIBUTOR_TIMEOUT_MS) {
    throw new ContextEngineError(
      `context-engine timeouts must not exceed ${MAX_CONTRIBUTOR_TIMEOUT_MS}`,
      'CONTEXT_ENGINE_INVALID_CONFIG',
    )
  }
}

function contributionItems(batch: ContextContributionBatch): readonly ContributedStepContext[] {
  return 'message' in batch ? [batch] : batch
}

function compareSourceIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

export default ContextEngine
