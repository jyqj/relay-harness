/** Purpose gating, durable exchange selection, compaction approval, budgets, and replay. */

import { Context } from '@relay-harness/cordis'
import { describe, expect, it } from 'vitest'
import { CompactionId, compactCheckpointSource } from '@relay-harness/rlh-compaction'
import ContextEngine from '@relay-harness/rlh-context-engine'
import { createAssistantMessage, createUserMessage } from '@relay-harness/rlh-llm'
import SessionStore, { SessionId, type Session } from '@relay-harness/rlh-session'
import TokenMeter from '@relay-harness/rlh-token-meter'
import SessionHistoryContext, {
  type Config,
} from '../src/index.ts'

interface HistoryRecord {
  kind: 'exchange' | 'checkpoint'
  turn?: number
  compactionId?: string
  text: string
  truncated: boolean
}

async function bench(config: Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(TokenMeter)
  await ctx.plugin(ContextEngine)
  await ctx.plugin(SessionHistoryContext, config)
  return ctx
}

function appendTurn(
  session: Session,
  turn: number,
  user: string,
  assistant: string,
  outcome: 'completed' | 'failed' = 'completed',
  injected?: string,
): { userSeq: number; assistantSeq: number } {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  const userEvent = session.append('user/message', createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: user }],
  }), { surfaceOp: 'append' })
  if (injected !== undefined) {
    session.append('user/message', createUserMessage({
      source: { kind: 'plugin', plugin: 'recursive-context', form: 'recall' },
      content: [{ type: 'text', text: injected }],
    }), { surfaceOp: 'append' })
  }
  const assistantEvent = session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      source: { provider: 'fixture', model: 'fixture' },
      content: [{ type: 'text', text: assistant }],
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', outcome === 'completed'
    ? { turn, reason: { kind: 'completed' } }
    : { turn, reason: { kind: 'error', error: { code: 'FAILED', message: 'fixture failed' } } })
  return { userSeq: userEvent.seq, assistantSeq: assistantEvent.seq }
}

function prepare(ctx: Context, session: Session, purpose: 'agent_step' | 'prompt_enhancement' = 'prompt_enhancement') {
  return ctx.contextEngine.prepareStep({
    purpose,
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'draft' }] })],
    signal: new AbortController().signal,
    cwd: session.header.cwd ?? '/workspace',
    caller: {
      sessionId: session.id,
      agentId: session.id,
      workspaceId: session.header.cwd ?? 'global',
    },
  })
}

function recordsOf(text: string): HistoryRecord[] {
  const prefix = '<session-history-json>\n'
  const suffix = '\n</session-history-json>'
  const start = text.indexOf(prefix)
  const end = text.lastIndexOf(suffix)
  if (start < 0 || end < 0) throw new Error('missing history JSON envelope')
  return JSON.parse(text.slice(start + prefix.length, end)) as HistoryRecord[]
}

function textOf(prepared: Awaited<ReturnType<typeof prepare>>): string {
  const block = prepared?.messages[0]?.content[0]
  if (block?.type !== 'text') throw new Error('expected one text contribution')
  return block.text
}

describe('SessionHistoryContextContributor', () => {
  it('declines agent steps and contributes nothing for an empty Session', async () => {
    const ctx = await bench()
    const empty = ctx.sessions.create(SessionId('history-empty'), { meta: { cwd: '/workspace' } })
    await expect(prepare(ctx, empty, 'agent_step')).resolves.toBeUndefined()
    await expect(prepare(ctx, empty)).resolves.toBeUndefined()
  })

  it('selects completed direct-user/model exchanges in chronological order and excludes recursion and failed turns', async () => {
    const ctx = await bench()
    const session = ctx.sessions.create(SessionId('history-selection'), { meta: { cwd: '/workspace' } })
    const first = appendTurn(session, 1, 'first user', 'first assistant', 'completed', 'DO NOT RECURSE')
    const second = appendTurn(session, 2, 'second user', 'second assistant')
    const editedSecond = session.append('user/message', createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'second user edited' }],
    }), {
      surfaceOp: { op: 'replace', start: second.userSeq, end: second.userSeq },
      sourceEventSeqs: [second.userSeq],
    })
    appendTurn(session, 3, 'failed user', 'failed assistant', 'failed')

    const prepared = await prepare(ctx, session)
    const records = recordsOf(textOf(prepared))

    expect(records).toEqual([
      { kind: 'exchange', turn: 1, text: 'User:\nfirst user\n\nAssistant:\nfirst assistant', truncated: false },
      { kind: 'exchange', turn: 2, text: 'User:\nsecond user edited\n\nAssistant:\nsecond assistant', truncated: false },
    ])
    expect(textOf(prepared)).not.toContain('DO NOT RECURSE')
    expect(textOf(prepared)).not.toContain('failed user')
    expect(prepared?.evidence.map(item => item.resource.key)).toEqual([
      `session/${session.id}/event/${first.userSeq}`,
      `session/${session.id}/event/${first.assistantSeq}`,
      `session/${session.id}/event/${editedSecond.seq}`,
      `session/${session.id}/event/${second.assistantSeq}`,
    ])
    expect(prepared?.evidence.every(item => item.freshness === 'current'
      && item.verification === 'verified')).toBe(true)
    expect(prepared?.evidence[0]?.domain).toMatchObject({
      role: 'user', turn: 1,
      selectionReasons: ['current-surface', 'completed-turn', 'direct-user-and-model-exchange', 'within-history-budget'],
    })
    expect(prepared?.coverage[0]).toMatchObject({ completeness: 'bounded' })
    expect(prepared?.coverage[0]?.notSearched).toContain(
      'recall and injected context messages (excluded to prevent recursive context)',
    )
  })

  it('admits only a successfully closed compaction checkpoint and keeps its surface chronology', async () => {
    const ctx = await bench()
    const session = ctx.sessions.create(SessionId('history-compaction'), { meta: { cwd: '/workspace' } })
    const shadowed = appendTurn(session, 1, 'old user', 'old assistant')
    const compactionId = CompactionId('compact-approved')
    const start = session.append('compaction/start', { compactionId, turn: null })
    const summary = session.append('compaction/summary', {
      compactionId,
      summary: [{ type: 'text', text: 'approved checkpoint' }],
      shadowedRange: { start: shadowed.userSeq, end: shadowed.assistantSeq },
      shadowedSeqs: [shadowed.userSeq, shadowed.assistantSeq],
      shadowedTokenCount: 100,
      provider: 'fixture',
      model: 'fixture',
    })
    const checkpoint = session.append('user/message', createUserMessage({
      source: compactCheckpointSource(compactionId),
      content: [{ type: 'text', text: 'approved checkpoint' }],
    }), {
      surfaceOp: { op: 'replace', start: shadowed.userSeq, end: shadowed.assistantSeq },
      sourceEventSeqs: [start.seq, summary.seq, shadowed.userSeq, shadowed.assistantSeq],
    })
    session.append('compaction/end', { compactionId, turn: null })
    appendTurn(session, 2, 'new user', 'new assistant')

    const prepared = await prepare(ctx, session)
    expect(recordsOf(textOf(prepared))).toEqual([
      {
        kind: 'checkpoint', compactionId: 'compact-approved',
        text: 'approved checkpoint', truncated: false,
      },
      { kind: 'exchange', turn: 2, text: 'User:\nnew user\n\nAssistant:\nnew assistant', truncated: false },
    ])
    expect(prepared?.evidence[0]?.resource.key).toBe(`session/${session.id}/event/${checkpoint.seq}`)
    expect(prepared?.evidence[0]?.domain).toMatchObject({
      role: 'checkpoint', compactionId: 'compact-approved',
      selectionReasons: ['current-surface', 'approved-compaction-checkpoint', 'within-history-budget'],
    })

    const failed = ctx.sessions.create(SessionId('history-compaction-failed'), { meta: { cwd: '/workspace' } })
    const failedShadow = appendTurn(failed, 1, 'will be shadowed', 'will be shadowed')
    const failedId = CompactionId('compact-failed')
    const failedStart = failed.append('compaction/start', { compactionId: failedId, turn: null })
    const failedSummary = failed.append('compaction/summary', {
      compactionId: failedId,
      summary: [{ type: 'text', text: 'unapproved checkpoint' }],
      shadowedRange: { start: failedShadow.userSeq, end: failedShadow.assistantSeq },
      shadowedSeqs: [failedShadow.userSeq, failedShadow.assistantSeq],
      shadowedTokenCount: 100,
      provider: 'fixture',
      model: 'fixture',
    })
    failed.append('user/message', createUserMessage({
      source: compactCheckpointSource(failedId),
      content: [{ type: 'text', text: 'unapproved checkpoint' }],
    }), {
      surfaceOp: { op: 'replace', start: failedShadow.userSeq, end: failedShadow.assistantSeq },
      sourceEventSeqs: [
        failedStart.seq, failedSummary.seq, failedShadow.userSeq, failedShadow.assistantSeq,
      ],
    })
    failed.append('compaction/end', { compactionId: failedId, turn: null, error: 'commit failed' })
    await expect(prepare(ctx, failed)).resolves.toBeUndefined()
  })

  it('selects the newest exchange, clips it under both budgets, and explains omissions', async () => {
    const ctx = await bench({ maxExchanges: 1, maxChars: 520, maxTokens: 1_000 })
    const session = ctx.sessions.create(SessionId('history-budget'), { meta: { cwd: '/workspace' } })
    appendTurn(session, 1, 'old user', 'old assistant')
    appendTurn(session, 2, 'new user', `new assistant ${'x'.repeat(2_000)}`)

    const prepared = await prepare(ctx, session)
    const text = textOf(prepared)
    const records = recordsOf(text)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ kind: 'exchange', turn: 2, truncated: true })
    expect(records[0]?.text).toContain('…[history excerpt truncated]')
    expect(Array.from(text)).toHaveLength(520)
    expect(ctx.tokenMeter.estimateMessage(prepared!.messages[0]!)).toBeLessThanOrEqual(1_000)
    expect(prepared?.evidence.every(item => item.truncated)).toBe(true)
    expect(prepared?.coverage[0]).toMatchObject({ completeness: 'bounded' })
    expect(prepared?.coverage[0]?.notSearched).toContain('1 older eligible history unit(s) omitted by recency/budget')
    expect(prepared?.coverage[0]?.rationale).toContain('1 selected unit(s) required clipping')

    const tokenCtx = await bench({ maxExchanges: 2, maxChars: 2_000, maxTokens: 256 })
    const tokenSession = tokenCtx.sessions.create(SessionId('history-token-budget'), {
      meta: { cwd: '/workspace' },
    })
    appendTurn(tokenSession, 1, 'token user', `token assistant ${'y'.repeat(4_000)}`)
    const tokenPrepared = await prepare(tokenCtx, tokenSession)
    expect(recordsOf(textOf(tokenPrepared))[0]).toMatchObject({ truncated: true })
    expect(Array.from(textOf(tokenPrepared)).length).toBeLessThan(2_000)
    expect(tokenCtx.tokenMeter.estimateMessage(tokenPrepared!.messages[0]!)).toBeLessThanOrEqual(256)
  })

  it('replays byte-identical history content, evidence revisions, and coverage from a persisted event seed', async () => {
    const firstCtx = await bench()
    const first = firstCtx.sessions.create(SessionId('history-replay'), { meta: { cwd: '/workspace' } })
    appendTurn(first, 1, 'persist me', 'replay me')
    const original = await prepare(firstCtx, first)

    const secondCtx = await bench()
    const replayed = secondCtx.sessions.create(SessionId('history-replay'), {
      seed: structuredClone(first.events),
      meta: { cwd: '/workspace' },
    })
    const replay = await prepare(secondCtx, replayed)

    expect(textOf(replay)).toBe(textOf(original))
    expect(replay?.evidence).toEqual(original?.evidence)
    expect(replay?.coverage).toEqual(original?.coverage)
  })
})
