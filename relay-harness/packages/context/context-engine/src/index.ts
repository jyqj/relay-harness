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
import type { ContentBlock, UserMessage } from '@relay-harness/rlh-llm'
import { snapshotJsonValue } from '@relay-harness/rlh-session'
import type {
  ContributedStepContext,
  ContextCandidateDecision,
  ContextCandidateSelection,
  ContextPrepareInput,
  ContextPurpose,
  ContextRetrievalPlan,
  ContributorContextBudget,
  ContextEngineService,
  PreparedContextContribution,
  PreparedStepContext,
  StepContextContributor,
} from './types.ts'

export { EvidenceId, SourceId } from './brand.ts'
export type {
  ContributedStepContext,
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
}

interface ResolvedConfig {
  readonly maxChars: number
  readonly maxTokens: number
  readonly maxContributorChars: number
  readonly maxContributorTokens: number
  readonly contributorTimeoutMs: number
}

interface Registration {
  readonly contributor: StepContextContributor
  readonly generation: number
}

interface Candidate {
  readonly registration: Registration
  readonly registrationOrder: number
  readonly contributed: ContributedStepContext
  readonly selection: ContextCandidateSelection
  readonly chars: number
  readonly tokens: number
  readonly dedupeKey: string
}

type ContributorRun =
  | { readonly kind: 'returned'; readonly value: ContributedStepContext | undefined }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'disposed' }

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
  static Config: z<Config> = z.object({
    maxChars: z.natural().min(1).default(DEFAULT_MAX_CONTEXT_CHARS),
    maxTokens: z.natural().min(1).default(DEFAULT_MAX_CONTEXT_TOKENS),
    maxContributorChars: z.natural().min(1).default(DEFAULT_MAX_CONTRIBUTOR_CHARS),
    maxContributorTokens: z.natural().min(1).default(DEFAULT_MAX_CONTRIBUTOR_TOKENS),
    contributorTimeoutMs: z.natural().min(1).max(MAX_CONTRIBUTOR_TIMEOUT_MS)
      .default(DEFAULT_CONTRIBUTOR_TIMEOUT_MS),
  })

  private readonly contributors = new Map<string, Registration>()
  private readonly config: ResolvedConfig
  private nextGeneration = 1

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'contextEngine')
    this.config = {
      maxChars: config.maxChars ?? DEFAULT_MAX_CONTEXT_CHARS,
      maxTokens: config.maxTokens ?? DEFAULT_MAX_CONTEXT_TOKENS,
      maxContributorChars: config.maxContributorChars ?? DEFAULT_MAX_CONTRIBUTOR_CHARS,
      maxContributorTokens: config.maxContributorTokens ?? DEFAULT_MAX_CONTRIBUTOR_TOKENS,
      contributorTimeoutMs: config.contributorTimeoutMs ?? DEFAULT_CONTRIBUTOR_TIMEOUT_MS,
    }
    validateConfig(this.config)
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
    const registration: Registration = { contributor, generation: this.nextGeneration }
    this.nextGeneration += 1
    this.contributors.set(id, registration)
    let active = true
    return () => {
      if (!active) return
      active = false
      // The id may have been freed and re-used after this generation was
      // disposed. A stale/double disposer must never delete that successor.
      if (this.contributors.get(id) === registration) this.contributors.delete(id)
    }
  }

  async prepareStep(input: ContextPrepareInput): Promise<PreparedStepContext | undefined> {
    input.signal.throwIfAborted()
    const registrations = [...this.contributors.values()]
    const plan = this.plan(input.purpose, registrations)
    const candidates: Candidate[] = []
    const decisions: ContextCandidateDecision[] = []
    for (const [registrationOrder, registration] of registrations.entries()) {
      const contributor = registration.contributor
      const planEntry = plan.contributors[registrationOrder]
      if (planEntry?.eligible !== true || planEntry.budget === undefined) continue
      input.signal.throwIfAborted()
      const run = await this.runContributor(registration, input, planEntry.budget)
      input.signal.throwIfAborted()
      if (run.kind !== 'returned') {
        decisions.push({ contributorId: contributor.id, outcome: 'rejected', reasons: [run.kind] })
        continue
      }
      const returned = run.value
      if (returned === undefined) {
        decisions.push({ contributorId: contributor.id, outcome: 'rejected', reasons: ['declined'] })
        continue
      }
      const contributed = snapshotContribution(contributor.id, returned)
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
      const chars = messageChars(contributed.message)
      const tokens = estimateMessageTokens(this.ctx, contributed.message, chars)
      candidates.push({
        registration,
        registrationOrder,
        contributed,
        selection,
        chars,
        tokens,
        dedupeKey: selection.dedupeKey ?? JSON.stringify(contributed.message.content),
      })
    }
    input.signal.throwIfAborted()
    const packed = packCandidates(candidates, plan, decisions)
    validateSelectedEvidenceIds(packed.contributions)
    if (packed.contributions.length === 0 && decisions.every(decision => decision.reasons[0] === 'declined')) {
      return undefined
    }
    return deepFreeze({ plan, decisions, ...packed })
  }

  private plan(purpose: ContextPurpose, registrations: readonly Registration[]): ContextRetrievalPlan {
    const totalBudget = { maxChars: this.config.maxChars, maxTokens: this.config.maxTokens }
    const localBudget = {
      maxChars: Math.min(this.config.maxContributorChars, totalBudget.maxChars),
      maxTokens: Math.min(this.config.maxContributorTokens, totalBudget.maxTokens),
      timeoutMs: this.config.contributorTimeoutMs,
    }
    return deepFreeze({
      purpose,
      budget: totalBudget,
      contributors: registrations.map(({ contributor }) => {
        const eligible = contributor.purposes === undefined || contributor.purposes.includes(purpose)
        return {
          contributorId: contributor.id,
          eligible,
          reason: eligible ? 'purpose_supported' as const : 'purpose_not_supported' as const,
          ...eligible ? { budget: localBudget } : {},
        }
      }),
    })
  }

  /** Bound one provider generation to a child signal and ignore timeout/disposal-late results. */
  private async runContributor(
    registration: Registration,
    input: ContextPrepareInput,
    budget: Omit<ContributorContextBudget, 'deadlineAt'>,
  ): Promise<ContributorRun> {
    const controller = new AbortController()
    let settleStepAbort: ((value: { readonly kind: 'step-aborted' }) => void) | undefined
    const stepAbort = new Promise<{ readonly kind: 'step-aborted' }>((resolve) => {
      settleStepAbort = resolve
    })
    const abortFromStep = () => {
      controller.abort(input.signal.reason)
      settleStepAbort?.({ kind: 'step-aborted' })
    }
    if (input.signal.aborted) abortFromStep()
    else input.signal.addEventListener('abort', abortFromStep, { once: true })
    const deadlineAt = Date.now() + budget.timeoutMs
    const work = Promise.resolve()
      .then(() => {
        controller.signal.throwIfAborted()
        return registration.contributor.contribute({
          ...input,
          signal: controller.signal,
          budget: { ...budget, deadlineAt },
        })
      })
      .then(
        value => ({ kind: 'returned' as const, value }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      )
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<{ readonly kind: 'timeout' }>((resolve) => {
      timer = setTimeout(() => {
        resolve({ kind: 'timeout' })
        controller.abort(new Error(
          `context-engine contributor "${registration.contributor.id}" exceeded ${budget.timeoutMs}ms`,
        ))
      }, budget.timeoutMs)
    })
    try {
      const result = await Promise.race([work, timeout, stepAbort])
      input.signal.throwIfAborted()
      if (result.kind === 'timeout') return result
      if (result.kind === 'error') throw result.error
      if (result.kind === 'step-aborted') {
        input.signal.throwIfAborted()
        throw new Error('unreachable context-engine abort state')
      }
      if (this.contributors.get(registration.contributor.id) !== registration) {
        return { kind: 'disposed' }
      }
      return result
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      input.signal.removeEventListener('abort', abortFromStep)
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
    || left.registrationOrder - right.registrationOrder)
  const selected: Candidate[] = []
  const dedupeKeys = new Set<string>()
  let chars = 0
  let tokens = 0
  for (const candidate of ranked) {
    const local = plan.contributors[candidate.registrationOrder]?.budget
    let reason: string | undefined
    if (local !== undefined && candidate.chars > local.maxChars) reason = 'contributor_char_budget'
    else if (local !== undefined && candidate.tokens > local.maxTokens) reason = 'contributor_token_budget'
    else if (dedupeKeys.has(candidate.dedupeKey)) reason = 'duplicate'
    else if (chars + candidate.chars > plan.budget.maxChars) reason = 'total_char_budget'
    else if (tokens + candidate.tokens > plan.budget.maxTokens) reason = 'total_token_budget'
    if (reason !== undefined) {
      decisions.push(candidateDecision(candidate, 'rejected', [reason]))
      continue
    }
    selected.push(candidate)
    dedupeKeys.add(candidate.dedupeKey)
    chars += candidate.chars
    tokens += candidate.tokens
    decisions.push(candidateDecision(candidate, 'selected', [
      ...candidate.selection.reasons,
      candidate.selection.priority === 'explicit-reference' ? 'explicit_reference_priority' : 'registration_order',
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
    coverage: contributions.flatMap(contribution => contribution.coverage === undefined ? [] : [contribution.coverage]),
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

function messageChars(message: UserMessage): number {
  return contentChars(message.content)
}

function contentChars(content: readonly ContentBlock[]): number {
  let chars = 0
  for (const block of content) {
    if (block.type === 'text' || block.type === 'reasoning') chars += Array.from(block.text).length
    else if (block.type === 'tool-call') chars += Array.from(block.name + block.arguments).length
    else if (block.type === 'tool-result') chars += contentChars(block.content)
    else chars += Array.from(JSON.stringify(block)).length
  }
  return chars
}

function estimateMessageTokens(ctx: Context, message: UserMessage, chars: number): number {
  const meter = ctx.get('tokenMeter') as { estimateMessage(message: UserMessage): number } | undefined
  return meter?.estimateMessage(message) ?? Math.ceil(chars / 4) + 4
}

function validateConfig(config: ResolvedConfig): void {
  for (const [name, value] of Object.entries(config)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ContextEngineError(
        `context-engine ${name} must be a positive safe integer`,
        'CONTEXT_ENGINE_INVALID_CONFIG',
      )
    }
  }
  if (config.contributorTimeoutMs > MAX_CONTRIBUTOR_TIMEOUT_MS) {
    throw new ContextEngineError(
      `context-engine contributorTimeoutMs must not exceed ${MAX_CONTRIBUTOR_TIMEOUT_MS}`,
      'CONTEXT_ENGINE_INVALID_CONFIG',
    )
  }
}

export default ContextEngine
