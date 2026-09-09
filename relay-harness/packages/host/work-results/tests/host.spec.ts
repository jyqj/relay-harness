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
import Questions from '@relay-harness/rlh-user-questions'
import Approval from '@relay-harness/rlh-user-approval'
import Projections from '@relay-harness/rlh-session-projection'
import Persistence from '@relay-harness/rlh-session-persistence-jsonl'
import Query from '@relay-harness/rlh-session-query-sqlite'
import Jobs from '@relay-harness/rlh-jobs-local'
import Typert from '@relay-harness/rlh-typert-registry'
import Gateway from '@relay-harness/rlh-api-gateway'
import WebServer from '@relay-harness/rlh-host-webserver'
import * as Connection from '@relay-harness/rlh-client-connection'
import * as Deliverables from '@relay-harness/rlh-client-ui-deliverables'
import { createApiProxy } from '@relay-harness/rlh-host-apiproxy'
import type { SessionEvent } from '@relay-harness/rlh-session'
import type { RpcResult } from '@relay-harness/rlh-host-apiproxy/api/rpc'
import WorkResults from '../src/index.ts'
import type { WorkAcceptReceipt, WorkLibraryPage, WorkAcceptRequest } from '../src/types.ts'

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
    approval: Approval, projections: Projections, persistence: Persistence, query: Query, jobs: Jobs, typert: Typert,
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
