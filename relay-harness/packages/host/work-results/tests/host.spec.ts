import { mkdtemp, writeFile, rm, mkdir, symlink, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { HarnessSdkJsonRpcServer } from '@relay-harness/rlh-sdk-jsonrpc-server'
import { JsonRpcLineTransport } from '@relay-harness/rlh-sdk-protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@relay-harness/cordis'
import { Remote, TypertRemoteService } from '@relay-harness/rlh-typert-protocol'
import { boot } from '@relay-harness/rlh-app-boot'
import Llm from '@relay-harness/rlh-llm'
import Sessions, { SessionId } from '@relay-harness/rlh-session'
import Agents from '@relay-harness/rlh-agent'
import Loop from '@relay-harness/rlh-agent-loop'
import Prompt from '@relay-harness/rlh-system-prompt'
import Tools, { defineTool } from '@relay-harness/rlh-tools'
import { createUserMessage } from '@relay-harness/rlh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { Agent } from '@relay-harness/rlh-agent'
import { SESSION_FORMAT_VERSION } from '@relay-harness/rlh-session'
import SubagentRuntime, { SUBAGENT_DESCRIPTOR_VERSION } from '@relay-harness/rlh-subagent'
import Questions from '@relay-harness/rlh-user-questions'
import Approval from '@relay-harness/rlh-user-approval'
import Projections from '@relay-harness/rlh-session-projection'
import Persistence from '@relay-harness/rlh-session-persistence-jsonl'
import Query from '@relay-harness/rlh-session-query-sqlite'
import Jobs from '@relay-harness/rlh-jobs-local'
import type { JobOutcome } from '@relay-harness/rlh-jobs'
import Typert from '@relay-harness/rlh-typert-registry'
import Gateway from '@relay-harness/rlh-api-gateway'
import WebServer from '@relay-harness/rlh-host-webserver'
import * as Connection from '@relay-harness/rlh-client-connection'
import * as Deliverables from '@relay-harness/rlh-client-ui-deliverables'
import { createApiProxy } from '@relay-harness/rlh-host-apiproxy'
import type { SessionEvent } from '@relay-harness/rlh-session'
import type { RpcResult } from '@relay-harness/rlh-host-apiproxy/api/rpc'
import WorkResults from '../src/index.ts'
import type { WorkAcceptReceipt, WorkLibraryPage, WorkAcceptRequest, WorkView, WorkContentReview, WorkContentReviewRead, WorkContentVersion } from '../src/types.ts'

class RelayFixture extends TypertRemoteService {
  static inject = ['workResults']
  constructor(ctx: Context) { super(ctx, 'relayFixture') }
  @Remote('relay') relay(agent: Agent, request: WorkAcceptRequest, signal: AbortSignal): Promise<WorkAcceptReceipt> {
    return this.ctx.workResults.accept(agent, request, signal)
  }
}

const contexts: Context[] = []
const roots: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rlh-work-results-'))
  roots.push(root)
  const opened: string[] = []
  const plugins = { llm: Llm, sessions: Sessions, agents: Agents, loop: Loop, prompt: Prompt, tools: Tools, questions: Questions,
    approval: Approval, projections: Projections, persistence: Persistence, query: Query, jobs: Jobs,
    subagents: SubagentRuntime, typert: Typert,
    gateway: Gateway, web: WebServer, connection: Connection, deliverables: Deliverables, results: WorkResults, relay: RelayFixture,
    support: {
      inject: ['agents', 'sessions', 'userQuestions', 'sessionQuery'],
      apply(ctx: Context) {
        ctx.provide('apiProxy', createApiProxy(ctx, {
          cwd: root, defaultModelSelection: () => ({ provider: 'fixture', model: 'fixture' }),
          openPath: (path) => { opened.push(path); return Promise.resolve() },
        }))
      },
    },
  }
  const configs: Record<string, unknown> = {
    loop: { agents: [] }, persistence: { root: join(root, 'logs'), compression: 'none' },
    query: { path: ':memory:', openAt: 'never' }, web: { host: '127.0.0.1', port: 0 },
    results: { scanSessionsPerPage: 1 },
  }
  const config = join(root, 'cordis.yml')
  await writeFile(config, JSON.stringify(Object.keys(plugins).map(id => ({ id, name: `cordis:${id}`, config: configs[id] ?? {} }))))
  const ctx = await boot('work-results-test', config, undefined, (context) => { Object.assign(context.loader.builtins, plugins) })
  contexts.push(ctx)
  const sessionId = SessionId('reviewed-work')
  const seed: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
  const handle = await ctx.agents.create({ sessionId, meta: { cwd: root }, seed, agentOptions: { provider: 'fixture', model: 'fixture' } })
  const post = async <T>(method: string, args: object): Promise<RpcResult<T>> => {
    const endpoint = method.includes('/') ? method : `workResults/${method}`
    const response = await fetch(`http://127.0.0.1:${ctx.webServer.port}/api/${endpoint}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
    })
    expect(response.status).toBe(200)
    return (await response.json() as { result: RpcResult<T> }).result
  }
  return { ctx, root, opened, handle, post }
}

async function produce(ctx: Context, agent: Agent, path: string): Promise<void> {
  const adapter = ctx.llm.registerAdapter(['fixture'], new MockAdapter([
    toolCallResponse('write-call', 'fixture_write', { path }), textResponse('Created the result.'),
  ]))
  const tool = ctx.tools.register(defineTool({
    name: 'fixture_write', description: 'Write a fixture output', parameters: { path: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    presentCall: args => ({ card: 'generic', title: 'Write output', kind: 'edit', locations: [{ path: args.path }] }),
    execute: async (args) => { await writeFile(resolve(agent.session.header.cwd ?? '', args.path), 'fixture'); return 'written' },
  }))
  try {
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Create an output.' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await ctx.sessions.flush(agent.session)
  } finally { tool(); adapter() }
}

/** Author one persisted cold subagent-child log directly against the persistence backend. */
async function authorChild(ctx: Awaited<ReturnType<typeof fixture>>['ctx'], id: string, parentId: string, descriptor: object): Promise<string> {
  const sessionId = SessionId(id)
  await ctx.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 1,
    parentSession: SessionId(parentId), origin: 'subagent',
  })
  await ctx.sessionPersistence.append(sessionId, [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } } },
    { type: 'user/message', seq: 1, time: 2, surfaceOp: 'append', data: createUserMessage({ content: [{ type: 'text', text: 'work' }], source: { kind: 'user' } }) },
    { type: 'subagent/descriptor', seq: 2, time: 3, data: descriptor },
    { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as SessionEvent[])
  return id
}

/** One continuable or one-shot descriptor payload the projection fold accepts. */
function descriptorPayload(mode: 'one-shot' | 'continuable', label: string): object {
  return { version: SUBAGENT_DESCRIPTOR_VERSION, mode, provider: 'spawn', label }
}

describe('Work Results through a Loader and the real trusted HTTP Remote', () => {
  it('reads cold cross-session outputs in bounded pages and opens only the source workspace path', async () => {
    const { ctx, root, opened, handle, post } = await fixture()
    await produce(ctx, handle.agent, 'first.txt')
    await handle.dispose()
    const otherRoot = join(root, 'other')
    await mkdir(otherRoot)
    const second = await ctx.agents.create({ sessionId: SessionId('second-work'), meta: { cwd: otherRoot }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    await produce(ctx, second.agent, 'second.txt')
    const first = await post<WorkLibraryPage>('list', { request: { query: '.txt' } })
    expect(first.ok).toBe(true)
    if (!first.ok) throw new Error(first.error.message)
    expect(first.value.scannedSessions).toBe(1)
    expect(first.value.next).not.toBeNull()
    const next = await post<WorkLibraryPage>('list', { request: { query: '.txt', ...first.value.next } })
    expect(next.ok).toBe(true)
    if (!next.ok) throw new Error(next.error.message)
    expect([...first.value.entries, ...next.value.entries].map(entry => entry.path).sort()).toEqual(['first.txt', 'second.txt'])
    expect(ctx.agents.get(handle.agent.id)).toBeUndefined()
    expect(await post('open', { request: { sessionId: handle.agent.id, path: 'first.txt' } })).toMatchObject({ ok: true })
    expect(opened).toEqual([await realpath(join(root, 'first.txt'))])
    expect((await post('open', { request: { sessionId: second.agent.id, path: 'first.txt' } })).ok).toBe(false)
    expect(opened).toHaveLength(1)
  })

  it('refuses acceptance while the proxy owns a pending question outside a running turn', async () => {
    const { ctx, handle, post } = await fixture()
    const pending = ctx.userQuestions.ask({ agent: handle.agent, questions: [{ id: 'review', header: 'Review', question: 'Continue?' }] }).catch(() => undefined)
    await vi.waitFor(() => { expect(ctx.hostInteractions.pendingFor(handle.agent.id).questions).toBe(1) })
    expect(handle.agent.status).toBe('idle')
    expect((await post('accept', { agentId: handle.agent.id, request: { reviewRevision: handle.agent.session.seq - 1 } })).ok).toBe(false)
    await ctx.fiber.dispose()
    await pending
  })


  it.skipIf(process.platform === 'win32')('delegates an explicitly introduced external symlink to the existing native opener', async () => {
    const { ctx, root, opened, handle, post } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'rlh-outside-output-'))
    roots.push(outside)
    await writeFile(join(outside, 'outside.txt'), 'outside')
    await symlink(join(outside, 'outside.txt'), join(root, 'output.txt'))
    await produce(ctx, handle.agent, 'output.txt')
    expect((await post('open', { request: { sessionId: handle.agent.id, path: 'output.txt' } })).ok).toBe(true)
    expect(opened).toEqual([await realpath(join(outside, 'outside.txt'))])
  })

  it.skipIf(process.platform === 'win32')('refuses a target changed during the Host open operation', async () => {
    const { ctx, root, opened, handle, post } = await fixture()
    await produce(ctx, handle.agent, 'changing.txt')
    await writeFile(join(root, 'replacement.txt'), 'replacement')
    const read = ctx.sessionQuery.readSession.bind(ctx.sessionQuery)
    const observe = vi.spyOn(ctx.sessionQuery, 'readSession').mockImplementationOnce(read).mockImplementationOnce(async (id) => {
      await rm(join(root, 'changing.txt'))
      await symlink(join(root, 'replacement.txt'), join(root, 'changing.txt'))
      return read(id)
    })
    try {
      expect(await post('open', { request: { sessionId: handle.agent.id, path: 'changing.txt' } }))
        .toMatchObject({ ok: false, error: { message: 'workResults output changed before opening; review it again' } })
      expect(opened).toEqual([])
    } finally { observe.mockRestore() }
  })

  it('rejects an agent initiator even inside the real original Remote endpoint', async () => {
    const { ctx, handle, post } = await fixture()
    const invoke = ctx.typertGateway.invoke.bind(ctx.typertGateway)
    const gateway = vi.spyOn(ctx.typertGateway, 'invoke').mockImplementation(request =>
      ctx.agents.withInitiator(handle.agent, () => invoke(request)))
    try {
      expect(await post('accept', { agentId: handle.agent.id, request: { reviewRevision: handle.agent.session.seq - 1 } }))
        .toMatchObject({ ok: false, error: { message: 'workResults requires an active explicit user Remote request' } })
      expect(handle.agent.session.events.some(event => event.type === 'work/accepted')).toBe(false)
    } finally { gateway.mockRestore() }
  })

  it('preserves the receipt through SDK JSON-RPC notification and cold restore without adding model input', async () => {
    const { ctx, handle, post } = await fixture()
    const input = new PassThrough()
    const output = new PassThrough()
    const transport = new JsonRpcLineTransport(input, output)
    const sdk = new HarnessSdkJsonRpcServer(ctx, transport)
    const notifications: unknown[] = []
    output.on('data', (chunk: Buffer) => { notifications.push(JSON.parse(chunk.toString('utf8'))) })
    const agent = handle.agent
    const before = agent.session.deriveMessages()
    const revision = agent.session.seq - 1
    try {
      expect((await post('accept', { agentId: agent.id, request: { reviewRevision: revision } })).ok).toBe(true)
      const notification = notifications.find(value => (value as { params?: { event?: { type?: string } } }).params?.event?.type === 'work/accepted')
      expect(notification).toMatchObject({
        method: 'session.event',
        params: { event: { type: 'work/accepted', data: { reviewedThroughSeq: revision, actor: 'host-client' } } },
      })
      expect(agent.session.deriveMessages()).toEqual(before)
      await handle.dispose()
      const restored = await ctx.agents.resume({ resumeSessionId: agent.id, agentOptions: { provider: 'fixture', model: 'fixture' } })
      expect(ctx.sessionProjections.snapshot(restored.agent.session).values.workAcceptance?.acceptedRevision).toBe(revision)
      expect(restored.agent.session.events.filter(event => event.type === 'work/accepted')).toHaveLength(1)
      await restored.dispose()
    } finally {
      await sdk.shutdown()
      transport.close()
      input.destroy()
      output.destroy()
    }
  })

  it('opens an explicitly recorded external ordinary file through the existing native authority', async () => {
    const { ctx, opened, handle, post } = await fixture()
    const outside = await mkdtemp(join(tmpdir(), 'rlh-explicit-output-'))
    roots.push(outside)
    const path = join(outside, 'external.txt')
    await produce(ctx, handle.agent, path)
    expect((await post('open', { request: { sessionId: handle.agent.id, path } })).ok).toBe(true)
    expect(opened).toEqual([await realpath(path)])
    const opener = vi.spyOn(ctx.apiProxy.host, 'openPath').mockResolvedValue({ rpcId: 'refused' as never, result: { ok: false, error: { code: 'internal', message: 'native authority refused', details: {} } } })
    expect(await post('open', { request: { sessionId: handle.agent.id, path } })).toMatchObject({ ok: false, error: { message: 'native authority refused' } })
    opener.mockRestore()
  })

  it('rejects a continuation cursor when an already-scanned live Session gains another output', async () => {
    const { ctx, root, handle, post } = await fixture()
    await produce(ctx, handle.agent, 'old.txt')
    const newer = await ctx.agents.create({ sessionId: SessionId('newer-work'), meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'fixture' } })
    await produce(ctx, newer.agent, 'new.txt')
    const page = await post<WorkLibraryPage>('list', { request: { query: '.txt' } })
    if (!page.ok || page.value.next === null) throw new Error('fixture expected a continuation')
    const scanned = ctx.agents.get(page.value.entries[0]!.sessionId)
    if (scanned === undefined) throw new Error('fixture expected a live first Session')
    await produce(ctx, scanned, 'later.txt')
    expect(await post('list', { request: { query: '.txt', ...page.value.next } })).toMatchObject({ ok: false, error: { message: 'workResults Library changed; restart the search' } })
  })

  it('does not verify an unflushed receipt and returns a captured cut rather than later memory state', async () => {
    const { ctx, handle, post } = await fixture()
    const revision = handle.agent.session.seq - 1
    const original = ctx.sessions.flush.bind(ctx.sessions)
    const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(original).mockRejectedValue(new Error('disk unavailable'))
    expect((await post('accept', { agentId: handle.agent.id, request: { reviewRevision: revision } })).ok).toBe(false)
    expect((await post('get', { agentId: handle.agent.id })).ok).toBe(false)
    flush.mockRestore()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const delayed = vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return original(session)
    })
    const verifying = post<import('../src/types.ts').WorkVerifiedReview>('get', { agentId: handle.agent.id })
    await entered.promise
    handle.agent.session.append('approval/policy', { policy: 'ask' })
    release.resolve(undefined)
    const verified = await verifying
    expect(verified).toMatchObject({ ok: true, value: { reviewRevision: revision, acceptedRevision: revision, current: false } })
    delayed.mockRestore()
  })

  it('records one durable revision-bound receipt for repeated explicit acceptance', async () => {
    const { ctx, handle, post } = await fixture()
    const agent = handle.agent
    const revision = agent.session.seq - 1
    const results = await Promise.all([
      post<WorkAcceptReceipt>('accept', { agentId: agent.id, request: { reviewRevision: revision } }),
      post<WorkAcceptReceipt>('accept', { agentId: agent.id, request: { reviewRevision: revision } }),
    ])
    expect(results.some(result => result.ok)).toBe(true)
    expect(agent.session.events.filter(event => event.type === 'work/accepted')).toHaveLength(1)
    const stored = await ctx.sessionPersistence.readFrom(agent.id, 0)
    expect(stored.events.at(-1)).toMatchObject({ type: 'work/accepted', data: { reviewedThroughSeq: revision, actor: 'host-client' } })
    agent.session.append('turn/start', { turn: 2 })
    expect((await post('accept', { agentId: agent.id, request: { reviewRevision: revision } })).ok).toBe(false)
    expect(ctx.sessionProjections.snapshot(agent.session).values.workAcceptance?.acceptedRevision).toBe(revision)
  })

  it('refuses direct calls and rechecks CAS after a durability wait', async () => {
    const { ctx, handle, post } = await fixture()
    const agent = handle.agent
    await expect(
      ctx.workResults.accept(agent, { reviewRevision: agent.session.seq - 1 }, new AbortController().signal),
    ).rejects.toThrow(/active explicit user Remote/)
    await expect(ctx.typertGateway.invoke({
      namespace: 'workResults', method: 'accept', args: { agentId: agent.id, request: { reviewRevision: agent.session.seq - 1 } },
    })).rejects.toThrow(/active explicit user Remote/)
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const original = ctx.sessions.flush.bind(ctx.sessions)
    const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(async (session) => {
      entered.resolve(undefined)
      await release.promise
      return original(session)
    })
    const pending = post('accept', { agentId: agent.id, request: { reviewRevision: agent.session.seq - 1 } })
    await entered.promise
    agent.session.append('turn/start', { turn: 2 })
    release.resolve(undefined)
    expect((await pending).ok).toBe(false)
    expect(agent.session.events.some(event => event.type === 'work/accepted')).toBe(false)
    flush.mockRestore()
  })

  it('rejects a nested call from another trusted endpoint without borrowing its user request', async () => {
    const { handle, post } = await fixture()
    expect(await post('relayFixture/relay', { agentId: handle.agent.id, request: { reviewRevision: handle.agent.session.seq - 1 } }))
      .toMatchObject({ ok: false, error: { message: 'workResults requires an active explicit user Remote request' } })
    expect(handle.agent.session.events.some(event => event.type === 'work/accepted')).toBe(false)
  })

  it('does not acknowledge a receipt when its post-append durability barrier fails', async () => {
    const { ctx, handle, post } = await fixture()
    const original = ctx.sessions.flush.bind(ctx.sessions)
    const flush = vi.spyOn(ctx.sessions, 'flush').mockImplementationOnce(original).mockRejectedValueOnce(new Error('receipt flush failed'))
    const request = { agentId: handle.agent.id, request: { reviewRevision: handle.agent.session.seq - 1 } }
    expect(await post('accept', request)).toMatchObject({ ok: false, error: { message: 'receipt flush failed' } })
    expect(handle.agent.session.events.filter(event => event.type === 'work/accepted')).toHaveLength(1)
    flush.mockRestore()
    expect((await post('accept', request)).ok).toBe(true)
    expect(handle.agent.session.events.filter(event => event.type === 'work/accepted')).toHaveLength(1)
  })

  it('returns no successful receipt when persistence fails', async () => {
    const { ctx, handle, post } = await fixture()
    const agent = handle.agent
    const flush = vi.spyOn(ctx.sessions, 'flush').mockRejectedValueOnce(new Error('disk unavailable'))
    expect(await post('accept', { agentId: agent.id, request: { reviewRevision: agent.session.seq - 1 } }))
      .toMatchObject({ ok: false, error: { message: 'disk unavailable' } })
    expect(agent.session.events.some(event => event.type === 'work/accepted')).toBe(false)
    flush.mockRestore()
  })
})

it('reports live confirmation reasons through the same trusted Remote used for confirmation', async () => {
  const { handle, post } = await fixture()
  const eligible = await post<import('../src/types.ts').WorkVerifiedReview>('get', { agentId: handle.agent.id })
  expect(eligible.ok).toBe(true)
  if (!eligible.ok) throw new Error(eligible.error.message)
  expect(eligible.value.confirmationBlockedBy).toEqual([])
  expect(eligible.value.acceptedRevision).toBeNull()
  handle.agent.session.append('turn/start', { turn: 2 })
  const blocked = await post<import('../src/types.ts').WorkVerifiedReview>('get', { agentId: handle.agent.id })
  expect(blocked.ok).toBe(true)
  if (!blocked.ok) throw new Error(blocked.error.message)
  expect(blocked.value.confirmationBlockedBy).toContain('turn-open')
  const refused = await post('accept', { agentId: handle.agent.id, request: { reviewRevision: blocked.value.reviewRevision } })
  expect(refused.ok).toBe(false)
  expect(handle.agent.session.events.some(event => event.type === 'work/accepted')).toBe(false)
})

it('reads a cold Work, review and final history through trusted HTTP without activating an Agent', async () => {
  const { ctx, handle, post } = await fixture()
  await produce(ctx, handle.agent, 'passive.txt')
  const id = handle.agent.id
  await handle.dispose()
  const resume = vi.spyOn(ctx.agents, 'resume')
  const view = await post<import('../src/types.ts').WorkView>('inspect', { request: { sessionId: id } })
  expect(view).toMatchObject({ ok: true, value: {
    source: { resident: false, current: false }, goal: null, outputs: { paths: ['passive.txt'] },
    execution: { activity: 'unknown' }, actions: { confirmRecord: { allowed: false, scope: 'session-log' } },
  } })
  const history = await post<import('../src/types.ts').WorkHistoryPage>('history', { request: { sessionId: id, limit: 2 } })
  expect(history.ok).toBe(true)
  if (history.ok) {
    expect(history.value.rows).toHaveLength(2)
    expect(history.value.nextBeforeSeq).not.toBeNull()
    expect(history.value.rows.some(row => row.text.includes('Created the result.'))).toBe(true)
  }
  expect(await post('review', { request: { sessionId: id } })).toMatchObject({ ok: true, value: { current: false, confirmationBlockedBy: ['runtime-unavailable'] } })
  expect(resume).not.toHaveBeenCalled()
  expect(ctx.agents.get(id)).toBeUndefined()
  expect((await post('history', { request: { sessionId: id, limit: 10000 } })).ok).toBe(false)
})

it('derives per-execution relationship and recovery capability facts without granting control or resume', async () => {
  const { ctx, root, handle, post } = await fixture()
  const parentId = handle.agent.id
  const continuable = await authorChild(ctx, 'cold-continuable', parentId, descriptorPayload('continuable', 'reporter'))
  const oneShot = await authorChild(ctx, 'cold-one-shot', parentId, descriptorPayload('one-shot', 'runner'))
  const corrupt = await authorChild(ctx, 'cold-corrupt', parentId, { version: SUBAGENT_DESCRIPTOR_VERSION + 1, mode: 'continuable', provider: 'spawn', label: 'unrecognized' })
  const live = await post<WorkView>('inspect', { request: { sessionId: parentId } })
  expect(live.ok).toBe(true)
  if (!live.ok) throw new Error(live.error.message)
  const byId = new Map(live.value.execution.entries.map(entry => [entry.id, entry]))
  expect(byId.get(parentId)?.relationship).toEqual({ kind: 'owned', controlLink: true })
  expect(byId.get(parentId)?.recoveryCapabilities).toEqual({ history: 'persisted', resume: 'explicit', control: 'resident' })
  expect(byId.get(continuable)?.relationship).toEqual({ kind: 'reports-to', peerSessionId: parentId, controlLink: false })
  expect(byId.get(continuable)?.recoveryCapabilities).toEqual({ history: 'persisted', resume: 'explicit', control: 'none' })
  expect(byId.get(oneShot)?.relationship).toEqual({ kind: 'delegated', peerSessionId: parentId, controlLink: false })
  expect(byId.get(oneShot)?.recoveryCapabilities).toEqual({ history: 'persisted', resume: 'unavailable', control: 'none' })
  // An unclassified child keeps relationship facts from its durable origin header but no recovery claim.
  expect(byId.get(corrupt)?.relationship).toEqual({ kind: 'delegated', peerSessionId: parentId, controlLink: false })
  expect(byId.get(corrupt)?.recoveryCapabilities).toEqual({ history: 'unknown', resume: 'unknown', control: 'none' })
  expect(live.value.coverage.missing.some(reason => reason.startsWith('subagent-corrupt:'))).toBe(true)
  // A Work whose own root carries a fork or delegation header names that edge and stays conservatively resumable.
  for (const [id, meta, relationship, resume] of [
    [SessionId('forked-work'), { parentSession: parentId }, { kind: 'forked-from', peerSessionId: parentId, controlLink: false }, 'explicit'],
    [SessionId('delegated-work'), { parentSession: parentId, origin: 'subagent' as const }, { kind: 'delegated', peerSessionId: parentId, controlLink: false }, 'unknown'],
  ] as const) {
    const created = await ctx.agents.create({
      sessionId: id, meta: { cwd: root, ...meta },
      seed: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
      ] as SessionEvent[],
      agentOptions: { provider: 'fixture', model: 'fixture' },
    })
    await ctx.sessions.flush(created.agent.session)
    await created.dispose()
    const view = await post<WorkView>('inspect', { request: { sessionId: id } })
    if (!view.ok) throw new Error(`inspect ${id}: ${view.error.message}`)
    expect(view.ok).toBe(true)
    expect(view.value.execution.entries[0]?.relationship).toEqual(relationship)
    expect(view.value.execution.entries[0]?.recoveryCapabilities)
      .toEqual({ history: 'persisted', resume, control: 'none' })
  }
})

it('reports a control-lost-unknown job as uncertain, never inactive or history-only', async () => {
  const { ctx, handle, post } = await fixture()
  ctx.jobs.attachController('work-results-test')
  const id = ctx.jobs.start({
    kind: 'bash', label: 'sleep 60', owner: handle.agent, stopGraceMs: 10,
    // A producer that never settles: the bounded stop must close the record as
    // control-lost-unknown while the work itself may still run.
    run: () => ({ cancel() {}, done: new Promise<JobOutcome>(() => {}) }),
  })
  ctx.jobs.kill(id, handle.agent, 'no longer needed')
  await vi.waitFor(() => { expect(ctx.jobs.get(id, handle.agent).status).toBe('control-lost-unknown') })
  const view = await post<WorkView>('inspect', { request: { sessionId: handle.agent.id } })
  expect(view).toMatchObject({ ok: true })
  if (!view.ok) throw new Error(view.error.message)
  const job = view.value.execution.entries.find(entry => entry.kind === 'job')
  expect(job).toMatchObject({
    activity: 'unknown', recovery: 'unknown',
    relationship: { controlLink: false },
    recoveryCapabilities: { control: 'none' },
  })
  expect(job?.outcome).toBeUndefined()
  expect(view.value.execution.activity).toBe('unknown')
})

it('uses the same persistence receipt through passive review without granting a new confirmation', async () => {
  const { handle, post } = await fixture()
  const id = handle.agent.id
  const revision = handle.agent.session.seq - 1
  expect((await post('accept', { agentId: id, request: { reviewRevision: revision } })).ok).toBe(true)
  expect(await post('review', { request: { sessionId: id } })).toMatchObject({ ok: true, value: { current: true, reviewRevision: revision, acceptedRevision: revision, confirmationBlockedBy: [] } })
})

it('enumerates Library metadata only on the first page and retains a Session inventory across path pages', async () => {
  const { ctx, handle, post } = await fixture()
  await produce(ctx, handle.agent, 'one.txt')
  await produce(ctx, handle.agent, 'two.txt')
  const listing = vi.spyOn(ctx.sessionQuery, 'listSessions')
  const snapshots = vi.spyOn(ctx.sessionPersistence, 'listSnapshots')
  const first = await post<WorkLibraryPage>('list', { request: { query: '.txt', limit: 1 } })
  if (!first.ok || first.value.next === null) throw new Error('expected a continuation')
  const count = listing.mock.calls.length
  const snapshotCount = snapshots.mock.calls.length
  const next = await post<WorkLibraryPage>('list', { request: { query: '.txt', limit: 1, ...first.value.next } })
  expect(next.ok).toBe(true)
  expect(listing).toHaveBeenCalledTimes(count)
  expect(snapshots).toHaveBeenCalledTimes(snapshotCount)
  expect(first.value.observedSessionIds).toEqual([handle.agent.id])
  if (next.ok) {
    expect(next.value.observedSessionIds).toEqual([handle.agent.id])
    expect(next.value.entries[0]?.path).toBe('two.txt')
    expect(next.value.entries[0]?.sourceThroughSeq).toBe(first.value.entries[0]?.sourceThroughSeq)
    expect(next.value.coverage?.scope).toBe('observed-corpus')
  }
})

const FIXTURE_DIGEST = 'a'.repeat(64)

function contentVersionFixture(): WorkContentVersion {
  return {
    execution: { sessionId: SessionId('reviewed-work') },
    source: { sessionId: SessionId('reviewed-work'), throughSeq: 1 },
    locator: 'report.md', contentHash: { algorithm: 'sha256', digest: FIXTURE_DIGEST }, observedAt: 1000,
  }
}

function contentReviewRequest(decision: 'approved' | 'rejected' = 'approved') {
  return {
    decision,
    contentVersions: [contentVersionFixture()],
    contentVersionRefs: [FIXTURE_DIGEST],
    checkRecords: [{
      checkId: 'check-1', checker: { name: 'vitest', version: '1.0' }, contentVersionRefs: [FIXTURE_DIGEST],
      exitCode: 0, verdict: 'pass' as const, evidence: 'host-captured' as const,
    }],
    checkRecordRefs: ['check-1'],
  }
}

it('records a durable content review bound to versions, never to the log prefix', async () => {
  const { ctx, handle, post } = await fixture()
  const agent = handle.agent
  const recorded = await post<WorkContentReview>('recordContentReview', { agentId: agent.id, request: contentReviewRequest() })
  expect(recorded.ok).toBe(true)
  if (!recorded.ok) throw new Error(recorded.error.message)
  expect(recorded.value).toMatchObject({ decision: 'approved', actor: 'host-client', contentVersionRefs: [FIXTURE_DIGEST], checkRecordRefs: ['check-1'] })
  expect(agent.session.events.filter(event => event.type === 'work/reviewed')).toHaveLength(1)
  expect(agent.session.events.some(event => event.type === 'work/accepted')).toBe(false)
  const stored = await ctx.sessionPersistence.readFrom(agent.id, 0)
  expect(stored.events.find(event => event.type === 'work/reviewed')).toMatchObject({ data: { reviewId: recorded.value.reviewId } })
  agent.session.append('turn/start', { turn: 2 })
  const read = await post<WorkContentReviewRead>('contentReview', { request: { sessionId: agent.id } })
  expect(read).toMatchObject({ ok: true, value: {
    review: { reviewId: recorded.value.reviewId, decision: 'approved' },
    currency: [{ ref: FIXTURE_DIGEST, state: 'not-reverified' }],
  } })
  expect(ctx.sessionProjections.snapshot(agent.session).values.workAcceptance?.acceptedRevision).toBeNull()
})

it('reuses the latest review only for a byte-identical resubmission and fails loud on an unresolved ref', async () => {
  const { handle, post } = await fixture()
  const agent = handle.agent
  const first = await post<WorkContentReview>('recordContentReview', { agentId: agent.id, request: contentReviewRequest() })
  const repeat = await post<WorkContentReview>('recordContentReview', { agentId: agent.id, request: contentReviewRequest() })
  expect(first.ok && repeat.ok).toBe(true)
  if (first.ok && repeat.ok) expect(repeat.value.reviewId).toBe(first.value.reviewId)
  expect(agent.session.events.filter(event => event.type === 'work/reviewed')).toHaveLength(1)
  expect((await post<WorkContentReview>('recordContentReview', { agentId: agent.id, request: contentReviewRequest('rejected') })).ok).toBe(true)
  expect(agent.session.events.filter(event => event.type === 'work/reviewed')).toHaveLength(2)
  const invalid = contentReviewRequest()
  invalid.contentVersionRefs = ['b'.repeat(64)]
  expect(await post('recordContentReview', { agentId: agent.id, request: invalid })).toMatchObject({ ok: false })
  expect(agent.session.events.filter(event => event.type === 'work/reviewed')).toHaveLength(2)
})

it('reads a cold content review without activation and reports unverified currency', async () => {
  const { ctx, handle, post } = await fixture()
  const id = handle.agent.id
  expect((await post('recordContentReview', { agentId: id, request: contentReviewRequest() })).ok).toBe(true)
  await handle.dispose()
  const resume = vi.spyOn(ctx.agents, 'resume')
  const read = await post<WorkContentReviewRead>('contentReview', { request: { sessionId: id } })
  expect(read).toMatchObject({ ok: true, value: { review: { decision: 'approved' }, currency: [{ ref: FIXTURE_DIGEST, state: 'not-reverified' }] } })
  expect(resume).not.toHaveBeenCalled()
  expect(ctx.agents.get(id)).toBeUndefined()
})
