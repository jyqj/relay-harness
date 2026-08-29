import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import AgentLoop from '@relay-harness/rlh-agent-loop'
import { mountAgentLoopTestDependencies } from '@relay-harness/rlh-agent-loop-testkit'
import { TrackerIssueId, type TrackerIssue, type TrackerToolBinding } from '@relay-harness/rlh-tracker'
import type { IssueWorkspace } from '@relay-harness/rlh-issue-workspace'
import { textResponse, toolCallResponse, MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import AgentIssueRunner from '../src/index.ts'

const target: TrackerIssue = {
  id: TrackerIssueId('issue-1'),
  identifier: 'ENG-1',
  title: 'Exercise native issue runner',
  state: 'Todo',
  labels: [],
  blockedBy: [],
  dispatchable: true,
}

const workspace: IssueWorkspace = {
  issueId: target.id,
  path: '/tmp',
  created: false,
  preparedAt: 1,
}

async function boot(
  script: ConstructorParameters<typeof MockAdapter>[0],
  config: { provider: string; model: string; maxTokens?: number } = { provider: 'mock', model: 'mock' },
) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  await ctx.plugin(AgentIssueRunner, config)
  return { ctx, adapter }
}

function request(overrides: Partial<Parameters<AgentIssueRunner['start']>[0]> = {}) {
  return {
    issue: target,
    workspace,
    attempt: 1,
    prompt: 'issue prompt',
    continuationPrompt: () => 'continue',
    maxTurns: 1,
    trackerTools: {
      provider: 'memory', tools: [], secretEnvironmentNames: [],
      execute: () => Promise.resolve({ success: false as const, value: null }),
    },
    refreshIssue: () => Promise.resolve(target),
    shouldContinue: () => false,
    ...overrides,
  }
}

describe('AgentIssueRunner', () => {
  it('keeps one Session across continuation turns and executes captured tracker tools', async () => {
    const { ctx, adapter } = await boot([
      toolCallResponse('tool-1', 'tracker_echo', { value: 'one' }),
      textResponse('first turn complete'),
      textResponse('second turn complete'),
    ])
    const calls: unknown[] = []
    const binding: TrackerToolBinding = {
      provider: 'memory',
      tools: [{
        name: 'tracker_echo',
        description: 'Echo a tracker value.',
        parameters: {
          type: 'object', properties: { value: { type: 'string' } },
          required: ['value'], additionalProperties: false,
        },
      }],
      secretEnvironmentNames: [],
      execute: (_name, arguments_) => { calls.push(arguments_); return Promise.resolve({ success: true, value: arguments_ }) },
    }
    let refreshes = 0
    const events: string[] = []
    const run = await ctx.issueRunner.start({
      issue: target,
      workspace,
      attempt: 1,
      prompt: 'initial issue prompt',
      continuationPrompt: () => 'continue the issue',
      maxTurns: 2,
      trackerTools: binding,
      refreshIssue: () => { refreshes += 1; return Promise.resolve(target) },
      shouldContinue: () => true,
      onEvent: (event) => { events.push(event.kind) },
    })
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed', turns: 2 })
    expect(calls).toEqual([{ value: 'one' }])
    expect(refreshes).toBe(2)
    expect(events).toContain('tool')
    expect(events.filter(event => event === 'turn-ended')).toHaveLength(2)
    expect(adapter.requests).toHaveLength(3)
    expect(ctx.agents.get(run.sessionId)).toBeUndefined()
  })

  it('returns blocked when pre-step policy rejects the issue turn', async () => {
    const { ctx } = await boot([])
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent.session.header.cwd === workspace.path) return { kind: 'reject' as const }
      return await next()
    })
    const run = await ctx.issueRunner.start(request({ prompt: 'blocked prompt' }))
    await expect(run.result).resolves.toMatchObject({ stopReason: 'blocked', turns: 1 })
  })

  it('materializes a captured tracker failure as a tool error and continues the turn', async () => {
    const { ctx } = await boot([
      toolCallResponse('tool-1', 'tracker_fail', {}),
      textResponse('handled tracker failure'),
    ])
    const run = await ctx.issueRunner.start(request({
      trackerTools: {
        provider: 'memory',
        tools: [{ name: 'tracker_fail', description: 'Fail.', parameters: { type: 'object' } }],
        secretEnvironmentNames: [],
        execute: () => Promise.resolve({ success: false, value: { error: 'denied' } }),
      },
    }))
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed', turns: 1 })
  })

  it('maps model failure, refresh failure, and eligibility endings', async () => {
    const model = await boot([])
    await expect((await model.ctx.issueRunner.start(request())).result)
      .resolves.toMatchObject({ stopReason: 'failed', error: 'MockAdapter: script exhausted' })

    const refresh = await boot([textResponse('done')])
    await expect((await refresh.ctx.issueRunner.start(request({
      refreshIssue: () => { throw 'refresh offline' },
    }))).result).resolves.toMatchObject({ stopReason: 'failed', error: 'refresh offline' })

    const refreshError = await boot([textResponse('done')])
    await expect((await refreshError.ctx.issueRunner.start(request({
      refreshIssue: () => { throw new Error('refresh failed') },
    }))).result).resolves.toMatchObject({ stopReason: 'failed', error: 'refresh failed' })

    const missing = await boot([textResponse('done')])
    await expect((await missing.ctx.issueRunner.start(request({
      refreshIssue: () => Promise.resolve(undefined),
      shouldContinue: () => { throw new Error('must not run') },
    }))).result).resolves.toMatchObject({ stopReason: 'completed', turns: 1 })
  })

  it('contains observer failure and supports cancellation plus idempotent disposal', async () => {
    const observed = await boot([textResponse('done')], { provider: 'mock', model: 'mock', maxTokens: 64 })
    const run = await observed.ctx.issueRunner.start(request({ onEvent: () => { throw new Error('observer') } }))
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    await run.dispose()
    await run.dispose()

    const hanging = await boot(['hang'])
    const controller = new AbortController()
    const cancelled = await hanging.ctx.issueRunner.start(request({ signal: controller.signal }))
    while (hanging.adapter.requests.length === 0) await new Promise(resolve => setTimeout(resolve, 1))
    controller.abort(new Error('operator stop'))
    cancelled.cancel()
    cancelled.cancel('again')
    await expect(cancelled.result).resolves.toMatchObject({ stopReason: 'cancelled' })
    await cancelled.dispose()

    const duringRefresh = await boot([textResponse('done')])
    const refreshController = new AbortController()
    const refreshCancelled = await duringRefresh.ctx.issueRunner.start(request({
      signal: refreshController.signal,
      onEvent: (event) => { if (event.kind === 'turn-ended') refreshController.abort(new Error('stop')) },
      refreshIssue: (signal) => { signal.throwIfAborted(); return Promise.resolve(target) },
    }))
    await expect(refreshCancelled.result).resolves.toMatchObject({ stopReason: 'cancelled', error: 'stop' })
  })

  it('rejects invalid config and requests before Agent publication', async () => {
    expect(() => new AgentIssueRunner(new Context(), { provider: ' ', model: 'mock' })).toThrow(/non-blank/)
    expect(() => new AgentIssueRunner(new Context(), { provider: 'mock', model: ' ' })).toThrow(/non-blank/)
    const { ctx } = await boot([textResponse('unused')])
    await expect(ctx.issueRunner.start(request({ attempt: 0 }))).rejects.toThrow(/attempt/)
    await expect(ctx.issueRunner.start(request({ maxTurns: 0 }))).rejects.toThrow(/maxTurns/)
    await expect(ctx.issueRunner.start(request({
      workspace: { ...workspace, issueId: TrackerIssueId('other') },
    }))).rejects.toThrow(/different issue/)
  })
})
