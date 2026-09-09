import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { AttachmentId } from '@relay-harness/rlh-attachment'
import { CallId, createUserMessage } from '@relay-harness/rlh-llm'
import type { ContentBlock, ImageBlock, LlmResolvedModelInfo, StreamChunk } from '@relay-harness/rlh-llm'
import { SessionId } from '@relay-harness/rlh-session'
import { mountAgentLoopTestDependencies } from '@relay-harness/rlh-agent-loop-testkit'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'
import { MockAdapter, textResponse, maxTokensResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import VisionFallback, { VISION_DESCRIBE_TIMEOUT_CODE, VISION_FALLBACK_SETTINGS_NAMESPACE } from '../src/index.ts'

class VisionAdapter extends MockAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider, id: model, name: model,
      ...model === 'legacy' ? {} : { inputModalities: model === 'main' ? ['text'] : ['text', 'image'] },
    })
  }
}

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function setup(
  script: ConstructorParameters<typeof MockAdapter>[0] = [],
  route: { provider?: string; model?: string } = { provider: 'mock', model: 'vision' },
  timeoutMs = 1000,
  settings = true,
) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  if (settings) await ctx.plugin(MemorySettings, { doc: { 'vision-fallback': route } })
  const adapter = new VisionAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(VisionFallback, { maxOutputTokens: 100, timeoutMs })
  return { ctx, adapter, session: ctx.sessions.create(SessionId('vision-test')) }
}

function image(name?: string): ImageBlock {
  return { type: 'image', attachment: {
    attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`), mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    ...name === undefined ? {} : { name },
  } }
}
function textOf(block: ContentBlock | undefined): string {
  if (block?.type !== 'text') throw new Error('expected a substituted text block')
  return block.text
}
const signal = new AbortController().signal
const source = { kind: 'user' as const }
const main = { provider: 'mock', model: 'main' }

describe('vision fallback request and log boundaries', () => {
  it.each([{}, { provider: '' }, { provider: 'mock' }, { provider: 'mock', model: '' }])('stays dormant with an incomplete route %j', async (route) => {
    const { ctx, session, adapter } = await setup([], route)
    const messages = [createUserMessage({ source, content: [image()] })]
    expect(ctx.visionFallback.configured()).toBe(false)
    expect(await ctx.visionFallback.rewriteMessages(session, main, messages, signal)).toBe(messages)
    expect(adapter.requests).toEqual([])
  })

  it.each(['vision', 'legacy'])('preserves images for a main model with %s capabilities', async (model) => {
    const { ctx, session, adapter } = await setup()
    const messages = [createUserMessage({ source, content: [image()] })]
    expect(await ctx.visionFallback.rewriteMessages(session, { ...main, model }, messages, signal)).toBe(messages)
    expect(adapter.requests).toEqual([])
  })

  it('describes once, substitutes nested tool images, and reuses the session log after route changes', async () => {
    const { ctx, session, adapter } = await setup([textResponse('visible text')])
    const plain = createUserMessage({ source, content: [{ type: 'text', text: 'unchanged' }] })
    const textOnly = [plain]
    expect(await ctx.visionFallback.rewriteMessages(session, main, textOnly, signal)).toBe(textOnly)
    session.append('user/message', plain, { surfaceOp: 'append' })
    const messages = [plain, createUserMessage({ source, content: [image('screen.png'), {
      type: 'tool-result', toolCallId: CallId('image-tool'), content: [image('')],
    }, { type: 'text', text: 'caption' }] })]
    const rewritten = await ctx.visionFallback.rewriteMessages(session, main, messages, signal)
    expect(rewritten[0]).toBe(plain)
    expect(textOf(rewritten[1]?.content[0])).toContain('visible text')
    expect(textOf(rewritten[1]?.content[0])).toContain('screen.png')
    const nested = rewritten[1]?.content[1]
    if (nested?.type !== 'tool-result') throw new Error('tool result wrapper was not preserved')
    expect(textOf(nested.content[0])).toContain('visible text')
    expect(messages[1]?.content[0]?.type).toBe('image')
    expect(rewritten[1]?.content[2]).toBe(messages[1]?.content[2])
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'vision', maxTokens: 100, purpose: 'vision-describe' })
    expect(session.events.filter(event => event.type === 'vision/describe')).toHaveLength(1)
    await ctx.settings.update(VISION_FALLBACK_SETTINGS_NAMESPACE, { model: 'new-vision' })
    expect(await ctx.visionFallback.rewriteMessages(session, main, messages, signal)).toEqual(rewritten)
    expect(adapter.requests).toHaveLength(1)
  })

  it('keeps a nonempty truncated description but never logs empty output', async () => {
    const { ctx, session } = await setup([maxTokensResponse('prefix')])
    const messages = [createUserMessage({ source, content: [image()] })]
    expect(textOf((await ctx.visionFallback.rewriteMessages(session, main, messages, signal))[0]?.content[0])).toContain('prefix')
    const empty = await setup([textResponse('   ')])
    await expect(empty.ctx.visionFallback.rewriteMessages(empty.session, main, messages, signal)).rejects.toThrow('no description text')
    expect(empty.session.events.filter(event => event.type === 'vision/describe')).toEqual([])
  })
})

describe('vision fallback failure boundaries', () => {
  it.each(['error', 'aborted'] as const)('propagates %s without caching partial output', async (kind) => {
    const { ctx, session } = await setup([[
      ...textResponse('partial').slice(0, -1),
      { type: 'finish', reason: { kind, failure: { message: 'fixture failure', code: 'FIXTURE_VISION_FAILURE' } } },
    ]])
    await expect(ctx.visionFallback.rewriteMessages(session, main, [createUserMessage({ source, content: [image()] })], signal))
      .rejects.toMatchObject({ message: 'fixture failure', code: 'FIXTURE_VISION_FAILURE' })
    expect(session.events.filter(event => event.type === 'vision/describe')).toEqual([])
  })

  it('rejects a vision response that requests tools', async () => {
    const { ctx, session } = await setup([[{ type: 'finish', reason: { kind: 'tool-calls' } }]])
    await expect(ctx.visionFallback.rewriteMessages(session, main, [createUserMessage({ source, content: [image()] })], signal))
      .rejects.toThrow('unexpectedly requested a tool')
    expect(session.events.filter(event => event.type === 'vision/describe')).toEqual([])
  })

  it('honors cancellation before describing and preserves the input', async () => {
    const { ctx, session, adapter } = await setup()
    const owner = new AbortController()
    owner.abort(new Error('fixture cancelled'))
    const messages = [createUserMessage({ source, content: [image()] })]
    await expect(ctx.visionFallback.rewriteMessages(session, main, messages, owner.signal)).rejects.toThrow('fixture cancelled')
    expect(adapter.requests).toEqual([])
    expect(messages[0]?.content[0]?.type).toBe('image')
    expect(session.events.filter(event => event.type === 'vision/describe')).toEqual([])
  })
})


it('enforces the auxiliary deadline without caching a partial description', async () => {
  const { ctx, session, adapter } = await setup(['hang'], undefined, 100)
  await expect(ctx.visionFallback.rewriteMessages(session, main, [createUserMessage({ source, content: [image()] })], signal))
    .rejects.toMatchObject({ code: VISION_DESCRIBE_TIMEOUT_CODE })
  expect(adapter.requests).toHaveLength(1)
  expect(adapter.requests[0]?.signal?.aborted).toBe(true)
  expect(session.events.filter(event => event.type === 'vision/describe')).toEqual([])
})

it('does not publish a description when the caller aborts during the auxiliary request', async () => {
  const owner = new AbortController()
  const { ctx, session } = await setup([() => {
    owner.abort(new Error('fixture caller stopped'))
    return textResponse('must not be recorded')
  }])
  await expect(ctx.visionFallback.rewriteMessages(session, main, [createUserMessage({ source, content: [image()] })], owner.signal))
    .rejects.toThrow('fixture caller stopped')
  expect(session.events.filter(event => event.type === 'vision/describe')).toEqual([])
})

it('refuses an unknown finish tag from an adapter without caching its response', async () => {
  // Fault-inject the merge-extensible adapter boundary without widening the
  // production type vocabulary through a test-only ambient declaration.
  const finish = { type: 'finish', reason: { kind: 'future-provider-finish' } } as unknown as StreamChunk
  const { ctx, session } = await setup([[finish]])
  await expect(ctx.visionFallback.rewriteMessages(session, main, [createUserMessage({ source, content: [image()] })], signal))
    .rejects.toThrow('unsupported finish reason')
  expect(session.events.filter(event => event.type === 'vision/describe')).toEqual([])
})


it('supports late settings attachment and falls back to disabled after provider disposal', async () => {
  const { ctx, session, adapter } = await setup([], {}, 1000, false)
  const messages = [createUserMessage({ source, content: [image()] })]
  expect(ctx.visionFallback.configured()).toBe(false)
  expect(await ctx.visionFallback.rewriteMessages(session, main, messages, signal)).toBe(messages)
  const settings = await ctx.plugin(MemorySettings, { doc: { 'vision-fallback': { provider: 'mock', model: 'vision' } } })
  expect(ctx.visionFallback.selection()).toEqual({ provider: 'mock', model: 'vision' })
  await settings.dispose()
  expect(ctx.visionFallback.configured()).toBe(false)
  expect(await ctx.visionFallback.rewriteMessages(session, main, messages, signal)).toBe(messages)
  expect(adapter.requests).toEqual([])
})
