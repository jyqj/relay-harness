/**
 * Prompt Enhancement service: one context-preparation provider, one enhancement
 * provider, failure-preserving dispatch, and the generated Remote face.
 *
 * @module @relay-harness/rlh-prompt-enhancement
 */

import { Buffer } from 'node:buffer'
import type { Context } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import type { Agent } from '@relay-harness/rlh-agent'
import { deepFreeze, freezeMessage } from '@relay-harness/rlh-llm'
import type { UserMessage } from '@relay-harness/rlh-llm'
import { snapshotJsonValue } from '@relay-harness/rlh-session'
import type { JsonValue } from '@relay-harness/rlh-session/types'
import { Remote, TypertRemoteService } from '@relay-harness/rlh-typert-protocol'
import type {
  PromptEnhancementFailure,
  PromptEnhancementModelProvenance,
  PromptEnhancementOutcome,
} from './types.ts'

export type {
  PromptEnhancementFailure,
  PromptEnhancementModelProvenance,
  PromptEnhancementOutcome,
  PromptEnhancementResult,
} from './types.ts'

declare module '@relay-harness/cordis' {
  interface Context {
    promptEnhancement: PromptEnhancementService
  }
}

/** Stable Context Engine request classification used by the adapter provider. */
export const PROMPT_ENHANCEMENT_CONTEXT_PURPOSE = 'prompt_enhancement' as const

/** Default pre-context UTF-8 draft admission cap (64 KiB). */
export const DEFAULT_MAX_DRAFT_BYTES = 64 * 1024
/** Default detached provider-result wire cap (1 MiB). */
export const DEFAULT_MAX_RESULT_BYTES = 1024 * 1024

/** Service-owned Remote admission and result bounds. */
export interface Config {
  /** Maximum UTF-8 bytes accepted for one unsent draft before context retrieval. */
  readonly maxDraftBytes?: number
  /** Maximum UTF-8 bytes accepted from one detached provider result. */
  readonly maxResultBytes?: number
}

/** Loader schema for the service-owned wire bounds. */
export const Config: z<Config> = z.object({
  maxDraftBytes: z.number().step(1).min(1).default(DEFAULT_MAX_DRAFT_BYTES),
  maxResultBytes: z.number().step(1).min(1).default(DEFAULT_MAX_RESULT_BYTES),
})

/** Explicitly client-safe capability failure. Arbitrary provider errors are never exposed. */
export class PromptEnhancementError extends Error {
  constructor(message: string, readonly code: string) {
    super(message)
    this.name = 'PromptEnhancementError'
  }
}

/** Input to the sole Context Engine adapter registered with this service. */
export interface PromptEnhancementContextRequest {
  /** Fixed Context Engine purpose; adapters must not infer it from history. */
  readonly purpose: typeof PROMPT_ENHANCEMENT_CONTEXT_PURPOSE
  /** Live Agent whose scoped Context Engine and workspace state own preparation. */
  readonly agent: Agent
  /** Exact unsent draft. */
  readonly draft: string
  /** Cancellation for the exact attempt. */
  readonly signal: AbortSignal
}

/** Prepared Context Engine projection consumed without local recomposition. */
export interface PreparedPromptEnhancementContext {
  /** Already-selected model-visible context messages in Context Engine order. */
  readonly messages: readonly UserMessage[]
  /** Opaque Context Engine trace; the enhancement service never interprets Evidence. */
  readonly trace?: JsonValue
}

/** Adapter from the shared Context Engine into Prompt Enhancement. */
export interface PromptEnhancementContextProvider {
  /** Stable provider identity used in lifecycle diagnostics. */
  readonly id: string
  /**
   * Prepare context for one draft.
   * @param request - fixed purpose, Agent, exact draft, and cancellation.
   * @returns Context Engine messages plus its optional opaque trace.
   */
  readonly prepare: (request: PromptEnhancementContextRequest) => Promise<PreparedPromptEnhancementContext>
}

/** Immutable input supplied to the sole enhancement provider. */
export interface PromptEnhancementProviderRequest {
  /** Live Agent and durable Session receiving auxiliary request records. */
  readonly agent: Agent
  /** Exact unsent draft. */
  readonly draft: string
  /** Prepared Context Engine projection; no provider may recollect context. */
  readonly context: PreparedPromptEnhancementContext
  /** Cancellation for the exact attempt. */
  readonly signal: AbortSignal
}

/** Structured provider output before service-owned draft preservation. */
export interface PromptEnhancementProviderResult {
  /** Complete proposed replacement. */
  readonly enhancedDraft: string
  /** New assumptions stated by the proposal. */
  readonly assumptions: readonly string[]
  /** Questions retained rather than answered speculatively. */
  readonly openQuestions: readonly string[]
  /** Exact auxiliary model route used. */
  readonly model: PromptEnhancementModelProvenance
}

/** Replaceable Prompt Enhancement implementation. */
export interface PromptEnhancementProvider {
  /** Stable provider identity used in lifecycle diagnostics. */
  readonly id: string
  /**
   * Produce one structured proposal without modifying the Agent or draft.
   * @param request - exact draft, shared prepared context, Agent, and cancellation.
   * @returns proposed replacement, assumptions, questions, and model route.
   */
  readonly enhance: (request: PromptEnhancementProviderRequest) => Promise<PromptEnhancementProviderResult>
}

interface Registration<T extends { readonly id: string }> {
  readonly implementation: T
  readonly controller: AbortController
  readonly active: Set<Promise<unknown>>
}

/** Normalize one exception into client-safe provider-neutral facts. */
function failureOf(error: unknown): PromptEnhancementFailure {
  if (error instanceof PromptEnhancementError) {
    return { code: error.code, message: error.message }
  }
  return {
    code: 'PROMPT_ENHANCEMENT_FAILED',
    message: 'Prompt Enhancement failed',
  }
}

/** Host Prompt Enhancement runtime and generated Remote namespace owner. */
export class PromptEnhancementService extends TypertRemoteService {
  private readonly lifetime = new AbortController()
  private readonly inFlight = new Set<Promise<unknown>>()
  private provider: Registration<PromptEnhancementProvider> | undefined
  private contextProvider: Registration<PromptEnhancementContextProvider> | undefined

  static Config = Config

  private readonly maxDraftBytes: number
  private readonly maxResultBytes: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'promptEnhancement')
    this.maxDraftBytes = positiveInteger('maxDraftBytes', config.maxDraftBytes ?? DEFAULT_MAX_DRAFT_BYTES)
    this.maxResultBytes = positiveInteger('maxResultBytes', config.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES)
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('prompt-enhancement service disposed'))
      this.provider?.controller.abort(new Error('prompt-enhancement provider disposed with service'))
      this.contextProvider?.controller.abort(new Error('prompt-enhancement context provider disposed with service'))
      await Promise.allSettled([...this.inFlight])
      this.provider = undefined
      this.contextProvider = undefined
    }, 'promptEnhancement lifecycle')
  }

  /**
   * Register the sole enhancement implementation. Its disposer aborts and
   * drains every attempt that captured this registration before releasing it.
   * @param provider - stable identity and side-effect-free enhancement function.
   * @returns awaitable effect disposer.
   */
  registerProvider(provider: PromptEnhancementProvider): () => Promise<void> {
    validateRegistrationId('provider', provider.id)
    if (this.provider !== undefined) {
      throw new Error(`prompt-enhancement provider "${this.provider.implementation.id}" is already registered`)
    }
    const registration: Registration<PromptEnhancementProvider> = {
      implementation: provider,
      controller: new AbortController(),
      active: new Set(),
    }
    return this.ctx.effect(function* (this: PromptEnhancementService) {
      this.provider = registration
      yield async () => {
        registration.controller.abort(new Error(`prompt-enhancement provider "${provider.id}" disposed`))
        await Promise.allSettled([...registration.active])
        if (this.provider === registration) this.provider = undefined
      }
    }.bind(this), 'promptEnhancement.registerProvider()')
  }

  /**
   * Register the sole adapter from the shared Context Engine. The service does
   * not collect history, files, memory, or Evidence itself.
   * @param provider - Context Engine adapter or explicit draft-only provider.
   * @returns awaitable effect disposer.
   */
  registerContextProvider(provider: PromptEnhancementContextProvider): () => Promise<void> {
    validateRegistrationId('context provider', provider.id)
    if (this.contextProvider !== undefined) {
      throw new Error(`prompt-enhancement context provider "${this.contextProvider.implementation.id}" is already registered`)
    }
    const registration: Registration<PromptEnhancementContextProvider> = {
      implementation: provider,
      controller: new AbortController(),
      active: new Set(),
    }
    return this.ctx.effect(function* (this: PromptEnhancementService) {
      this.contextProvider = registration
      yield async () => {
        registration.controller.abort(new Error(`prompt-enhancement context provider "${provider.id}" disposed`))
        await Promise.allSettled([...registration.active])
        if (this.contextProvider === registration) this.contextProvider = undefined
      }
    }.bind(this), 'promptEnhancement.registerContextProvider()')
  }

  /**
   * Prepare shared context and produce one proposal. Provider errors and every
   * cancellation return a preserved outcome containing the exact original
   * draft; this operation never submits or mutates Agent state.
   * @param agent - target Agent whose scoped context and route are used.
   * @param draft - exact unsent draft.
   * @param signal - caller cancellation.
   * @returns structured proposal or a failure-preserving outcome.
   */
  @Remote('enhance')
  async enhance(
    agent: Agent,
    draft: string,
    signal: AbortSignal,
  ): Promise<PromptEnhancementOutcome> {
    if (signal.aborted) {
      return deepFreeze({ kind: 'preserved', reason: 'cancelled', originalDraft: draft })
    }
    if (draft.trim().length === 0) {
      return deepFreeze({
        kind: 'preserved',
        reason: 'failed',
        originalDraft: draft,
        failure: { code: 'PROMPT_ENHANCEMENT_DRAFT_EMPTY', message: 'Prompt draft must not be empty' },
      })
    }
    const draftBytes = Buffer.byteLength(draft, 'utf8')
    if (draftBytes > this.maxDraftBytes) {
      return deepFreeze({
        kind: 'preserved',
        reason: 'failed',
        originalDraft: draft,
        failure: {
          code: 'PROMPT_ENHANCEMENT_DRAFT_TOO_LARGE',
          message: `Prompt draft is ${draftBytes} UTF-8 bytes; the limit is ${this.maxDraftBytes}`,
        },
      })
    }
    const provider = this.provider
    if (provider === undefined) {
      return deepFreeze({
        kind: 'preserved',
        reason: 'failed',
        originalDraft: draft,
        failure: {
          code: 'PROMPT_ENHANCEMENT_PROVIDER_UNAVAILABLE',
          message: 'Prompt Enhancement has no registered enhancement provider',
        },
      })
    }
    const contextProvider = this.contextProvider
    if (contextProvider === undefined) {
      return deepFreeze({
        kind: 'preserved',
        reason: 'failed',
        originalDraft: draft,
        failure: {
          code: 'PROMPT_ENHANCEMENT_CONTEXT_PROVIDER_UNAVAILABLE',
          message: 'Prompt Enhancement has no registered Context Engine adapter',
        },
      })
    }
    const operationSignal = AbortSignal.any([
      signal,
      this.lifetime.signal,
      provider.controller.signal,
      contextProvider.controller.signal,
    ])
    const operation = this.runAttempt(agent, draft, operationSignal, provider, contextProvider)
    this.inFlight.add(operation)
    provider.active.add(operation)
    contextProvider.active.add(operation)
    try {
      return await operation
    } finally {
      this.inFlight.delete(operation)
      provider.active.delete(operation)
      contextProvider.active.delete(operation)
    }
  }

  private async runAttempt(
    agent: Agent,
    draft: string,
    signal: AbortSignal,
    provider: Registration<PromptEnhancementProvider>,
    contextProvider: Registration<PromptEnhancementContextProvider>,
  ): Promise<PromptEnhancementOutcome> {
    try {
      signal.throwIfAborted()
      const prepared = await contextProvider.implementation.prepare({
        purpose: PROMPT_ENHANCEMENT_CONTEXT_PURPOSE,
        agent,
        draft,
        signal,
      })
      signal.throwIfAborted()
      const trace = prepared.trace === undefined ? undefined : snapshotJsonValue(prepared.trace)
      if (prepared.trace !== undefined && trace === undefined) {
        throw new PromptEnhancementError(
          'Prompt Enhancement context trace is not losslessly JSON-serializable',
          'PROMPT_ENHANCEMENT_CONTEXT_TRACE_INVALID',
        )
      }
      if (trace !== undefined) assertResultSize({ contextTrace: trace }, this.maxResultBytes)
      const context: PreparedPromptEnhancementContext = deepFreeze({
        messages: prepared.messages.map(message => freezeMessage(message)),
        ...trace === undefined ? {} : { trace },
      })
      const result = await provider.implementation.enhance({ agent, draft, context, signal })
      signal.throwIfAborted()
      const detached = detachProviderResult(result, this.maxResultBytes)
      const completeResult = {
        originalDraft: draft,
        ...detached,
        ...context.trace === undefined ? {} : { contextTrace: context.trace },
      }
      assertResultSize(completeResult, this.maxResultBytes)
      return deepFreeze({
        kind: 'enhanced',
        result: completeResult,
      })
    } catch (error: unknown) {
      if (signal.aborted) {
        return deepFreeze({ kind: 'preserved', reason: 'cancelled', originalDraft: draft })
      }
      return deepFreeze({
        kind: 'preserved',
        reason: 'failed',
        originalDraft: draft,
        failure: failureOf(error),
      })
    }
  }
}

function validateRegistrationId(kind: string, id: string): void {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error(`prompt-enhancement ${kind} id must be non-empty text`)
  }
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`prompt-enhancement ${name} must be a positive safe integer`)
  }
  return value
}

/** Detach and validate the provider-owned result before it can reach the Remote codec. */
function detachProviderResult(
  result: PromptEnhancementProviderResult,
  maxResultBytes: number,
): PromptEnhancementProviderResult {
  const candidate = snapshotJsonValue({
    enhancedDraft: result.enhancedDraft,
    assumptions: [...result.assumptions],
    openQuestions: [...result.openQuestions],
    model: { provider: result.model.provider, model: result.model.model },
  })
  if (candidate === undefined || !isProviderResult(candidate)) {
    throw new PromptEnhancementError(
      'Prompt Enhancement provider returned an invalid structured result',
      'PROMPT_ENHANCEMENT_RESULT_INVALID',
    )
  }
  const bytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8')
  if (bytes > maxResultBytes) {
    throw new PromptEnhancementError(
      `Prompt Enhancement provider result is ${bytes} UTF-8 bytes; the limit is ${maxResultBytes}`,
      'PROMPT_ENHANCEMENT_RESULT_TOO_LARGE',
    )
  }
  return candidate
}

function assertResultSize(value: unknown, maxResultBytes: number): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (bytes > maxResultBytes) {
    throw new PromptEnhancementError(
      `Prompt Enhancement result is ${bytes} UTF-8 bytes; the limit is ${maxResultBytes}`,
      'PROMPT_ENHANCEMENT_RESULT_TOO_LARGE',
    )
  }
}

function isProviderResult(value: JsonValue): value is PromptEnhancementProviderResult & JsonValue {
  if (value === null || Array.isArray(value) || typeof value !== 'object') return false
  const model = value['model']
  return typeof value['enhancedDraft'] === 'string'
    && value['enhancedDraft'].trim().length > 0
    && Array.isArray(value['assumptions'])
    && value['assumptions'].every(item => typeof item === 'string')
    && Array.isArray(value['openQuestions'])
    && value['openQuestions'].every(item => typeof item === 'string')
    && model !== null
    && !Array.isArray(model)
    && typeof model === 'object'
    && typeof model['provider'] === 'string'
    && model['provider'].trim().length > 0
    && typeof model['model'] === 'string'
    && model['model'].trim().length > 0
}

export default PromptEnhancementService
