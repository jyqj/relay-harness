import { Context } from '@relay-harness/cordis'
import ContextEngine, { type PreparedStepContext } from '@relay-harness/rlh-context-engine'
import { createAssistantMessage, createUserMessage } from '@relay-harness/rlh-llm'
import LongTermMemory, { MemoryId, MemoryTurnHandle } from '@relay-harness/rlh-memory'
import type {
  AbortMemoryTurnInput,
  CommitMemoryTurnInput,
  ForgetMemoryInput,
  MemoryListPage,
  MemoryConflictCandidate,
  MemoryOutcome,
  MemorySignal,
  MemoryEntry,
  MemorySearchHit,
  MemoryScope,
  PrepareMemoryTurnInput,
  PreparedMemoryTurn,
  RememberMemoryInput,
  ReviseMemoryInput,
  SearchMemoryInput,
} from '@relay-harness/rlh-memory/types'
import * as MemoryAgent from '@relay-harness/rlh-memory-agent'
import SessionStore, { Session, SessionId } from '@relay-harness/rlh-session'
import { describe, expect, it } from 'vitest'

const scope: MemoryScope = { workspaceId: '/workspace', userId: 'local', agentId: 'relay-harness' }

class FakeMemory extends LongTermMemory {
  prepared: PreparedMemoryTurn[] = []
  committed: CommitMemoryTurnInput[] = []
  aborted: AbortMemoryTurnInput[] = []
  failure: Error | undefined
  candidateContent = 'Use explicit file context for referenced files.'
  searches: SearchMemoryInput[] = []
  poisonAfterPrepare = false

  prepare(input: PrepareMemoryTurnInput): Promise<PreparedMemoryTurn> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    const candidate = entry(this.candidateContent)
    if (this.poisonAfterPrepare) {
      Object.defineProperty(candidate, 'content', { get: () => { throw new Error('render failed') } })
    }
    const prepared: PreparedMemoryTurn = {
      handle: MemoryTurnHandle(`turn-${input.turn}`),
      scope: input.scope,
      sessionId: input.sessionId,
      turn: input.turn,
      query: input.query,
      candidates: [{
        entry: candidate,
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

  list(): Promise<MemoryListPage> {
    return Promise.resolve({ entries: [], total: 0, offset: 0, hasMore: false })
  }

  findConflicts(): Promise<readonly MemoryConflictCandidate[]> { return Promise.resolve([]) }
  listSignals(): Promise<readonly MemorySignal[]> { return Promise.resolve([]) }
  reconcileOutcomes(): Promise<void> { return Promise.resolve() }
  listOutcomes(): Promise<readonly MemoryOutcome[]> { return Promise.resolve([]) }

  search(input: SearchMemoryInput): Promise<MemorySearchHit[]> {
    this.searches.push(input)
    return Promise.resolve([{
      entry: entry(this.candidateContent),
      score: 0.9,
      matchedBy: ['fts_unicode'],
    }])
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
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(ContextEngine)
  await ctx.plugin(FakeMemory)
  await ctx.plugin(MemoryAgent, config)
  const session = ctx.sessions.create(SessionId('session'), { meta: { cwd: '/workspace' } })
  return { ctx, provider: ctx.longTermMemory as FakeMemory, session }
}

async function prepare(ctx: Context, session: Session, turn = 1, origin?: 'subagent') {
  const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'How should files be referenced?' }] })
  return ctx.contextEngine.prepareStep({
    purpose: 'agent_step',
    messages: [message],
    signal: new AbortController().signal,
    cwd: '/workspace',
    caller: {
      sessionId: session.id,
      agentId: session.id,
      workspaceId: '/workspace',
      turn,
      step: 1,
      ...origin === undefined ? {} : { origin },
    },
  })
}

function appendAssistant(
  session: Session,
  turn: number,
  prepared: PreparedStepContext,
  admitted = true,
): string {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  const messageEventSeqs = admitted
    ? prepared.contributions.map(contribution =>
      session.append('user/message', contribution.message, { surfaceOp: 'append' }).seq)
    : []
  session.append('context/prepared', {
    turn,
    step: 1,
    plan: prepared.plan,
    decisions: prepared.decisions,
    contributions: prepared.contributions.map((contribution, index) => ({
      contributorId: contribution.contributorId,
      messageId: contribution.message.id,
      messageEventSeqs: admitted ? [messageEventSeqs[index] as number] : [],
      evidence: contribution.evidence,
      ...contribution.coverage === undefined ? {} : { coverage: contribution.coverage },
    })),
  })
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
    const { ctx, provider, session } = await harness()
    const prepared = await prepare(ctx, session)
    expect(prepared?.messages).toHaveLength(1)
    if (prepared === undefined) throw new Error('expected prepared context')
    expect(prepared.messages[0]?.source).toMatchObject({ kind: 'memory-recall', form: 'recall', version: 1 })
    expect(prepared.evidence[0]).toMatchObject({
      resource: { sourceId: 'long-term-memory', key: 'memory-1', revision: '1' },
      freshness: 'current',
      verification: 'verified',
    })
    expect(prepared.coverage[0]?.completeness).toBe('bounded')
    const recallBlock = prepared.messages[0]?.content[0]
    expect(recallBlock?.type).toBe('text')
    expect(recallBlock?.type === 'text' ? recallBlock.text : '').toContain('untrusted')

    const assistantMessageId = appendAssistant(session, 1, prepared)
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
    const { ctx, provider, session } = await harness()
    await prepare(ctx, session, 1)
    ctx.emit('session/event', session, {
      type: 'turn/end', seq: 0, time: 1, data: {
        turn: 1,
        reason: { kind: 'error', error: { message: 'failed', code: 'TEST' } },
      },
    })
    await prepare(ctx, session, 2)
    await ctx.fiber.dispose()
    expect(provider.aborted.map(item => item.reason).sort()).toEqual(['consumer-unloaded', 'host-turn-error'])
    expect(provider.committed).toEqual([])
  })

  it('fails open when recall preparation fails', async () => {
    const { ctx, provider, session } = await harness()
    provider.failure = new Error('offline')
    const prepared = await prepare(ctx, session)
    expect(prepared).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('aborts a prepared observation when contribution rendering fails before pending ownership', async () => {
    const { ctx, provider, session } = await harness()
    provider.poisonAfterPrepare = true
    await expect(prepare(ctx, session)).resolves.toBeUndefined()
    expect(provider.aborted).toEqual([
      expect.objectContaining({ reason: 'context-contribution-failed' }),
    ])
    await ctx.fiber.dispose()
  })

  it('packs astral-plane recall content by Unicode code points', async () => {
    const { ctx, provider, session } = await harness()
    provider.candidateContent = '🎉'.repeat(1_900)
    const prepared = await prepare(ctx, session)
    if (prepared === undefined) throw new Error('expected prepared context')
    expect(prepared.messages).toHaveLength(1)
    const recallBlock = prepared.messages[0]?.content[0]
    expect(recallBlock?.type).toBe('text')
    const text = recallBlock?.type === 'text' ? recallBlock.text : ''
    expect(Array.from(text).length).toBeLessThanOrEqual(3_200)
    expect(text).toContain('🎉')
    expect(text.isWellFormed()).toBe(true)
    await ctx.fiber.dispose()
  })

  it('skips delegated subagents unless explicitly enabled', async () => {
    const { ctx, provider, session } = await harness()
    await prepare(ctx, session, 1, 'subagent')
    expect(provider.prepared).toEqual([])
    await ctx.fiber.dispose()
  })

  it('derives the recall partition from detached caller workspace identity', async () => {
    const { ctx, provider, session } = await harness()
    const message = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Recall this scope' }] })
    await ctx.contextEngine.prepareStep({
      purpose: 'agent_step', messages: [message], signal: new AbortController().signal, cwd: '/filesystem-view',
      caller: { sessionId: session.id, agentId: session.id, workspaceId: '/authoritative-workspace', turn: 1, step: 1 },
    })
    expect(provider.prepared[0]?.scope).toEqual({
      workspaceId: '/authoritative-workspace', userId: 'local', agentId: 'relay-harness',
    })
    await ctx.fiber.dispose()
  })

  it('applies the durable preset allowlist to Agent and Prompt Enhancement preparation', async () => {
    const { ctx, provider, session } = await harness({ agentPresets: ['standard'] })
    const message = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'How should files be referenced?' }],
    })
    const denied = await ctx.contextEngine.prepareStep({
      purpose: 'agent_step', messages: [message], signal: new AbortController().signal, cwd: '/workspace',
      caller: {
        sessionId: session.id, agentId: session.id, workspaceId: '/workspace',
        turn: 1, step: 1, agentPreset: 'minimal',
      },
    })
    const allowed = await ctx.contextEngine.prepareStep({
      purpose: 'prompt_enhancement', messages: [message], signal: new AbortController().signal, cwd: '/workspace',
      caller: {
        sessionId: session.id, agentId: session.id, workspaceId: '/workspace', agentPreset: 'standard',
      },
    })
    expect(denied).toBeUndefined()
    expect(provider.prepared).toEqual([])
    expect(allowed?.messages[0]?.source.kind).toBe('memory-recall')
    await ctx.fiber.dispose()
  })

  it('retrieves Prompt Enhancement memory without preparing a turn or mutating search accounting', async () => {
    const { ctx, provider, session } = await harness()
    const message = createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Improve my explicit file context request' }],
    })
    const prepared = await ctx.contextEngine.prepareStep({
      purpose: 'prompt_enhancement',
      messages: [message],
      signal: new AbortController().signal,
      cwd: '/workspace',
      caller: { sessionId: session.id, agentId: session.id, workspaceId: '/workspace' },
    })
    expect(prepared?.messages[0]?.source.kind).toBe('memory-recall')
    expect(provider.prepared).toEqual([])
    expect(provider.searches).toHaveLength(1)
    expect(provider.searches[0]).toMatchObject({ statuses: ['active'], recordAccess: false })
    await ctx.fiber.dispose()
  })

  it('commits no injected ids when downstream admission removes the recall proposal', async () => {
    const { ctx, provider, session } = await harness()
    const prepared = await prepare(ctx, session)
    if (prepared === undefined) throw new Error('expected prepared context')
    appendAssistant(session, 1, prepared, false)
    ctx.emit('session/event', session, {
      type: 'turn/end', seq: session.events.length, time: 3, data: { turn: 1, reason: { kind: 'completed' } },
    })
    await ctx.fiber.dispose()
    expect(provider.committed[0]?.recalledMemoryIds).toEqual([])
  })
})
