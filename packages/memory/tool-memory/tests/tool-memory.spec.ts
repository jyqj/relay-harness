import { Context } from '@relay-harness/cordis'
import { CallId, createToolResultMessage, createUserMessage } from '@relay-harness/rlh-llm'
import SqliteLongTermMemory from '@relay-harness/rlh-memory-sqlite'
import * as ToolMemory from '@relay-harness/rlh-tool-memory'
import SessionStore, { Session, SessionId } from '@relay-harness/rlh-session'
import SystemPrompt from '@relay-harness/rlh-system-prompt'
import ToolRuntime from '@relay-harness/rlh-tools'
import type { Agent } from '@relay-harness/rlh-agent'
import { describe, expect, it } from 'vitest'

async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(SqliteLongTermMemory, { path: ':memory:' })
  await ctx.plugin(ToolMemory)
  return ctx
}

function agentWithPrompt(text: string): Agent & { session: Session } {
  const id = SessionId(`memory-tool-${crypto.randomUUID()}`)
  const session = Session.create(id, [], { version: 0, id, createdAt: 1, cwd: '/workspace' })
  session.append('user/message', createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }), { surfaceOp: 'append' })
  return { id, session } as Agent & { session: Session }
}

let callCounter = 0
async function call(ctx: Context, agent: Agent & { session: Session }, name: string, args: unknown) {
  const callId = CallId(`memory-call-${++callCounter}`)
  agent.session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) })
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId,
    name,
    arguments: args,
    agent,
  })
}

function appendSuccessfulResult(
  agent: Agent & { session: Session },
  name: string,
  text: string,
): void {
  const callId = CallId(`memory-result-${++callCounter}`)
  const call = agent.session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: '{}' })
  agent.session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError: false }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
}

function value(result: Awaited<ReturnType<typeof call>>): string {
  if (result.isError) throw new Error(result.content.map(block => block.type === 'text' ? block.text : '').join(''))
  return result.value as string
}

describe('memory tools', () => {
  it('registers the complete tool set and removes it with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(SqliteLongTermMemory, { path: ':memory:' })
    const fiber = await ctx.plugin(ToolMemory)
    expect(ctx.tools.schemas().map(tool => tool.name)).toEqual([
      'memory_search',
      'memory_read',
      'memory_remember',
      'memory_update',
      'memory_forget',
    ])
    await fiber.dispose()
    expect(ctx.tools.schemas()).toEqual([])
    await ctx.fiber.dispose()
  })

  it('activates a user-supported memory and recalls it through search and read', async () => {
    const ctx = await harness()
    const agent = agentWithPrompt('Remember that my validation drink is lapsang souchong.')
    const remembered = JSON.parse(value(await call(ctx, agent, 'memory_remember', {
      kind: 'preference',
      content: 'The user validation drink is lapsang souchong.',
      summary: 'Validation drink: lapsang souchong',
      importance: 3,
      evidence_quote: 'my validation drink is lapsang souchong',
    }))) as { id: string; status: string; trust: string }
    expect(remembered).toMatchObject({ status: 'active', trust: 'user-stated' })

    const searched = JSON.parse(value(await call(ctx, agent, 'memory_search', {
      query: 'validation drink',
    }))) as Array<{ id: string; content: string }>
    expect(searched).toEqual([expect.objectContaining({ id: remembered.id })])
    const read = JSON.parse(value(await call(ctx, agent, 'memory_read', { id: remembered.id }))) as { content: string }
    expect(read.content).toContain('lapsang')
    await ctx.fiber.dispose()
  })

  it('keeps unverified proposals as candidates and rejects fabricated evidence quotes', async () => {
    const ctx = await harness()
    const agent = agentWithPrompt('Investigate the deployment.')
    const proposed = JSON.parse(value(await call(ctx, agent, 'memory_remember', {
      kind: 'fact',
      content: 'The deployment is blue.',
      importance: 2,
    }))) as { id: string; status: string; trust: string }
    expect(proposed).toMatchObject({ status: 'candidate', trust: 'agent-proposed' })
    const active = JSON.parse(value(await call(ctx, agent, 'memory_search', { query: 'blue deployment' }))) as unknown[]
    expect(active).toEqual([])
    const candidates = JSON.parse(value(await call(ctx, agent, 'memory_search', {
      query: 'blue deployment',
      statuses: ['candidate'],
    }))) as Array<{ id: string }>
    expect(candidates).toEqual([expect.objectContaining({ id: proposed.id })])

    const fabricated = await call(ctx, agent, 'memory_remember', {
      kind: 'fact',
      content: 'The deployment is green.',
      importance: 2,
      evidence_quote: 'verified green deployment',
    })
    expect(fabricated.isError).toBe(true)
    await ctx.fiber.dispose()
  })

  it('requires a direct user deletion request before tombstoning', async () => {
    const ctx = await harness()
    const writer = agentWithPrompt('Remember that the project codename is cobalt.')
    const remembered = JSON.parse(value(await call(ctx, writer, 'memory_remember', {
      kind: 'fact',
      content: 'The project codename is cobalt.',
      importance: 2,
      evidence_quote: 'project codename is cobalt',
    }))) as { id: string }

    const unrelated = agentWithPrompt('Review the project.')
    const denied = await call(ctx, unrelated, 'memory_forget', {
      id: remembered.id,
      reason: 'remove it',
      evidence_quote: 'forget cobalt',
    })
    expect(denied.isError).toBe(true)

    const deleter = agentWithPrompt('Please forget cobalt and delete that memory.')
    const forgotten = JSON.parse(value(await call(ctx, deleter, 'memory_forget', {
      id: remembered.id,
      reason: 'user requested deletion',
      evidence_quote: 'forget cobalt',
    }))) as { status: string }
    expect(forgotten.status).toBe('tombstoned')
    await ctx.fiber.dispose()
  })

  it('rejects secret-bearing content at the provider operation', async () => {
    const ctx = await harness()
    const agent = agentWithPrompt('Remember api_key = abcdefghijklmnop')
    const result = await call(ctx, agent, 'memory_remember', {
      kind: 'fact',
      content: 'api_key = abcdefghijklmnop',
      importance: 4,
      evidence_quote: 'api_key = abcdefghijklmnop',
    })
    expect(result.isError).toBe(true)
    expect(result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')).toContain('secret')
    await ctx.fiber.dispose()
  })

  it('activates action-verified memory from a successful non-memory tool result', async () => {
    const ctx = await harness()
    const agent = agentWithPrompt('Check the deployment.')
    appendSuccessfulResult(agent, 'bash', 'deployment color: blue')
    const remembered = JSON.parse(value(await call(ctx, agent, 'memory_remember', {
      kind: 'fact',
      content: 'The deployment is blue.',
      importance: 2,
      evidence_quote: 'deployment color: blue',
    }))) as { status: string; trust: string }
    expect(remembered).toMatchObject({ status: 'active', trust: 'action-verified' })
    await ctx.fiber.dispose()
  })

  it('rejects memory-tool results as activation or update evidence', async () => {
    const ctx = await harness()
    const agent = agentWithPrompt('Remember that the project codename is cobalt.')
    const remembered = JSON.parse(value(await call(ctx, agent, 'memory_remember', {
      kind: 'fact',
      content: 'The project codename is cobalt.',
      importance: 2,
      evidence_quote: 'project codename is cobalt',
    }))) as { id: string }
    appendSuccessfulResult(agent, 'memory_search', 'codename confirmed as cobalt')

    const deniedRemember = await call(ctx, agent, 'memory_remember', {
      kind: 'fact',
      content: 'The project codename is azure.',
      importance: 2,
      evidence_quote: 'codename confirmed as cobalt',
    })
    expect(deniedRemember.isError).toBe(true)
    expect(deniedRemember.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n'))
      .toContain('not found in a direct user message or successful tool result')

    const deniedUpdate = await call(ctx, agent, 'memory_update', {
      id: remembered.id,
      content: 'The project codename is azure.',
      evidence_quote: 'codename confirmed as cobalt',
    })
    expect(deniedUpdate.isError).toBe(true)
    const unchanged = JSON.parse(value(await call(ctx, agent, 'memory_read', { id: remembered.id }))) as { content: string }
    expect(unchanged.content).toContain('cobalt')
    await ctx.fiber.dispose()
  })

  it('compacts search content on Unicode code point boundaries', async () => {
    const ctx = await harness()
    const agent = agentWithPrompt('Remember the celebration banner.')
    await call(ctx, agent, 'memory_remember', {
      kind: 'fact',
      content: `celebration banner ${'🎉'.repeat(400)}`,
      importance: 1,
      evidence_quote: 'celebration banner',
    })
    const searched = JSON.parse(value(await call(ctx, agent, 'memory_search', {
      query: 'celebration banner',
    }))) as Array<{ content: string }>
    const points = Array.from(searched[0]?.content ?? '')
    expect(points).toHaveLength(320)
    expect(points.at(-1)).toBe('…')
    expect(points.slice(19, -1).every(point => point === '🎉')).toBe(true)
    await ctx.fiber.dispose()
  })
})
