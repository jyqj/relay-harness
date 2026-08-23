/**
 * Durable completed-turn capture and auxiliary-LLM memory extraction worker.
 *
 * @module @deepseek-ai/dsh-memory-extractor-llm
 */

import { createHash, randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { memoryContainsSecret } from '@deepseek-ai/dsh-memory'
import type {
  MemoryEvidence,
  MemoryExtractionJob,
  MemoryExtractionResult,
  MemoryExtractionSource,
  MemoryId,
  MemoryScope,
  MemoryTrust,
} from '@deepseek-ai/dsh-memory/types'
import { BlockAssembler, createUserMessage as createLlmUserMessage } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  MEMORY_EXTRACTION_PROMPT_VERSION,
  MEMORY_EXTRACTION_SYSTEM_PROMPT,
  parseExtractionOutput,
  renderExtractionPrompt,
  type ExtractedMemoryCandidate,
} from './prompt.ts'
import { collectExtractionSources } from './sources.ts'

export const name = 'memory-extractor-llm'
export const inject = ['llm', 'longTermMemory', 'memoryExtractionQueue']

const DEFAULT_VERIFIED_TOOL_NAMES = [
  'bash', 'pwsh', 'read', 'write', 'edit', 'str_replace_editor', 'glob', 'grep',
]
const DEFAULT_USER_ID = 'local'
const DEFAULT_AGENT_ID = 'deepseek-harness'

/** Automatic extraction capture, routing, retry, and budget policy. */
export interface Config {
  /** Register capture and worker behavior. Defaults to false. */
  enabled?: boolean
  /** Stable user identity inside each workspace. Defaults to `local`. */
  userId?: string
  /** Stable Agent identity shared across sessions. Defaults to `deepseek-harness`. */
  agentId?: string
  /** Optional explicit workspace identity; omission uses session cwd, then `global`. */
  workspaceId?: string
  /** Restrict capture to these durable agent-preset ids; empty accepts every preset. */
  agentPresets?: string[]
  /** Whether delegated subagent sessions are captured. Defaults to false. */
  includeSubagents?: boolean
  /** Optional auxiliary provider override; must be paired with `model`. */
  provider?: string
  /** Optional auxiliary model override; must be paired with `provider`. */
  model?: string
  /** Tool names whose successful results qualify as action-verified evidence. */
  verifiedToolNames?: string[]
  /** Complete system-plus-user extraction input cap in Unicode code points. */
  maxInputChars?: number
  /** Per-source text cap in Unicode code points. */
  maxSourceChars?: number
  /** Largest accepted model candidate count. */
  maxCandidates?: number
  /** Largest accepted candidate content in Unicode code points. */
  maxCandidateContentChars?: number
  /** Largest accepted candidate summary in Unicode code points. */
  maxCandidateSummaryChars?: number
  /** Auxiliary model output-token cap. */
  maxOutputTokens?: number
  /** End-to-end auxiliary request deadline in milliseconds. */
  timeoutMs?: number
  /** Durable attempt cap for one source hash. */
  maxAttempts?: number
  /** Worker lease duration in milliseconds; must exceed `timeoutMs`. */
  leaseMs?: number
  /** Delay before retrying one failed attempt. */
  retryDelayMs?: number
  /** Idle queue polling interval. */
  pollMs?: number
}

interface ResolvedConfig {
  enabled: boolean
  userId: string
  agentId: string
  workspaceId?: string
  agentPresets: string[]
  includeSubagents: boolean
  provider?: string
  model?: string
  verifiedToolNames: Set<string>
  maxInputChars: number
  maxSourceChars: number
  maxCandidates: number
  maxCandidateContentChars: number
  maxCandidateSummaryChars: number
  maxOutputTokens: number
  timeoutMs: number
  maxAttempts: number
  leaseMs: number
  retryDelayMs: number
  pollMs: number
}

/** Validate and default automatic extraction configuration. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  userId: z.string().default(DEFAULT_USER_ID),
  agentId: z.string().default(DEFAULT_AGENT_ID),
  workspaceId: z.string(),
  agentPresets: z.array(z.string()).default([]),
  includeSubagents: z.boolean().default(false),
  provider: z.string(),
  model: z.string(),
  verifiedToolNames: z.array(z.string()).default(DEFAULT_VERIFIED_TOOL_NAMES),
  maxInputChars: z.number().step(1).min(1).default(16_000),
  maxSourceChars: z.number().step(1).min(1).default(4_000),
  maxCandidates: z.number().step(1).min(1).default(5),
  maxCandidateContentChars: z.number().step(1).min(1).default(2_000),
  maxCandidateSummaryChars: z.number().step(1).min(1).default(300),
  maxOutputTokens: z.number().step(1).min(1).default(1_200),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(60_000),
  maxAttempts: z.number().step(1).min(1).default(3),
  leaseMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(120_000),
  retryDelayMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(5_000),
  pollMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(1_000),
})

/** Mount capture and one process-local worker when explicitly enabled. */
export function apply(ctx: Context, config: Config = {}): void {
  const resolved = resolveConfig(config)
  if (!resolved.enabled) return
  const controller = new AbortController()
  const workerId = `memory-extractor-${randomUUID()}`
  const captures = new Set<Promise<unknown>>()
  const worker = workerLoop(ctx, resolved, workerId, controller.signal)

  ctx.effect(() => async () => {
    controller.abort(new Error('memory extractor disposed'))
    await Promise.allSettled([...captures])
    await worker
  }, 'memoryExtractor.stop')

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    if (event.data.reason.kind !== 'completed' && event.data.reason.kind !== 'max-tokens') return
    if (!resolved.includeSubagents && session.header.origin === 'subagent') return
    if (resolved.agentPresets.length > 0
      && (session.header.agentPreset === undefined || !resolved.agentPresets.includes(session.header.agentPreset))) return
    const collected = collectExtractionSources(session, event.data.turn, resolved)
    if (collected === undefined) return
    const task = ctx.memoryExtractionQueue.enqueue({
      promptVersion: MEMORY_EXTRACTION_PROMPT_VERSION,
      scope: memoryScope(session, resolved),
      sessionId: session.id,
      turn: event.data.turn,
      sourceHash: collected.sourceHash,
      route: collected.route,
      sources: collected.sources,
      maxAttempts: resolved.maxAttempts,
    }).catch((error: unknown) => {
      ctx.logger.warn(`memory-extractor: failed to enqueue ${session.id}/${event.data.turn}: ${errorMessage(error)}`)
    }).finally(() => captures.delete(task))
    captures.add(task)
  })
}

async function workerLoop(
  ctx: Context,
  config: ResolvedConfig,
  workerId: string,
  signal: AbortSignal,
): Promise<void> {
  while (!isAborted(signal)) {
    let job: MemoryExtractionJob | undefined
    try {
      job = await ctx.memoryExtractionQueue.claim({ workerId, leaseMs: config.leaseMs })
    } catch (error: unknown) {
      if (!isAborted(signal)) ctx.logger.warn(`memory-extractor: claim failed: ${errorMessage(error)}`)
      await wait(config.pollMs, signal)
      continue
    }
    if (job === undefined) {
      await wait(config.pollMs, signal)
      continue
    }
    try {
      const result = await extractJob(ctx, config, job, signal)
      await ctx.memoryExtractionQueue.complete({ jobId: job.id, workerId, result })
    } catch (error: unknown) {
      if (isAborted(signal)) return
      try {
        await ctx.memoryExtractionQueue.fail({
          jobId: job.id,
          workerId,
          error: errorMessage(error),
          retryAt: Date.now() + config.retryDelayMs,
        })
      } catch (settlementError: unknown) {
        ctx.logger.warn(`memory-extractor: failure settlement failed for ${job.id}: ${errorMessage(settlementError)}`)
      }
    }
  }
}

async function extractJob(
  ctx: Context,
  config: ResolvedConfig,
  job: MemoryExtractionJob,
  signal: AbortSignal,
): Promise<MemoryExtractionResult> {
  const prompt = renderExtractionPrompt(job.sources)
  using callDeadline = deadline(signal, config.timeoutMs, 'MEMORY_EXTRACTION_TIMEOUT')
  const options: GenerateOptions = {
    provider: job.route.provider,
    model: job.route.model,
    system: MEMORY_EXTRACTION_SYSTEM_PROMPT,
    messages: [createLlmUserMessage({
      source: { kind: 'plugin', plugin: 'dsh-memory-extractor-llm' },
      content: [{ type: 'text', text: prompt }],
    })],
    maxTokens: config.maxOutputTokens,
    sessionId: job.sessionId,
    purpose: 'memory-extraction',
    signal: callDeadline.signal,
  }
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const failure = finishError(assembler.finish)
  if (failure !== undefined) throw failure
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error('memory extractor unexpectedly requested a tool')
  }
  const output = blocks.flatMap(block => block.type === 'text' ? [block.text] : []).join('').trim()
  if (output === '') throw new Error('memory extractor produced no text output')
  const candidates = parseExtractionOutput(
    output,
    config.maxCandidates,
    config.maxCandidateContentChars,
    config.maxCandidateSummaryChars,
  )
  const memoryIds: MemoryId[] = []
  let skippedCount = 0
  for (const candidate of candidates) {
    if (memoryContainsSecret(candidate.content)
      || (candidate.summary !== undefined && memoryContainsSecret(candidate.summary))) {
      skippedCount += 1
      continue
    }
    const grounded = groundCandidate(job.sources, candidate)
    const active = grounded.status === 'active'
    const entry = await ctx.longTermMemory.remember({
      scope: job.scope,
      kind: candidate.kind,
      // Active automatic memory is extractive: the persisted content is the
      // exact durable quote, never the model's paraphrase. Model-authored
      // content and summaries remain candidate-only until human review.
      content: active ? candidate.evidenceQuote : candidate.content,
      ...active || candidate.summary === undefined ? {} : { summary: candidate.summary },
      importance: candidate.importance,
      confidence: confidenceFor(grounded.trust),
      trust: grounded.trust,
      status: grounded.status,
      evidence: [grounded.evidence],
    }, signal)
    memoryIds.push(entry.id)
  }
  return {
    memoryIds: [...new Set(memoryIds)],
    candidateCount: candidates.length,
    skippedCount,
    outputHash: createHash('sha256').update(output).digest('hex'),
  }
}

function groundCandidate(
  sources: readonly MemoryExtractionSource[],
  candidate: ExtractedMemoryCandidate,
): { trust: MemoryTrust; status: 'candidate' | 'active'; evidence: MemoryEvidence } {
  const matches = sources.filter(source => source.text.includes(candidate.evidenceQuote))
    .sort((a, b) => groundingPriority(a) - groundingPriority(b))
  const source = matches[0]
  if (source?.kind === 'user') return { trust: 'user-stated', status: 'active', evidence: source.evidence }
  if (source?.evidence.verification === 'successful-tool-result') {
    return { trust: 'action-verified', status: 'active', evidence: source.evidence }
  }
  if (source?.evidence.verification === 'external-observation') {
    return { trust: 'external', status: 'candidate', evidence: source.evidence }
  }
  const fallback = sources[0]
  if (fallback === undefined) throw new Error('memory extraction job has no source evidence')
  return {
    trust: 'agent-proposed',
    status: 'candidate',
    evidence: {
      ...fallback.evidence,
      verification: 'agent-proposal',
    },
  }
}

function groundingPriority(source: MemoryExtractionSource): number {
  if (source.kind === 'user') return 0
  return source.evidence.verification === 'successful-tool-result' ? 1 : 2
}

function confidenceFor(trust: MemoryTrust): number {
  switch (trust) {
    case 'user-stated':
    case 'action-verified': return 1
    case 'external': return 0.6
    case 'agent-proposed': return 0.5
  }
}

function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop': return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens': return new Error('memory extractor output reached maxOutputTokens')
    case 'tool-calls': return new Error('memory extractor unexpectedly requested a tool')
    default: return new Error(`memory extractor received unsupported finish reason ${String((finish as { kind?: unknown }).kind)}`)
  }
}

function memoryScope(session: Session, config: ResolvedConfig): MemoryScope {
  return {
    workspaceId: config.workspaceId ?? session.header.cwd ?? 'global',
    userId: config.userId,
    agentId: config.agentId,
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const provider = optionalText('provider', config.provider)
  const model = optionalText('model', config.model)
  if ((provider === undefined) !== (model === undefined)) {
    throw new Error('memory extractor provider and model must be supplied together')
  }
  const values = {
    maxInputChars: config.maxInputChars ?? 16_000,
    maxSourceChars: config.maxSourceChars ?? 4_000,
    maxCandidates: config.maxCandidates ?? 5,
    maxCandidateContentChars: config.maxCandidateContentChars ?? 2_000,
    maxCandidateSummaryChars: config.maxCandidateSummaryChars ?? 300,
    maxOutputTokens: config.maxOutputTokens ?? 1_200,
    timeoutMs: config.timeoutMs ?? 60_000,
    maxAttempts: config.maxAttempts ?? 3,
    leaseMs: config.leaseMs ?? 120_000,
    retryDelayMs: config.retryDelayMs ?? 5_000,
    pollMs: config.pollMs ?? 1_000,
  }
  for (const [key, value] of Object.entries(values)) {
    if (!Number.isSafeInteger(value) || value < (key === 'retryDelayMs' ? 0 : 1)) {
      throw new Error(`memory extractor ${key} has an invalid integer value`)
    }
  }
  if (values.maxSourceChars >= values.maxInputChars) {
    throw new Error('memory extractor maxSourceChars must be smaller than maxInputChars')
  }
  if (values.leaseMs <= values.timeoutMs) {
    throw new Error('memory extractor leaseMs must be greater than timeoutMs')
  }
  const fixedInputChars = Array.from(MEMORY_EXTRACTION_SYSTEM_PROMPT).length
    + Array.from(renderExtractionPrompt([])).length
  if (values.maxInputChars <= fixedInputChars) {
    throw new Error(`memory extractor maxInputChars must exceed fixed framing length ${fixedInputChars}`)
  }
  const agentPresets = uniqueText(config.agentPresets ?? [], 'agentPresets')
  const verifiedToolNames = new Set(uniqueText(config.verifiedToolNames ?? DEFAULT_VERIFIED_TOOL_NAMES, 'verifiedToolNames'))
  return {
    enabled: config.enabled ?? false,
    userId: requireText('userId', config.userId ?? DEFAULT_USER_ID),
    agentId: requireText('agentId', config.agentId ?? DEFAULT_AGENT_ID),
    ...config.workspaceId === undefined ? {} : { workspaceId: requireText('workspaceId', config.workspaceId) },
    agentPresets,
    includeSubagents: config.includeSubagents ?? false,
    ...provider === undefined || model === undefined ? {} : { provider, model },
    verifiedToolNames,
    ...values,
  }
}

function uniqueText(values: readonly string[], name: string): string[] {
  const normalized = values.map((value, index) => requireText(`${name}[${index}]`, value))
  if (new Set(normalized).size !== normalized.length) throw new Error(`memory extractor ${name} must not contain duplicates`)
  return normalized
}

function optionalText(name: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : requireText(name, value)
}

function requireText(name: string, value: string): string {
  const normalized = value.trim()
  if (normalized === '') throw new Error(`memory extractor ${name} must not be empty`)
  return normalized
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (isAborted(signal)) return
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, milliseconds)
    signal.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
