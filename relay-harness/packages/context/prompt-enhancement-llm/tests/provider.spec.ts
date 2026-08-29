/** Exact no-tools auxiliary dispatch, request durability, output validation, and cancellation. */

import { Context } from '@relay-harness/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@relay-harness/rlh-agent'
import LlmRuntime, {
  CallId,
  createUserMessage,
  isAgentLoopRequest,
  LlmAdapter,
} from '@relay-harness/rlh-llm'
import type { GenerateOptions, StreamChunk } from '@relay-harness/rlh-llm'
import type { PromptEnhancementProviderRequest } from '@relay-harness/rlh-prompt-enhancement'
import SessionStore, { Session, SessionId } from '@relay-harness/rlh-session'
import {
  enhanceWithLlm,
  PROMPT_ENHANCEMENT_PROMPT_VERSION,
  PROMPT_ENHANCEMENT_SYSTEM_PROMPT,
  resolveConfig,
} from '../src/index.ts'

const OUTPUT = JSON.stringify({
  enhancedDraft: 'Implement the feature and verify it with focused tests.',
  assumptions: ['The existing test runner remains authoritative.'],
  openQuestions: ['Which browser versions are required?'],
})

const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: OUTPUT },
  { type: 'finish', reason: { kind: 'stop' } },
]

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: readonly StreamChunk[],
    private readonly onDispatch?: () => void,
  ) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.onDispatch?.()
    this.requests.push(options)
    yield * this.script
  }
}

class CooperativeAdapter extends LlmAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (signal === undefined) throw new Error('expected enhancement request signal')
    await new Promise<never>((_resolve, reject) => {
      const rejectAbort = (): void => {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exact AbortSignal reason is the timeout contract
        reject(signal.reason)
      }
      if (signal.aborted) rejectAbort()
      else signal.addEventListener('abort', rejectAbort, { once: true })
    })
  }
}

let nextSession = 0

async function bench(script: readonly StreamChunk[] = SCRIPT, onDispatch?: () => void) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const session = ctx.sessions.create(SessionId(`prompt-enhancement-${++nextSession}`))
  const agent = {
    id: session.id,
    session,
    options: { provider: 'current-route', model: 'current-model' },
    ctx,
  } as unknown as Agent
  const adapter = new RecordingAdapter(script, onDispatch)
  ctx.llm.registerAdapter(['current-route'], adapter)
  return { ctx, agent, adapter }
}

function request(agent: Agent, signal = new AbortController().signal): PromptEnhancementProviderRequest {
  return {
    agent,
    draft: 'make feature better',
    context: {
      messages: [createUserMessage({
        source: { kind: 'plugin', plugin: 'context-engine-adapter' },
        content: [{ type: 'text', text: 'Relevant source excerpt' }],
      })],
      trace: { requestId: 'ctx-42', evidence: 1 },
    },
    signal,
  }
}

describe('prompt-enhancement-llm provider', () => {
  it('logs then dispatches the exact context and draft with no tool surface or AgentLoop identity', async () => {
    let loggedAtDispatch = false
    const initial = await bench()
    const observedSession = initial.agent.session
    const adapter = new RecordingAdapter(SCRIPT, () => {
      loggedAtDispatch = observedSession.events.some(event => event.type === 'prompt-enhancement/llm-request')
    })
    initial.ctx.llm.registerAdapter(['recording-route'], adapter)
    initial.agent.options.provider = 'recording-route'

    const result = await enhanceWithLlm(initial.ctx, resolveConfig({ maxOutputTokens: 512 }), request(initial.agent))

    expect(result).toEqual({
      enhancedDraft: 'Implement the feature and verify it with focused tests.',
      assumptions: ['The existing test runner remains authoritative.'],
      openQuestions: ['Which browser versions are required?'],
      model: { provider: 'recording-route', model: 'current-model' },
    })
    expect(loggedAtDispatch).toBe(true)
    const options = adapter.requests[0]!
    expect(isAgentLoopRequest(options)).toBe(false)
    expect(Object.isFrozen(options)).toBe(true)
    expect(options).toMatchObject({
      provider: 'recording-route',
      model: 'current-model',
      purpose: 'prompt-enhancement',
      maxTokens: 512,
      sessionId: initial.agent.session.id,
      system: PROMPT_ENHANCEMENT_SYSTEM_PROMPT,
    })
    expect(options).not.toHaveProperty('tools')
    expect(options.messages).toHaveLength(2)
    expect(options.messages[0]?.content[0]).toMatchObject({ type: 'text', text: 'Relevant source excerpt' })
    expect(options.messages[1]?.content[0]).toMatchObject({ type: 'text' })
    expect((options.messages[1]?.content[0] as { text: string }).text).toContain('make feature better')
    expect(initial.agent.session.events.findLast(event => event.type === 'prompt-enhancement/llm-request')?.data)
      .toEqual({
        enhancementProvider: 'prompt-enhancement-llm',
        promptVersion: PROMPT_ENHANCEMENT_PROMPT_VERSION,
        purpose: 'prompt-enhancement',
        route: { provider: 'recording-route', model: 'current-model' },
        system: PROMPT_ENHANCEMENT_SYSTEM_PROMPT,
        messages: options.messages,
        maxTokens: 512,
        contextTrace: { requestId: 'ctx-42', evidence: 1 },
      })
    const replay = Session.create(SessionId('prompt-enhancement-replay'), initial.agent.session.events)
    expect(replay.events.findLast(event => event.type === 'prompt-enhancement/llm-request')?.data)
      .toEqual(initial.agent.session.events.findLast(event => event.type === 'prompt-enhancement/llm-request')?.data)
    expect(replay.deriveMessages()).toEqual([])
  })

  it('supports paired route overrides and rejects the complete input before logging or dispatch', async () => {
    const { ctx, agent } = await bench()
    const explicit = new RecordingAdapter(SCRIPT)
    ctx.llm.registerAdapter(['explicit'], explicit)
    const providerRequest = request(agent)
    await expect(enhanceWithLlm(ctx, resolveConfig({
      provider: 'explicit', model: 'enhancer', maxInputBytes: 1,
    }), providerRequest)).rejects.toMatchObject({ code: 'PROMPT_ENHANCEMENT_INPUT_TOO_LARGE' })
    expect(explicit.requests).toEqual([])
    expect(agent.session.events.some(event => event.type === 'prompt-enhancement/llm-request')).toBe(false)

    await expect(enhanceWithLlm(ctx, resolveConfig({
      provider: 'explicit', model: 'enhancer', maxInputBytes: 131_072,
    }), providerRequest)).resolves.toMatchObject({ model: { provider: 'explicit', model: 'enhancer' } })
  })

  it('rejects malformed structured output, unexpected tool blocks, and non-stop finishes', async () => {
    const invalid = await bench([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: '{"enhancedDraft":"x"}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    await expect(enhanceWithLlm(invalid.ctx, resolveConfig({}), request(invalid.agent)))
      .rejects.toMatchObject({ code: 'PROMPT_ENHANCEMENT_OUTPUT_INVALID' })

    const tool = await bench([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: CallId('enhance-tool'), name: 'write', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    await expect(enhanceWithLlm(tool.ctx, resolveConfig({}), request(tool.agent)))
      .rejects.toMatchObject({ code: 'PROMPT_ENHANCEMENT_TOOL_CALL_REJECTED' })

    const maxed = await bench([{ type: 'finish', reason: { kind: 'max-tokens' } }])
    await expect(enhanceWithLlm(maxed.ctx, resolveConfig({}), request(maxed.agent)))
      .rejects.toMatchObject({ code: 'PROMPT_ENHANCEMENT_OUTPUT_MAX_TOKENS' })

    const image = await bench([
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'image',
          attachment: {
            attachmentId: 'image-1', mediaType: 'image/png', bytes: 1, width: 1, height: 1,
          },
        },
      } as StreamChunk,
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    await expect(enhanceWithLlm(image.ctx, resolveConfig({}), request(image.agent)))
      .rejects.toMatchObject({ code: 'PROMPT_ENHANCEMENT_OUTPUT_INVALID' })
  })

  it('bounds the raw stream before assembly and rejects a partial live Agent route', async () => {
    const oversized = await bench([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'x'.repeat(100) },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    await expect(enhanceWithLlm(
      oversized.ctx,
      resolveConfig({ maxOutputBytes: 20 }),
      request(oversized.agent),
    )).rejects.toMatchObject({ code: 'PROMPT_ENHANCEMENT_OUTPUT_TOO_LARGE' })

    const partial = await bench()
    delete partial.agent.options.model
    await expect(enhanceWithLlm(partial.ctx, resolveConfig({}), request(partial.agent)))
      .rejects.toMatchObject({ code: 'PROMPT_ENHANCEMENT_ROUTE_INCOMPLETE' })
    expect(partial.adapter.requests).toEqual([])
  })

  it('honors pre-cancellation without a durable request and aborts a cooperative stream at its deadline', async () => {
    const pre = await bench()
    const controller = new AbortController()
    controller.abort(new Error('user cancelled'))
    await expect(enhanceWithLlm(pre.ctx, resolveConfig({}), request(pre.agent, controller.signal)))
      .rejects.toThrow('user cancelled')
    expect(pre.adapter.requests).toEqual([])
    expect(pre.agent.session.events.some(event => event.type === 'prompt-enhancement/llm-request')).toBe(false)

    vi.useFakeTimers()
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(LlmRuntime)
      const session = ctx.sessions.create(SessionId('enhancement-timeout'))
      const agent = {
        id: session.id,
        session,
        options: { provider: 'cooperative', model: 'model' },
        ctx,
      } as unknown as Agent
      ctx.llm.registerAdapter(['cooperative'], new CooperativeAdapter())
      const pending = enhanceWithLlm(ctx, resolveConfig({ timeoutMs: 10 }), request(agent))
      const rejected = expect(pending).rejects.toMatchObject({ code: 'PROMPT_ENHANCEMENT_TIMEOUT', timeoutMs: 10 })
      await vi.advanceTimersByTimeAsync(10)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })

  it('validates the paired route and every output bound', () => {
    expect(() => resolveConfig({ provider: 'only' })).toThrow(/supplied together/)
    expect(() => resolveConfig({ model: 'only' })).toThrow(/supplied together/)
    expect(() => resolveConfig({ timeoutMs: 0 })).toThrow(/positive safe integer/)
    expect(() => resolveConfig({ maxListItems: -1 })).toThrow(/non-negative safe integer/)
    expect(() => resolveConfig({ maxOutputBytes: 0 })).toThrow(/positive safe integer/)
    expect(() => resolveConfig({ maxDraftChars: 1.5 })).toThrow(/positive safe integer/)
  })
})
