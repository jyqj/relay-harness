/** Model-backed Prompt Enhancement provider with exact request logging. */

import { Buffer } from 'node:buffer'
import type { Context } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import { BlockAssembler, createUserMessage, deepFreeze } from '@relay-harness/rlh-llm'
import type { FinishReason, GenerateOptions, Message } from '@relay-harness/rlh-llm'
import type {
  PromptEnhancementModelProvenance,
  PromptEnhancementProviderRequest,
  PromptEnhancementProviderResult,
} from '@relay-harness/rlh-prompt-enhancement'
import { PromptEnhancementError as SafePromptEnhancementError } from '@relay-harness/rlh-prompt-enhancement'
import type { JsonValue } from '@relay-harness/rlh-session/types'
import { deadline, MAX_TIMER_DELAY_MS } from '@relay-harness/rlh-timeout'
import {
  parsePromptEnhancementOutput,
  PROMPT_ENHANCEMENT_PROMPT_VERSION,
  PROMPT_ENHANCEMENT_SYSTEM_PROMPT,
  renderPromptEnhancementDraft,
} from './prompt.ts'

export {
  parsePromptEnhancementOutput,
  PROMPT_ENHANCEMENT_PROMPT_VERSION,
  PROMPT_ENHANCEMENT_SYSTEM_PROMPT,
  renderPromptEnhancementDraft,
} from './prompt.ts'
export type { ParsedPromptEnhancement } from './prompt.ts'

export const name = 'prompt-enhancement-llm'
export const inject = ['promptEnhancement', 'llm']

/** Exact model-visible request recorded before one enhancement dispatch. */
export interface PromptEnhancementLlmRequestEventData {
  /** Registered enhancement-provider identity. */
  readonly enhancementProvider: string
  /** Prompt/output schema version. */
  readonly promptVersion: number
  /** Exact provider-neutral auxiliary purpose carried by the request. */
  readonly purpose: 'prompt-enhancement'
  /** Exact auxiliary model route. */
  readonly route: PromptEnhancementModelProvenance
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** Exact auxiliary message list in provider order. */
  readonly messages: Message[]
  /** Exact auxiliary output-token cap. */
  readonly maxTokens: number
  /** Opaque shared Context Engine trace when the adapter supplied one. */
  readonly contextTrace?: JsonValue
}

declare module '@relay-harness/rlh-session/types' {
  interface SessionEventMap {
    /** Log-only pre-dispatch record of one Prompt Enhancement model request. */
    'prompt-enhancement/llm-request': PromptEnhancementLlmRequestEventData
  }
}

/** Capability-owned timeout reason code. */
export const PROMPT_ENHANCEMENT_TIMEOUT_CODE = 'PROMPT_ENHANCEMENT_TIMEOUT'

/** Model route, budget, and structured-output policy. */
export interface Config {
  /** Optional explicit provider route; must be paired with `model`. */
  readonly provider?: string
  /** Optional explicit model id; must be paired with `provider`. */
  readonly model?: string
  /** Maximum UTF-8 bytes across the exact system and message list. */
  readonly maxInputBytes?: number
  /** Auxiliary generation output-token cap. */
  readonly maxOutputTokens?: number
  /** Maximum cumulative UTF-8 bytes admitted from the raw output stream. */
  readonly maxOutputBytes?: number
  /** End-to-end auxiliary request deadline in milliseconds. */
  readonly timeoutMs?: number
  /** Largest accepted enhanced draft in Unicode code points. */
  readonly maxDraftChars?: number
  /** Largest accepted assumptions or questions array. */
  readonly maxListItems?: number
  /** Largest accepted assumption or question in Unicode code points. */
  readonly maxItemChars?: number
}

interface ResolvedConfig {
  readonly provider?: string
  readonly model?: string
  readonly maxInputBytes: number
  readonly maxOutputTokens: number
  readonly maxOutputBytes: number
  readonly timeoutMs: number
  readonly maxDraftChars: number
  readonly maxListItems: number
  readonly maxItemChars: number
}

/** Loader schema for every deployment-varying limit. */
export const Config: z<Config> = z.object({
  provider: z.string(),
  model: z.string(),
  maxInputBytes: z.number().step(1).min(1).default(131_072),
  maxOutputTokens: z.number().step(1).min(1).default(2_048),
  maxOutputBytes: z.number().step(1).min(1).default(512 * 1024),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(60_000),
  maxDraftChars: z.number().step(1).min(1).default(32_000),
  maxListItems: z.number().step(1).min(0).default(20),
  maxItemChars: z.number().step(1).min(1).default(2_000),
})

/** Register the sole model-backed enhancement provider. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  ctx.promptEnhancement.registerProvider({
    id: name,
    enhance: request => enhanceWithLlm(ctx, resolved, request),
  })
}

/**
 * Execute one side-effect-free auxiliary model request.
 * @param ctx - context exposing the LLM runtime.
 * @param config - validated model and budget policy.
 * @param request - exact draft, shared prepared context, Agent, and cancellation.
 * @returns validated structured enhancement.
 */
export async function enhanceWithLlm(
  ctx: Context,
  config: ResolvedConfig,
  request: PromptEnhancementProviderRequest,
): Promise<PromptEnhancementProviderResult> {
  request.signal.throwIfAborted()
  const route = resolveRoute(config, request)
  const messages: Message[] = [
    ...request.context.messages,
    createUserMessage({
      source: { kind: 'plugin', plugin: 'rlh-prompt-enhancement-llm' },
      content: [{ type: 'text', text: renderPromptEnhancementDraft(request.draft) }],
    }),
  ]
  const inputBytes = Buffer.byteLength(JSON.stringify({
    system: PROMPT_ENHANCEMENT_SYSTEM_PROMPT,
    messages,
  }), 'utf8')
  if (inputBytes > config.maxInputBytes) {
    throw safeError(
      `Prompt Enhancement input is ${inputBytes} UTF-8 bytes; the limit is ${config.maxInputBytes}`,
      'PROMPT_ENHANCEMENT_INPUT_TOO_LARGE',
    )
  }
  using callDeadline = deadline(request.signal, config.timeoutMs, PROMPT_ENHANCEMENT_TIMEOUT_CODE)
  const options: GenerateOptions = deepFreeze({
    provider: route.provider,
    model: route.model,
    system: PROMPT_ENHANCEMENT_SYSTEM_PROMPT,
    messages,
    maxTokens: config.maxOutputTokens,
    sessionId: request.agent.session.id,
    purpose: 'prompt-enhancement',
    signal: callDeadline.signal,
  })
  request.agent.session.append('prompt-enhancement/llm-request', {
    enhancementProvider: name,
    promptVersion: PROMPT_ENHANCEMENT_PROMPT_VERSION,
    purpose: 'prompt-enhancement',
    route,
    system: PROMPT_ENHANCEMENT_SYSTEM_PROMPT,
    messages,
    maxTokens: config.maxOutputTokens,
    ...request.context.trace === undefined
      ? {}
      : { contextTrace: structuredClone(request.context.trace) },
  })
  callDeadline.signal.throwIfAborted()
  const assembler = new BlockAssembler()
  let outputBytes = 0
  for await (const chunk of ctx.llm.stream(options)) {
    callDeadline.signal.throwIfAborted()
    outputBytes += Buffer.byteLength(JSON.stringify(chunk), 'utf8')
    if (outputBytes > config.maxOutputBytes) {
      throw safeError(
        `Prompt Enhancement output exceeded the ${config.maxOutputBytes} UTF-8 byte stream limit`,
        'PROMPT_ENHANCEMENT_OUTPUT_TOO_LARGE',
      )
    }
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const terminalError = finishError(assembler.finish)
  if (terminalError !== undefined) throw terminalError
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw safeError(
      'Prompt Enhancement model unexpectedly requested a tool',
      'PROMPT_ENHANCEMENT_TOOL_CALL_REJECTED',
    )
  }
  if (blocks.some(block => block.type !== 'text' && block.type !== 'reasoning')) {
    throw safeError(
      'Prompt Enhancement model returned unsupported non-text content',
      'PROMPT_ENHANCEMENT_OUTPUT_INVALID',
    )
  }
  const output = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim()
  if (output.length === 0) {
    throw safeError('Prompt Enhancement model produced no text output', 'PROMPT_ENHANCEMENT_OUTPUT_EMPTY')
  }
  let parsed
  try {
    parsed = parsePromptEnhancementOutput(
      output,
      config.maxDraftChars,
      config.maxListItems,
      config.maxItemChars,
    )
  } catch {
    throw safeError(
      'Prompt Enhancement model returned an invalid structured result',
      'PROMPT_ENHANCEMENT_OUTPUT_INVALID',
    )
  }
  return { ...parsed, model: route }
}

function resolveRoute(
  config: ResolvedConfig,
  request: PromptEnhancementProviderRequest,
): PromptEnhancementModelProvenance {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  if ((request.agent.options.provider === undefined) !== (request.agent.options.model === undefined)) {
    throw safeError(
      'Prompt Enhancement Agent route must contain both provider and model',
      'PROMPT_ENHANCEMENT_ROUTE_INCOMPLETE',
    )
  }
  if (request.agent.options.provider !== undefined && request.agent.options.model !== undefined) {
    return { provider: request.agent.options.provider, model: request.agent.options.model }
  }
  const logged = request.agent.session.requestHeader()?.config
  if (logged !== undefined) return { provider: logged.provider, model: logged.model }
  throw safeError(
    'Prompt Enhancement has no model route; configure provider and model together',
    'PROMPT_ENHANCEMENT_ROUTE_UNAVAILABLE',
  )
}

function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop': return undefined
    case 'error':
    case 'aborted': return safeError(
      'Prompt Enhancement model request failed',
      safeFailureCode(finish.failure.code),
    )
    case 'max-tokens': return safeError(
      'Prompt Enhancement model output reached maxOutputTokens',
      'PROMPT_ENHANCEMENT_OUTPUT_MAX_TOKENS',
    )
    case 'tool-calls': return safeError(
      'Prompt Enhancement model unexpectedly requested a tool',
      'PROMPT_ENHANCEMENT_TOOL_CALL_REJECTED',
    )
    default: return safeError(
      'Prompt Enhancement model returned an unsupported finish reason',
      'PROMPT_ENHANCEMENT_FINISH_INVALID',
    )
  }
}

function safeFailureCode(code: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/u.test(code)
    ? code
    : 'PROMPT_ENHANCEMENT_MODEL_FAILED'
}

/**
 * Validate and materialize every deployment default.
 * @param config - Loader or direct-call model route and budget policy.
 * @returns immutable complete policy.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const provider = optionalText('provider', config.provider)
  const model = optionalText('model', config.model)
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error('prompt-enhancement-llm provider and model must be supplied together')
  }
  const resolved = {
    ...provider === undefined ? {} : { provider },
    ...model === undefined ? {} : { model },
    maxInputBytes: positiveInteger('maxInputBytes', config.maxInputBytes ?? 131_072),
    maxOutputTokens: positiveInteger('maxOutputTokens', config.maxOutputTokens ?? 2_048),
    maxOutputBytes: positiveInteger('maxOutputBytes', config.maxOutputBytes ?? 512 * 1024),
    timeoutMs: positiveInteger('timeoutMs', config.timeoutMs ?? 60_000),
    maxDraftChars: positiveInteger('maxDraftChars', config.maxDraftChars ?? 32_000),
    maxListItems: nonNegativeInteger('maxListItems', config.maxListItems ?? 20),
    maxItemChars: positiveInteger('maxItemChars', config.maxItemChars ?? 2_000),
  }
  if (resolved.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`prompt-enhancement-llm timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  return deepFreeze(resolved)
}

function safeError(message: string, code: string): SafePromptEnhancementError {
  return new SafePromptEnhancementError(message, code)
}

function optionalText(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`prompt-enhancement-llm ${name} must be non-empty text`)
  }
  return value
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`prompt-enhancement-llm ${name} must be a positive safe integer`)
  }
  return value
}

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`prompt-enhancement-llm ${name} must be a non-negative safe integer`)
  }
  return value
}
