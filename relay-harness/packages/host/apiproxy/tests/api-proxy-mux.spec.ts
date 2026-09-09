/**
 * The events.mux carrier over a real createApiProxy: a stalled subscriber is
 * disconnected once its buffered frames pass the configured byte budget, and a
 * reopened stream replays the full subscription baseline — the reconnect
 * semantics that make overflow termination lossless for the client fold.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import AgentRegistry, { type Agent } from '@relay-harness/rlh-agent'
import SessionStore from '@relay-harness/rlh-session'
import SessionProjectionRegistry from '@relay-harness/rlh-session-projection'
import UserQuestionService from '@relay-harness/rlh-user-questions'
import { createUserMessage } from '@relay-harness/rlh-llm'
import type { MuxFrame } from '../src/api/index.ts'
import type { RpcRequest } from '../src/api/rpc.ts'
import { RpcId } from '../src/api/rpc.ts'
import { createApiProxy } from '../src/api-proxy.ts'

/** Small enough that one large event crosses it; large enough for the baseline. */
const BUDGET_BYTES = 1024

async function harness(): Promise<{ ctx: Context; api: ReturnType<typeof createApiProxy> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp',
    muxStreamBufferBytes: BUDGET_BYTES,
  })
  return { ctx, api }
}

describe('events.mux subscriber buffer bound', () => {
  it('disconnects a stalled consumer past the budget and re-baselines on reopen', async () => {
    const { ctx, api } = await harness()
    const session = ctx.sessions.create()
    ctx.agents.register({
      id: session.id,
      session,
      status: 'idle',
      ctx,
      inbox: { hasPending: false },
    } as Agent)

    const abort = new AbortController()
    const stream = api.events.mux({ rpcId: RpcId('mux-stall'), payload: {} }, abort.signal)
    const iterator = stream[Symbol.asyncIterator]()
    const baseline = await iterator.next()
    expect(baseline.done).toBe(false)
    expect((baseline.value as RpcRequest<MuxFrame>).payload.type).toBe('session/subscribed')

    // A stalled consumer: connected but never pulling while large events land.
    const large = 'x'.repeat(2048)
    for (let index = 0; index < 3; index += 1) {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: large }],
        source: { kind: 'user' },
      }), { surfaceOp: 'append' })
    }

    // The next pull observes the queue ended itself within bounded time — the
    // oversized frame is delivered, then the stream closes cleanly.
    const finish = async (): Promise<boolean> => {
      for (;;) {
        const next = await iterator.next()
        if (next.done) return true
      }
    }
    const ended = await Promise.race([
      finish(),
      new Promise<boolean>(resolve => setTimeout(() =>{  resolve(false) }, 2_000)),
    ])
    expect(ended).toBe(true)

    // Reopening replays the subscription baseline, so the client fold loses no
    // state — this is what makes overflow termination safe.
    const reopened = api.events.mux({ rpcId: RpcId('mux-reopen'), payload: {} }, abort.signal)
    const rebaseline = await reopened[Symbol.asyncIterator]().next()
    expect(rebaseline.done).toBe(false)
    expect((rebaseline.value as RpcRequest<MuxFrame>).payload.type).toBe('session/subscribed')
    abort.abort()
  })
})

describe('events.mux projection frame hygiene', () => {
  it('never broadcasts sessionListMetadata change frames (baseline-only key)', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(SessionProjectionRegistry)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp',
    })
    const session = ctx.sessions.create()
    ctx.agents.register({
      id: session.id,
      session,
      status: 'idle',
      ctx,
      inbox: { hasPending: false },
    } as Agent)

    // The gateway's projection subscription lives in an inject child whose
    // fiber activates asynchronously; yield until it lands before appending.
    await new Promise(resolve => setTimeout(resolve, 0))

    const abort = new AbortController()
    const stream = api.events.mux({ rpcId: RpcId('mux-proj-hygiene'), payload: {} }, abort.signal)
    const frames: MuxFrame[] = []
    const drained = (async () => {
      for await (const envelope of stream) {
        frames.push(envelope.payload)
        if (frames.some(f => f.type === 'session/event')) abort.abort()
      }
    })().catch(() => {})
    // A user message flips blank and moves lastPromptAt — both used to mint a
    // sessionListMetadata frame per mux subscriber; no client consumes that key.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'hello' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await drained

    expect(frames.some(f => f.type === 'session/projection' && f.key === 'sessionListMetadata')).toBe(false)
    abort.abort()
  })
})
