import { afterEach, describe, expect, it } from 'vitest'
import { Context, Service } from '@relay-harness/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime, { createUserMessage } from '@relay-harness/rlh-llm'
import SessionStore, { Session, SessionId, type UserMessage } from '@relay-harness/rlh-session'
import SystemPrompt from '@relay-harness/rlh-system-prompt'
import ToolRuntime from '@relay-harness/rlh-tools'
import AgentRegistry, { type Agent } from '@relay-harness/rlh-agent'
import {
  EvidenceId,
  SourceId,
  type CoverageRecord,
  type Evidence,
  type PreparedStepContext,
} from '@relay-harness/rlh-context-engine'
import JsonlSessionPersistence from '@relay-harness/rlh-session-persistence-jsonl'

import AgentLoop from '@relay-harness/rlh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

/**
 * The optional step-context seam: a service registered under `contextEngine` runs between
 * inbox claim and prompt assembly, and its messages append to the step's user messages.
 * Without the service, the loop's behavior is byte-identical. The loop consumes the
 * engine through a structural interface only — these tests register a scripted service,
 * not `@relay-harness/rlh-context-engine` itself.
 */

interface StepCall {
  purpose: 'agent_step'
  messages: readonly UserMessage[]
  signal: AbortSignal
  cwd: string
}

/** A scripted `contextEngine` service: records calls, returns the scripted messages. */
class ScriptedEngine extends Service {
  readonly calls: StepCall[] = []

  constructor(ctx: Context, private readonly result: PreparedStepContext | undefined) {
    super(ctx, 'contextEngine')
  }

  prepareStep(input: { purpose: 'agent_step'; messages: readonly UserMessage[]; signal: AbortSignal; cwd: string }):
  Promise<PreparedStepContext | undefined> {
    this.calls.push(input)
    return Promise.resolve(this.result)
  }
}

/** Build one complete attributed preparation around a model-visible message. */
function prepared(message: UserMessage, evidence: readonly Evidence[] = [], coverage?: CoverageRecord): PreparedStepContext {
  return {
    contributions: [{
      contributorId: 'scripted',
      message,
      evidence,
      ...coverage === undefined ? {} : { coverage },
    }],
    messages: [message],
    evidence,
    coverage: coverage === undefined ? [] : [coverage],
  }
}

const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function harness(adapter: MockAdapter, persistenceRoot?: string) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (persistenceRoot !== undefined) {
    await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot, compression: 'none' })
  }
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function send(agent: Agent, text: string) {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}

function requestTexts(adapter: MockAdapter): string[][] {
  return adapter.requests.map(request =>
    request.messages.map(message =>
      message.content.map(block => (block.type === 'text' ? block.text : '')).join(''),
    ),
  )
}

describe('step-context seam', () => {
  it('appends engine messages after the claimed message and logs them as user/message events', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const contextMessage = createUserMessage({
      content: [{ type: 'text', text: 'context from engine' }],
      source: { kind: 'user' },
    })
    const evidence: Evidence = {
      evidenceId: EvidenceId('scripted:one'),
      resource: { sourceId: SourceId('scripted'), key: 'one', revision: 'r1' },
      digest: 'abc123',
      truncated: false,
      freshness: 'current',
      verification: 'verified',
      domain: { rank: 1 },
    }
    const coverage: CoverageRecord = {
      searched: ['workspace'],
      notSearched: ['outside-workspace'],
      rationale: 'test scope',
      completeness: 'bounded',
    }
    const engine = new ScriptedEngine(ctx, prepared(contextMessage, [evidence], coverage))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    send(agent, 'hello')
    await waitForIdle(ctx, agent)

    expect(engine.calls.length).toBe(1)
    expect(engine.calls[0]!.purpose).toBe('agent_step')
    expect(engine.calls[0]!.messages.map(message =>
      message.content.map(block => (block.type === 'text' ? block.text : '')).join(''),
    )).toEqual(['hello'])
    expect(requestTexts(adapter)).toEqual([['hello', 'context from engine']])
    const logged = [...agent.session.events]
      .filter(event => event.type === 'user/message')
      .map(event => event.type === 'user/message'
        ? event.data.content.map(block => (block.type === 'text' ? block.text : '')).join('')
        : '')
    expect(logged).toEqual(['hello', 'context from engine'])
    const trace = agent.session.events.find(event => event.type === 'context/prepared')
    expect(trace).toMatchObject({
      type: 'context/prepared',
      data: {
        turn: 1,
        step: 1,
        contributions: [{
          contributorId: 'scripted',
          messageId: contextMessage.id,
          evidence: [evidence],
          coverage,
        }],
      },
    })
    if (trace?.type !== 'context/prepared') throw new Error('missing context/prepared')
    const contextEvent = agent.session.events.find(event =>
      event.type === 'user/message' && event.data.id === contextMessage.id)
    expect(trace.data.contributions[0]?.messageEventSeqs).toEqual([contextEvent?.seq])
    expect(contextEvent?.seq).toBeLessThan(trace.seq)
    expect('surfaceOp' in trace).toBe(false)
    expect(trace.seq).toBeLessThan(agent.session.events.find(event => event.type === 'request/header')!.seq)
  })

  it('leaves the request unchanged when the engine declines or is absent', async () => {
    const declining = new MockAdapter([textResponse('ok')])
    const decliningCtx = await harness(declining)
    const decliningEngine = new ScriptedEngine(decliningCtx, undefined)
    const decliningAgent = decliningCtx.agentLoop.create(SessionId('d1'), { provider: 'mock', model: 'mock' })
    send(decliningAgent, 'hello')
    await waitForIdle(decliningCtx, decliningAgent)
    expect(decliningEngine.calls.length).toBe(1)
    expect(requestTexts(declining)).toEqual([['hello']])

    const absent = new MockAdapter([textResponse('ok')])
    const absentCtx = await harness(absent)
    const absentAgent = absentCtx.agentLoop.create(SessionId('a2'), { provider: 'mock', model: 'mock' })
    send(absentAgent, 'hello')
    await waitForIdle(absentCtx, absentAgent)
    expect(requestTexts(absent)).toEqual([['hello']])
  })

  it('keeps evidence but does not link a context proposal rewritten by pre-step', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const contextMessage = createUserMessage({
      content: [{ type: 'text', text: 'original context' }],
      source: { kind: 'user' },
    })
    const evidence: Evidence = {
      evidenceId: EvidenceId('scripted:rewritten'),
      resource: { sourceId: SourceId('scripted'), key: 'rewritten', revision: 'r1' },
      truncated: false,
      freshness: 'current',
      verification: 'verified',
    }
    new ScriptedEngine(ctx, prepared(contextMessage, [evidence]))
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return {
        kind: 'enter' as const,
        messages: decision.messages.map(message => message.id === contextMessage.id
          ? { ...message, content: [{ type: 'text' as const, text: 'rewritten context' }] }
          : message),
      }
    })
    const agent = ctx.agentLoop.create(SessionId('rewritten-context'), { provider: 'mock', model: 'mock' })

    send(agent, 'hello')
    await waitForIdle(ctx, agent)

    expect(requestTexts(adapter)).toEqual([['hello', 'rewritten context']])
    const trace = agent.session.events.find(event => event.type === 'context/prepared')
    if (trace?.type !== 'context/prepared') throw new Error('missing context/prepared')
    expect(trace.data.contributions).toEqual([{
      contributorId: 'scripted',
      messageId: contextMessage.id,
      messageEventSeqs: [],
      evidence: [evidence],
    }])
  })

  it('links a structurally identical proposal when pre-step only changes JSON property order', async () => {
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(adapter)
    const contextMessage = createUserMessage({
      content: [{ type: 'text', text: 'stable context' }],
      source: { kind: 'user' },
    })
    new ScriptedEngine(ctx, prepared(contextMessage))
    ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (decision.kind === 'reject') return decision
      return {
        kind: 'enter' as const,
        messages: decision.messages.map(message => message.id === contextMessage.id
          ? {
            id: message.id,
            role: message.role,
            content: structuredClone(message.content),
            source: structuredClone(message.source),
          }
          : message),
      }
    })
    const agent = ctx.agentLoop.create(SessionId('reordered-context'), { provider: 'mock', model: 'mock' })

    send(agent, 'hello')
    await waitForIdle(ctx, agent)

    const trace = agent.session.events.find(event => event.type === 'context/prepared')
    if (trace?.type !== 'context/prepared') throw new Error('missing context/prepared')
    expect(trace.data.contributions[0]?.messageEventSeqs).toHaveLength(1)
  })

  it('persists trace links across surface replacement, replay, and a closed-turn fork', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-context-trace-'))
    dirs.push(root)
    const adapter = new MockAdapter([textResponse('packed'), textResponse('ok')])
    const ctx = await harness(adapter, root)
    const sessionId = SessionId('durable-context-trace')
    const agent = ctx.agentLoop.create(sessionId, { provider: 'mock', model: 'mock' })

    send(agent, 'first turn creates a physically packable chunk run')
    await waitForIdle(ctx, agent)
    const contextMessage = createUserMessage({
      content: [{ type: 'text', text: 'durable context' }],
      source: { kind: 'user' },
    })
    new ScriptedEngine(ctx, prepared(contextMessage, [], {
      searched: ['src'],
      notSearched: [],
      completeness: 'exhaustive',
    }))
    send(agent, 'hello')
    await waitForIdle(ctx, agent)
    const originalContextEvent = agent.session.events.find(event =>
      event.type === 'user/message' && event.data.id === contextMessage.id)
    if (originalContextEvent?.type !== 'user/message') throw new Error('missing original context message')
    const compacted = createUserMessage({
      content: [{ type: 'text', text: 'compacted context summary' }],
      source: { kind: 'user' },
    })
    agent.session.append('user/message', compacted, {
      surfaceOp: { op: 'replace', start: originalContextEvent.seq, end: originalContextEvent.seq },
      sourceEventSeqs: [originalContextEvent.seq],
    })
    const fork = ctx.sessions.fork(agent.session, undefined, SessionId('durable-context-trace-fork'))
    const forkTrace = fork.events.find(event => event.type === 'context/prepared')
    if (forkTrace?.type !== 'context/prepared') throw new Error('missing forked context/prepared')
    expect(forkTrace.data.contributions[0]?.messageEventSeqs).toEqual([originalContextEvent.seq])
    expect(fork.deriveMessages().some(message => message.id === contextMessage.id)).toBe(false)
    await ctx.sessions.flush(agent.session)
    const raw = await ctx.sessionPersistence.readRaw(sessionId)
    expect(raw?.content).toContain('"type":"text-chunks"')
    const restored = await ctx.sessionPersistence.load(sessionId)
    const trace = restored.events.find(event => event.type === 'context/prepared')
    if (trace?.type !== 'context/prepared') throw new Error('missing restored context/prepared')
    const restoredBySeq = new Map(restored.events.map(event => [event.seq, event]))
    const referenced = trace.data.contributions[0]!.messageEventSeqs.map(seq => restoredBySeq.get(seq))
    expect(referenced).toHaveLength(1)
    expect(referenced[0]).toMatchObject({
      type: 'user/message',
      data: { id: contextMessage.id },
      surfaceOp: 'append',
    })
    expect(trace.seq).toBeGreaterThan(referenced[0]!.seq)

    const replay = Session.fromRestore(
      sessionId,
      structuredClone(restored.events),
      structuredClone(restored.meta),
    )
    expect(replay.deriveMessages().map(message => message.content)).toEqual(
      agent.session.deriveMessages().map(message => message.content),
    )
    expect(replay.deriveMessages().filter(message => message.id === contextMessage.id)).toHaveLength(0)
    expect(replay.deriveMessages().filter(message => message.id === compacted.id)).toHaveLength(1)
    await ctx.fiber.dispose()
  })
})
