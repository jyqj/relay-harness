import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as BehaviorCorrection from '@deepseek-ai/dsh-behavior-correction'
import type { Config } from '@deepseek-ai/dsh-behavior-correction'
import { MockAdapter, maxTokensResponse, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Behavior suite for the behavior-correction guard: empty-answer /
 * unexecuted-code / unverified-completion detection at the stop boundary,
 * per-turn and consecutive caps, detector toggles, and fail-loud config
 * validation — all driven through a real agent loop against a scripted mock
 * adapter (no network).
 */

/** Boot the core spine + the guard; the caller registers adapters. */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(BehaviorCorrection, config)
  ctx.tools.register(defineContentToolFixture({ name: 'probe', description: 'p', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } }))
  return ctx
}

function startAgent(ctx: Context, adapter: MockAdapter, id: string): Agent {
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId(id), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
  return agent
}

/** Every guard-steered user message in the agent's log, flattened for terse assertions. */
function corrections(agent: Agent): { text: string; source: unknown }[] {
  return [...agent.session.events]
    .filter((e): e is SessionEvent<'user/message'> => e.type === 'user/message'
      && e.data.source.kind === 'plugin')
    .map(e => ({
      text: e.data.content.map(block => block.type === 'text' ? block.text : '').join('|'),
      source: e.data.source,
    }))
}

const guardSource = (summary: string) => ({
  kind: 'plugin',
  plugin: 'behavior-correction',
  form: 'notice',
  summary,
})

describe('empty-answer detection', () => {
  it('corrects a whitespace-only closing answer and lets the turn continue', async () => {
    const ctx = await harness()
    const agent = startAgent(ctx, new MockAdapter([
      textResponse('   '),
      textResponse('here is the real answer'),
    ]), 'bc-empty')
    await agent.whenIdle()

    const found = corrections(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toContain('previous response was empty')
    expect(found[0]!.source).toEqual(guardSource('empty-answer'))
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'here is the real answer' }],
    })
  })

  it('gives up after maxConsecutiveEmpty empty closings', async () => {
    const ctx = await harness({ maxCorrectionsPerTurn: 5, maxConsecutiveEmpty: 3 })
    const agent = startAgent(ctx, new MockAdapter([
      textResponse(''),
      textResponse(''),
      textResponse(''),
      textResponse(''),
    ]), 'bc-empty-cap')
    await agent.whenIdle()

    // Corrections on the first two empty closings; the third hits the
    // consecutive cap and the turn closes on the fourth empty answer.
    expect(corrections(agent)).toHaveLength(2)
  })
})

describe('unexecuted-code detection', () => {
  it('corrects a fenced code block in a tool-free turn', async () => {
    const ctx = await harness()
    const agent = startAgent(ctx, new MockAdapter([
      textResponse('Run this:\n```sh\nrm -rf node_modules\n```'),
      textResponse('calling the tool instead'),
    ]), 'bc-code')
    await agent.whenIdle()

    const found = corrections(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toContain('did not call any tool')
    expect(found[0]!.source).toEqual(guardSource('unexecuted-code'))
  })

  it('ignores a fenced code block when the turn already made tool calls', async () => {
    const ctx = await harness()
    const agent = startAgent(ctx, new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      textResponse('As the output shows:\n```\nok\n```'),
    ]), 'bc-code-with-tools')
    await agent.whenIdle()

    expect(corrections(agent)).toHaveLength(0)
  })

  it('ignores non-text blocks when judging the closing answer', async () => {
    const reasoningThenCode: StreamChunk[] = [
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'thinking' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: '```sh\nrun me\n```' },
      { type: 'block-end', index: 1, block: { type: 'text', text: '```sh\nrun me\n```' } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    const ctx = await harness()
    const agent = startAgent(ctx, new MockAdapter([
      reasoningThenCode,
      textResponse('calling the tool instead'),
    ]), 'bc-reasoning')
    await agent.whenIdle()

    expect(corrections(agent).map(entry => entry.source)).toEqual([guardSource('unexecuted-code')])
  })

  it('does not correct a max-tokens cutoff (that boundary belongs to the token budget)', async () => {
    const ctx = await harness()
    const agent = startAgent(ctx, new MockAdapter([
      maxTokensResponse('```sh\npartial'),
    ]), 'bc-max-tokens')
    await agent.whenIdle()

    expect(corrections(agent)).toHaveLength(0)
  })
})

describe('unverified-completion detection', () => {
  it('challenges a completion claim when an earlier turn used tools but this one did not', async () => {
    const ctx = await harness()
    const adapter = new MockAdapter([
      toolCallResponse('c1', 'probe', {}),
      textResponse('first step done'),
      textResponse('The task is complete.'),
      textResponse('verified by running the tests'),
    ])
    const agent = startAgent(ctx, adapter, 'bc-completion')
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'wrap up' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    const found = corrections(agent)
    expect(found).toHaveLength(1)
    expect(found[0]!.text).toContain('no tool call that verifies')
    expect(found[0]!.source).toEqual(guardSource('unverified-completion'))
  })

  it('ignores a completion claim in a session that never used tools', async () => {
    const ctx = await harness()
    const agent = startAgent(ctx, new MockAdapter([
      textResponse('All done.'),
    ]), 'bc-completion-no-tools')
    await agent.whenIdle()

    expect(corrections(agent)).toHaveLength(0)
  })
})

describe('correction bounds and toggles', () => {
  it('corrects at most maxCorrectionsPerTurn times per turn', async () => {
    const ctx = await harness({ maxCorrectionsPerTurn: 1 })
    const agent = startAgent(ctx, new MockAdapter([
      textResponse('```sh\nfirst\n```'),
      textResponse('```sh\nsecond\n```'),
    ]), 'bc-turn-cap')
    await agent.whenIdle()

    expect(corrections(agent)).toHaveLength(1)
  })

  it('respects detector toggles', async () => {
    const ctx = await harness({ unexecutedCode: false, unverifiedCompletion: false, emptyAnswer: false })
    const agent = startAgent(ctx, new MockAdapter([
      textResponse('```sh\nrm x\n```'),
    ]), 'bc-toggles')
    await agent.whenIdle()

    expect(corrections(agent)).toHaveLength(0)
  })
  it('allows empty completionPatterns when the completion detector is off', async () => {
    const ctx = await harness({ completionPatterns: [], unverifiedCompletion: false })
    const agent = startAgent(ctx, new MockAdapter([
      textResponse('The task is complete.'),
    ]), 'bc-patterns-off')
    await agent.whenIdle()

    expect(corrections(agent)).toHaveLength(0)
  })
})

describe('fail-loud config validation', () => {
  it.each([
    [{ maxCorrectionsPerTurn: 0 }, /maxCorrectionsPerTurn/],
    [{ maxCorrectionsPerTurn: 1.5 }, /maxCorrectionsPerTurn/],
    [{ maxConsecutiveEmpty: 1 }, /maxConsecutiveEmpty/],
    [{ completionPatterns: ['(['] }, /does not compile/],
    [{ completionPatterns: [''] }, /empty patterns/],
    [{ completionPatterns: [], unverifiedCompletion: true }, /must not be empty/],
  ])('rejects invalid config %#', async (config, message) => {
    await expect(harness(config)).rejects.toThrow(message)
  })
})
