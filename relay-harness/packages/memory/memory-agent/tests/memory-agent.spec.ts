import { Context } from '@relay-harness/cordis'
import { createAssistantMessage, createUserMessage } from '@relay-harness/rlh-llm'
import LongTermMemory, { MemoryId, MemoryTurnHandle } from '@relay-harness/rlh-memory'
import type {
  AbortMemoryTurnInput,
  CommitMemoryTurnInput,
  ForgetMemoryInput,
  MemoryEntry,
  MemoryScope,
  PrepareMemoryTurnInput,
  PreparedMemoryTurn,
  RememberMemoryInput,
  ReviseMemoryInput,
  SearchMemoryInput,
} from '@relay-harness/rlh-memory/types'
import * as MemoryAgent from '@relay-harness/rlh-memory-agent'
import SessionStore, { Session, SessionId } from '@relay-harness/rlh-session'
import type { Agent } from '@relay-harness/rlh-agent'
import { describe, expect, it } from 'vitest'

const scope: MemoryScope = { workspaceId: '/workspace', userId: 'local', agentId: 'relay-harness' }

class FakeMemory extends LongTermMemory {
  prepared: PreparedMemoryTurn[] = []
  committed: CommitMemoryTurnInput[] = []
  aborted: AbortMemoryTurnInput[] = []
  failure: Error | undefined
  candidateContent = 'Use explicit file context for referenced files.'

  prepare(input: PrepareMemoryTurnInput): Promise<PreparedMemoryTurn> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const prepared: PreparedMemoryTurn = {
      handle: MemoryTurnHandle(`turn-${input.turn}`),
      scope: input.scope,
      sessionId: input.sessionId,
      turn: input.turn,
      query: input.query,
      candidates: [{
        entry: entry(this.candidateContent),
        score: 0.9,
        matchedBy: ['fts_unicode'],
      }],
    }
    this.prepared.push(prepared)
    return Promise.resolve(prepared)
  }

  commit(input: CommitMemoryTurnInput): Promise<void> {
    this.committed.push(input)
    return Promise.resolve()
  }

  abort(input: AbortMemoryTurnInput): Promise<void> {
    this.aborted.push(input)
    return Promise.resolve()
  }

  remember(_input: RememberMemoryInput): Promise<MemoryEntry> {
    return Promise.resolve(entry('remembered'))
  }

  revise(_input: ReviseMemoryInput): Promise<MemoryEntry> {
    return Promise.resolve(entry('revised'))
  }

  forget(_input: ForgetMemoryInput): Promise<MemoryEntry> {
    return Promise.resolve({ ...entry('forgotten'), status: 'tombstoned' })
  }

  read(): Promise<MemoryEntry | undefined> {
    return Promise.resolve(undefined)
  }

  search(_input: SearchMemoryInput): Promise<[]> {
    return Promise.resolve([])
  }
}

function entry(content: string): MemoryEntry {
  return {
    id: MemoryId('memory-1'),
    revision: 1,
    scope,
    kind: 'constraint',
    status: 'active',
    trust: 'user-stated',
    content,
    importance: 4,
    confidence: 1,
    createdAt: 1,
    updatedAt: 2,
    evidence: [{ sessionId: SessionId('source'), eventSeqs: [1], verification: 'user-statement' }],
    accessCount: 0,
    usefulAccessCount: 0,
  }
}

async function harness(config: MemoryAgent.Config = {}): Promise<{
  ctx: Context
  provider: FakeMemory
  session: Session
  agent: Agent
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(FakeMemory)
  await ctx.plugin(MemoryAgent, config)
  const session = ctx.sessions.create(SessionId('session'), { meta: { cwd: '/workspace' } })
  const agent = { id: session.id, session } as Agent
  return { ctx, provider: ctx.longTermMemory as FakeMemory, session, agent }
}

async function prepare(ctx: Context, agent: Agent, turn = 1) {
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'How should files be referenced?' }] })
  return ctx.waterfall(
    'agent/pre-step',
    { agent, messages: [message], turn, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [message] }),
  )
}

function appendAssistant(session: Session, turn: number): string {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  const message = createAssistantMessage({
    content: [{ type: 'text', text: 'Use explicit File Context.' }],
    source: { provider: 'test', model: 'test' },
  })
  session.append('assistant/message', { turn, step: 1, message }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  return message.id
}

describe('memory Agent Consumer', () => {
  it('adds separately sourced recall context and commits after the final turn event', async () => {
    const { ctx, provider, session, agent } = await harness()
    const decision = await prepare(ctx, agent)
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[0]?.source.kind).toBe('user')
    expect(decision.messages[1]?.source).toMatchObject({ kind: 'memory-recall', form: 'recall', version: 1 })
    const recallBlock = decision.messages[1]?.content[0]
    expect(recallBlock?.type).toBe('text')
    expect(recallBlock?.type === 'text' ? recallBlock.text : '').toContain('untrusted')

    const assistantMessageId = appendAssistant(session, 1)
    ctx.emit('session/event', session, {
      type: 'turn/end', seq: session.events.length, time: 3, data: { turn: 1, reason: { kind: 'completed' } },
    })
    await ctx.fiber.dispose()
    expect(provider.committed).toHaveLength(1)
    expect(provider.committed[0]).toMatchObject({
      recalledMemoryIds: [MemoryId('memory-1')],
      assistantMessageId,
    })
    expect(provider.aborted).toEqual([])
  })

  it('aborts non-success turns and every pending turn on unload', async () => {
    const { ctx, provider, session, agent } = await harness()
    await prepare(ctx, agent, 1)
    ctx.emit('session/event', session, {
      type: 'turn/end', seq: 0, time: 1, data: {
        turn: 1,
        reason: { kind: 'error', error: { message: 'failed', code: 'TEST' } },
      },
    })
    await prepare(ctx, agent, 2)
    await ctx.fiber.dispose()
    expect(provider.aborted.map(item => item.reason).sort()).toEqual(['consumer-unloaded', 'host-turn-error'])
    expect(provider.committed).toEqual([])
  })

  it('fails open when recall preparation fails', async () => {
    const { ctx, provider, agent } = await harness()
    provider.failure = new Error('offline')
    const decision = await prepare(ctx, agent)
    expect(decision.kind === 'enter' ? decision.messages : []).toHaveLength(1)
    await ctx.fiber.dispose()
  })

  it('packs astral-plane recall content by Unicode code points', async () => {
    const { ctx, provider, agent } = await harness()
    provider.candidateContent = '🎉'.repeat(1_900)
    const decision = await prepare(ctx, agent)
    expect(decision.kind).toBe('enter')
    if (decision.kind !== 'enter') throw new Error('expected enter')
    expect(decision.messages).toHaveLength(2)
    const recallBlock = decision.messages[1]?.content[0]
    expect(recallBlock?.type).toBe('text')
    const text = recallBlock?.type === 'text' ? recallBlock.text : ''
    expect(Array.from(text).length).toBeLessThanOrEqual(3_200)
    expect(text).toContain('🎉')
    expect(text.isWellFormed()).toBe(true)
    await ctx.fiber.dispose()
  })

  it('skips delegated subagents unless explicitly enabled', async () => {
    const { ctx, provider } = await harness()
    const child = ctx.sessions.create(SessionId('child'), { meta: { cwd: '/workspace', origin: 'subagent' } })
    await prepare(ctx, { id: child.id, session: child } as Agent)
    expect(provider.prepared).toEqual([])
    await ctx.fiber.dispose()
  })
})
