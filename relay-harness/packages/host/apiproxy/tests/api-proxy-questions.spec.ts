import { Context } from '@relay-harness/cordis'
import { afterEach,expect,it } from 'vitest'

import AgentRegistry,{ type Agent } from '@relay-harness/rlh-agent'
import SessionStore from '@relay-harness/rlh-session'
import UserQuestions from '@relay-harness/rlh-user-questions'
import { createApiProxy } from '../src/api-proxy.ts'
import type { ClientResponse,MuxFrame,RpcRequest } from '../src/api/index.ts'
import { RpcId } from '../src/api/rpc.ts'

const roots: Context[] = []
const aborts: AbortController[] = []
afterEach(async () => {
  for (const abort of aborts.splice(0)) abort.abort()
  for (const root of roots.splice(0)) await root.fiber.dispose()
})

async function harness() {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestions)
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  const session = ctx.sessions.create()
  // The interaction fixture supplies registry identity and the read-only mux inbox view; no driver verbs execute.
  const agent = { id: session.id, session, ctx, status: 'idle', inbox: { nextTurn: [], nextStep: [], hasPending: false } } as unknown as Agent
  const disposeAgent = ctx.agents.register(agent)
  const abort = new AbortController()
  aborts.push(abort)
  const stream = api.events.mux({ rpcId: RpcId('questions-mux'), payload: {} }, abort.signal)[Symbol.asyncIterator]()
  async function requested(): Promise<RpcRequest<MuxFrame>> {
    while (true) {
      const next = await stream.next()
      if (next.done) throw new Error('mux closed before question')
      if (next.value.payload.type === 'question/requested') return next.value
    }
  }
  return { ctx, api, agent, disposeAgent, requested }
}

const questions = [{ id: 'decision', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }]

it('withdraws an agent-owned question without an explicit signal when that exact agent is disposed', async () => {
  const { ctx, api, agent, disposeAgent, requested } = await harness()
  const pending = ctx.userQuestions.ask({ agent, questions })
  const settled = pending.then(value => ({ value }), (error: unknown) => ({ error }))
  const envelope = await requested()
  expect(ctx.hostInteractions.pendingFor(agent.id).questions).toBe(1)
  disposeAgent()
  expect(ctx.hostInteractions.pendingFor(agent.id).questions).toBe(0)
  expect(await api.respond({ type: 'client-response', rpcId: envelope.rpcId, result: { ok: true, value: { sessionId: agent.id, answer: { answers: [{ id: 'decision', selected: ['Yes'] }] } } } })).toEqual({ accepted: false, reason: 'not-pending' })
  expect(await settled).toMatchObject({ error: { code: 'ASK_ABORTED' } })
})

it('answers a real pending question exactly once with custom text and withdraws its abort listener', async () => {
  const { ctx, api, agent, requested } = await harness()
  const abort = new AbortController()
  const pending = ctx.userQuestions.ask({ agent, questions, signal: abort.signal })
  const envelope = await requested()
  const answer: ClientResponse = { type: 'client-response', rpcId: envelope.rpcId, result: { ok: true, value: { sessionId: agent.id, answer: { answers: [{ id: 'decision', selected: [], custom: 'Another option' }] } } } }
  expect(await api.respond(answer)).toEqual({ accepted: true })
  expect(await pending).toEqual({ answers: [{ id: 'decision', selected: [], custom: 'Another option' }] })
  abort.abort()
  expect(ctx.hostInteractions.pendingFor(agent.id)).toEqual({ approvals: 0, questions: 0 })
  expect(await api.respond(answer)).toEqual({ accepted: false, reason: 'not-pending' })
})

it('keeps malformed and wrongly correlated answers pending until an exact answer arrives', async () => {
  const { ctx, api, agent, requested } = await harness()
  const pending = ctx.userQuestions.ask({ agent, questions })
  const envelope = await requested()
  for (const value of [null, {}, { sessionId: 'foreign', answer: { answers: [{ id: 'decision', selected: ['Yes'] }] } },
    { sessionId: agent.id, answer: { answers: [{ id: 'wrong', selected: ['Yes'] }] } },
    { sessionId: agent.id, answer: { answers: [{ id: 'decision', selected: ['not offered'] }] } },
  ]) expect(await api.respond({ type: 'client-response', rpcId: envelope.rpcId, result: { ok: true, value } })).toEqual({ accepted: false, reason: 'bad-response' })
  expect(await api.respond({ type: 'client-response', rpcId: envelope.rpcId, result: { ok: false, error: { code: 'internal', message: 'bad client', details: {} } } })).toEqual({ accepted: false, reason: 'bad-response' })
  expect(ctx.hostInteractions.pendingFor(agent.id).questions).toBe(1)
  expect(await api.respond({ type: 'client-response', rpcId: envelope.rpcId, result: { ok: true, value: { sessionId: agent.id, answer: { answers: [{ id: 'decision', selected: ['No'] }] } } } })).toEqual({ accepted: true })
  expect(await pending).toEqual({ answers: [{ id: 'decision', selected: ['No'] }] })
})

it('accepts explicit client cancellation and rejects later answers', async () => {
  const { ctx, api, agent, requested } = await harness()
  const pending = ctx.userQuestions.ask({ agent, questions })
  const rejected = expect(pending).rejects.toMatchObject({ code: 'ASK_CANCELLED' })
  const envelope = await requested()
  expect(await api.respond({ type: 'client-response', rpcId: envelope.rpcId, result: { ok: false, error: { code: 'cancelled', message: 'dismissed', details: {} } } })).toEqual({ accepted: true })
  await rejected
  expect(ctx.hostInteractions.pendingFor(agent.id).questions).toBe(0)
})

it('withdraws pending questions on their signal and on gateway teardown', async () => {
  const { ctx, agent, requested } = await harness()
  const abort = new AbortController()
  const first = ctx.userQuestions.ask({ agent, questions, signal: abort.signal })
  const firstRejected = expect(first).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  await requested()
  abort.abort()
  await firstRejected
  const second = ctx.userQuestions.ask({ agent, questions })
  const secondRejected = expect(second).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  await requested()
  const interactions = ctx.hostInteractions
  await ctx.fiber.dispose()
  await secondRejected
  expect(interactions.pendingFor(agent.id).questions).toBe(0)
})

it('refuses an agentless question and keeps a same-id successor independent of the old owner', async () => {
  const { ctx, api, agent, requested, disposeAgent } = await harness()
  await expect(ctx.userQuestions.ask({ questions })).rejects.toMatchObject({ code: 'ASK_MISSING_AGENT' })
  const first = ctx.userQuestions.ask({ agent, questions })
  const rejected = expect(first).rejects.toMatchObject({ code: 'ASK_ABORTED' })
  const old = await requested()
  disposeAgent()
  await rejected
  const successor = { ...agent } as Agent
  ctx.agents.register(successor)
  const current = ctx.userQuestions.ask({ agent: successor, questions })
  const next = await requested()
  expect(await api.respond({ type: 'client-response', rpcId: old.rpcId, result: { ok: false, error: { code: 'cancelled', message: 'late', details: {} } } })).toEqual({ accepted: false, reason: 'not-pending' })
  expect(ctx.hostInteractions.pendingFor(agent.id).questions).toBe(1)
  await api.respond({ type: 'client-response', rpcId: next.rpcId, result: { ok: true, value: { sessionId: agent.id, answer: { answers: [{ id: 'decision', selected: ['Yes'] }] } } } })
  await expect(current).resolves.toEqual({ answers: [{ id: 'decision', selected: ['Yes'] }] })
})
