import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import TrackerRegistry, { TrackerIssueId, type TrackerIssue, type TrackerProvider } from '@deepseek-ai/dsh-tracker'
import { IssueWorkflow, type IssueWorkflowPolicy, type IssueWorkflowSnapshot } from '@deepseek-ai/dsh-issue-workflow'
import { IssueWorkspaceProvisioner, type IssueWorkspace } from '@deepseek-ai/dsh-issue-workspace'
import { IssueRunner, type IssueRun, type IssueRunId, type IssueRunRequest, type IssueRunResult } from '@deepseek-ai/dsh-issue-runner'
import { SessionId } from '@deepseek-ai/dsh-session'
import DurableIssueOrchestrator, { issueOrchestratorDomainSpec } from '../src/index.ts'
import type { IssueOrchestrationRecord } from '../src/spec.ts'

function issue(state = 'Todo'): TrackerIssue {
  return {
    id: TrackerIssueId('issue-1'),
    identifier: 'ENG-1',
    title: 'Run one automated issue',
    description: 'Prove durable orchestration.',
    priority: 1,
    state,
    labels: ['agent'],
    blockedBy: [],
    dispatchable: true,
    createdAt: 1,
  }
}

function secondIssue(state = 'Todo'): TrackerIssue {
  return { ...issue(state), id: TrackerIssueId('issue-2'), identifier: 'ENG-2', title: 'Second issue', createdAt: 2 }
}

const policy: IssueWorkflowPolicy = {
  trackerProvider: 'memory',
  activeStates: ['Todo', 'In Progress'],
  terminalStates: ['Done'],
  requiredLabels: ['agent'],
  pollIntervalMs: 60_000,
  maxConcurrentRuns: 1,
  maxConcurrentRunsByState: {},
  maxTurns: 2,
  continuationRetryMs: 10,
  maxContinuationAttempts: 0,
  failureRetryBaseMs: 20,
  maxRetryBackoffMs: 100,
  stallTimeoutMs: 60_000,
  promptTemplate: 'Work {{ issue.identifier }}: {{ issue.title }} attempt {{ attempt }}.',
  continuationTemplate: 'Continue {{ issue.identifier }}.',
}

class FakeWorkflow extends IssueWorkflow {
  snapshot: IssueWorkflowSnapshot = { path: '/WORKFLOW.md', revision: 'rev-1', loadedAt: 1, policy }
  current(): IssueWorkflowSnapshot { return this.snapshot }
  reload(): Promise<boolean> { return Promise.resolve(false) }
}

class FakeWorkspace extends IssueWorkspaceProvisioner {
  readonly removed: string[] = []
  prepare(target: TrackerIssue): Promise<IssueWorkspace> {
    return Promise.resolve({ issueId: target.id, path: `/work/${target.identifier}`, created: true, preparedAt: Date.now() })
  }
  locate(target: TrackerIssue): Promise<IssueWorkspace> {
    return Promise.resolve({ issueId: target.id, path: `/work/${target.identifier}`, created: false, preparedAt: Date.now() })
  }
  beforeRun(): Promise<void> { return Promise.resolve() }
  afterRun(): Promise<void> { return Promise.resolve() }
  remove(workspace: IssueWorkspace): Promise<void> { this.removed.push(workspace.path); return Promise.resolve() }
}

interface PendingRun {
  readonly request: IssueRunRequest
  readonly settle: (result: IssueRunResult) => void
  readonly run: IssueRun
}

class FakeRunner extends IssueRunner {
  readonly pending: PendingRun[] = []
  includeCancelError = true
  start(request: IssueRunRequest): Promise<IssueRun> {
    const result = Promise.withResolvers<IssueRunResult>()
    const sessionId = SessionId(`session-${this.pending.length + 1}`)
    let cancelled = false
    const run: IssueRun = {
      id: `run-${this.pending.length + 1}` as IssueRunId,
      sessionId,
      result: result.promise,
      cancel: (reason) => {
        if (cancelled) return
        cancelled = true
        result.resolve({
          stopReason: 'cancelled', sessionId, turns: 0,
          ...(this.includeCancelError ? { error: reason ?? 'cancelled' } : {}),
        })
      },
      dispose: async () => { run.cancel('disposed'); await result.promise },
    }
    this.pending.push({ request, settle: result.resolve, run })
    return Promise.resolve(run)
  }
}

async function eventually<T>(read: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    const value = read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition did not become true')
}

async function boot(
  initial: TrackerIssue[] = [issue()],
  options: {
    pool?: MemoryMediaPool
    policy?: Partial<IssueWorkflowPolicy>
    tracker?: Partial<TrackerProvider>
    workspace?: Partial<FakeWorkspace>
    runner?: Partial<FakeRunner>
    onContext?: (ctx: Context) => void
  } = {},
) {
  const ctx = new Context()
  await ctx.plugin(Storage)
  const pool = options.pool ?? new MemoryMediaPool()
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const domain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', domain)
  ctx.provide('storageDomain', domain)
  await ctx.plugin(TrackerRegistry)
  let issues = initial
  const tracker: TrackerProvider = {
    name: 'memory',
    fetchIssuesByStates: states => Promise.resolve(issues.filter(item => states.includes(item.state))),
    fetchIssuesByIds: ids => Promise.resolve(issues.filter(item => ids.includes(item.id))),
    bindTools: () => ({
      provider: 'memory', tools: [], secretEnvironmentNames: [],
      execute: () => Promise.resolve({ success: false, value: null }),
    }),
  }
  Object.assign(tracker, options.tracker)
  ctx.trackers.register(tracker)
  await ctx.plugin(FakeWorkflow)
  const workflow = ctx.issueWorkflow as FakeWorkflow
  workflow.snapshot = { ...workflow.snapshot, policy: { ...policy, ...options.policy } }
  await ctx.plugin(FakeWorkspace)
  Object.assign(ctx.issueWorkspace as FakeWorkspace, options.workspace)
  await ctx.plugin(FakeRunner)
  Object.assign(ctx.issueRunner as FakeRunner, options.runner)
  options.onContext?.(ctx)
  const fiber = ctx.plugin(DurableIssueOrchestrator)
  await fiber
  return {
    ctx,
    fiber,
    runner: ctx.issueRunner as FakeRunner,
    workspace: ctx.issueWorkspace as FakeWorkspace,
    workflow,
    tracker,
    pool,
    setIssues: (next: TrackerIssue[]) => { issues = next },
  }
}

async function seedRecord(
  pool: MemoryMediaPool,
  record: IssueOrchestrationRecord,
): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend(pool))
  const facility = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  const domain = await facility.open(issueOrchestratorDomainSpec)
  await domain.table('issues').put(record.issue.id, record)
  await domain.close()
  await ctx.fiber.dispose()
}

async function seedInterruptedRun(pool: MemoryMediaPool): Promise<void> {
  await seedRecord(pool, {
    provider: 'memory', workflowRevision: 'rev-old', issue: issue(), status: 'running', attempt: 1,
    workspacePath: '/work/ENG-1', sessionId: SessionId('lost-session'), startedAt: 1,
    lastProgressAt: 2, updatedAt: 2,
  })
}

describe('DurableIssueOrchestrator', () => {
  it('claims, revalidates, runs, and cleans a terminal issue', async () => {
    const harness = await boot()
    const running = await eventually(() => harness.ctx.issueOrchestration.snapshot().running[0])
    expect(running).toMatchObject({ status: 'running', attempt: 1, workspacePath: '/work/ENG-1' })
    expect(harness.runner.pending[0]?.request.prompt).toBe('Work ENG-1: Run one automated issue attempt 1.')
    expect(harness.runner.pending[0]?.request.continuationPrompt(2, 3)).toContain('Continuation turn 2 of 3')
    await expect(harness.runner.pending[0]?.request.refreshIssue(new AbortController().signal)).resolves.toMatchObject({ id: issue().id })
    expect(harness.runner.pending[0]?.request.shouldContinue(issue())).toBe(true)
    harness.runner.pending[0]?.request.onEvent?.({
      at: 99, kind: 'assistant', sessionId: SessionId('wrong-session'),
    })
    harness.runner.pending[0]?.request.onEvent?.({
      at: 100, kind: 'assistant', sessionId: SessionId('session-1'),
    })
    await eventually(() => harness.ctx.issueOrchestration.snapshot().running[0]?.lastProgressAt === 100 ? true : undefined)

    harness.setIssues([issue('Done')])
    harness.runner.pending[0]?.settle({
      stopReason: 'completed', sessionId: SessionId('session-1'), turns: 1,
    })
    await eventually(() => harness.ctx.issueOrchestration.snapshot().running.length === 0
      && harness.ctx.issueOrchestration.snapshot().retrying.length === 0 ? true : undefined)
    expect(harness.workspace.removed).toContain('/work/ENG-1')
    await harness.fiber.dispose()
  })

  it('persists blocked state and operator retry redispatches it', async () => {
    const harness = await boot()
    await eventually(() => harness.runner.pending[0])
    harness.runner.pending[0]?.settle({
      stopReason: 'blocked', sessionId: SessionId('session-1'), turns: 1, error: 'needs input',
    })
    const blocked = await eventually(() => harness.ctx.issueOrchestration.snapshot().blocked[0])
    expect(blocked).toMatchObject({ status: 'blocked', attempt: 2, error: 'needs input' })

    await harness.ctx.issueOrchestration.retry({ issueId: issue().id })
    harness.ctx.issueOrchestration.refresh()
    await eventually(() => harness.runner.pending[1])
    expect(harness.runner.pending[1]?.request.attempt).toBe(2)
    await harness.fiber.dispose()
  })

  it('rejects running and missing operator commands and releases blocked work', async () => {
    const harness = await boot()
    await eventually(() => harness.runner.pending[0])
    await expect(harness.ctx.issueOrchestration.retry({ issueId: issue().id })).rejects.toMatchObject({ code: 'ISSUE_RUNNING' })
    await expect(harness.ctx.issueOrchestration.release({ issueId: issue().id })).rejects.toMatchObject({ code: 'ISSUE_RUNNING' })
    harness.runner.pending[0]?.settle({
      stopReason: 'blocked', sessionId: SessionId('session-1'), turns: 1,
    })
    await eventually(() => harness.ctx.issueOrchestration.snapshot().blocked[0])
    await harness.ctx.issueOrchestration.release({ issueId: issue().id })
    expect(harness.ctx.issueOrchestration.snapshot().blocked).toEqual([])
    await expect(harness.ctx.issueOrchestration.retry({ issueId: TrackerIssueId('missing') }))
      .rejects.toMatchObject({ code: 'ISSUE_NOT_FOUND' })
    await expect(harness.ctx.issueOrchestration.release({ issueId: TrackerIssueId('missing') }))
      .rejects.toMatchObject({ code: 'ISSUE_NOT_FOUND' })
    await harness.fiber.dispose()
  })

  it('uses bounded retry timing and preserves the incremented attempt', async () => {
    const harness = await boot()
    await eventually(() => harness.runner.pending[0])
    harness.runner.pending[0]?.settle({
      stopReason: 'failed', sessionId: SessionId('session-1'), turns: 1, error: 'transport',
    })
    const retrying = await eventually(() => harness.ctx.issueOrchestration.snapshot().retrying[0])
    expect(retrying).toMatchObject({ status: 'retrying', attempt: 2, error: 'transport' })
    await eventually(() => harness.runner.pending[1], 1_000)
    expect(harness.runner.pending[1]?.request.attempt).toBe(2)
    await harness.fiber.dispose()
  })

  it('does not oversubscribe capacity and dispatches the next issue after settlement', async () => {
    const harness = await boot([issue(), secondIssue()])
    await eventually(() => harness.runner.pending[0])
    expect(harness.runner.pending).toHaveLength(1)
    harness.setIssues([issue('Done'), secondIssue()])
    harness.runner.pending[0]?.settle({
      stopReason: 'completed', sessionId: SessionId('session-1'), turns: 1,
    })
    await eventually(() => harness.runner.pending[1])
    expect(harness.runner.pending[1]?.request.issue.identifier).toBe('ENG-2')
    await harness.fiber.dispose()
  })

  it('queues a growing continuation retry while the completed issue remains active', async () => {
    const harness = await boot()
    await eventually(() => harness.runner.pending[0])
    harness.runner.pending[0]?.settle({
      stopReason: 'completed', sessionId: SessionId('session-1'), turns: 2,
    })
    const first = await eventually(() => harness.ctx.issueOrchestration.snapshot().retrying[0])
    expect(first).toMatchObject({ attempt: 2, error: 'issue remains active after the completed run' })
    await eventually(() => harness.runner.pending[1])
    expect(harness.runner.pending[1]?.request.attempt).toBe(2)
    harness.runner.pending[1]?.settle({
      stopReason: 'completed', sessionId: SessionId('session-2'), turns: 2,
    })
    const second = await eventually(() => harness.ctx.issueOrchestration.snapshot().retrying[0]?.attempt === 3
      ? harness.ctx.issueOrchestration.snapshot().retrying[0] : undefined)
    expect(second).toMatchObject({ attempt: 3 })
    // Exponential continuation backoff: each redispatch waits longer than the previous one.
    expect((second.nextRetryAt ?? 0) - second.updatedAt).toBeGreaterThan((first.nextRetryAt ?? 0) - first.updatedAt)
    await harness.fiber.dispose()
  })

  it('parks a still-eligible issue in blocked state at the continuation bound', async () => {
    const harness = await boot([issue()], {
      policy: { continuationRetryMs: 10, maxContinuationAttempts: 2, maxRetryBackoffMs: 100 },
    })
    for (let run = 0; run < 3; run += 1) {
      await eventually(() => harness.runner.pending[run])
      harness.runner.pending[run]?.settle({
        stopReason: 'completed', sessionId: SessionId(`session-${String(run + 1)}`), turns: 1,
      })
    }
    const parked = await eventually(() => {
      const entry = harness.ctx.issueOrchestration.snapshot().blocked[0]
      return entry?.error?.includes('continuation bound of 2 reached') ? entry : undefined
    })
    expect(parked).toMatchObject({ attempt: 3, workspacePath: '/work/ENG-1' })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(harness.runner.pending).toHaveLength(3)
    await harness.fiber.dispose()
  })

  it('coalesces refresh and exposes committed revision changes', async () => {
    const harness = await boot([])
    const before = harness.ctx.issueOrchestration.snapshot().revision
    const first = harness.ctx.issueOrchestration.refresh()
    const second = harness.ctx.issueOrchestration.refresh()
    expect(first.queued).toBe(true)
    expect(second.coalesced).toBe(true)
    await eventually(() => harness.ctx.issueOrchestration.snapshot().revision > before ? true : undefined)
    await harness.fiber.dispose()
  })

  it('recovers an interrupted durable running row as the next attempt', async () => {
    const pool = new MemoryMediaPool()
    await seedInterruptedRun(pool)
    const harness = await boot([issue()], { pool })
    await eventually(() => harness.runner.pending[0])
    expect(harness.runner.pending[0]?.request.attempt).toBe(2)
    expect(harness.ctx.issueOrchestration.snapshot().running[0]).toMatchObject({ attempt: 2 })
    await harness.fiber.dispose()
  })

  it('cancels a silent run and retries it through the durable backoff path', async () => {
    const harness = await boot([issue()], {
      policy: { pollIntervalMs: 10, stallTimeoutMs: 20, failureRetryBaseMs: 10 },
    })
    await eventually(() => harness.runner.pending[0])
    await eventually(() => harness.runner.pending[1], 1_000)
    expect(await harness.runner.pending[0]?.run.result).toMatchObject({ stopReason: 'cancelled' })
    expect(harness.runner.pending[1]?.request.attempt).toBe(2)
    await harness.fiber.dispose()
  })

  it('contains startup terminal-fetch and cleanup failures', async () => {
    const fetchPool = new MemoryMediaPool()
    await seedRecord(fetchPool, {
      provider: 'memory', workflowRevision: 'old', issue: issue('Done'), status: 'blocked', attempt: 2,
      updatedAt: 1,
    })
    const first = await boot([issue('Done')], {
      pool: fetchPool,
      tracker: { fetchIssuesByIds: () => Promise.reject(new Error('tracker offline')) },
    })
    await first.fiber.dispose()

    const pool = new MemoryMediaPool()
    await seedRecord(pool, {
      provider: 'memory', workflowRevision: 'old', issue: issue('Done'), status: 'blocked', attempt: 2,
      updatedAt: 1,
    })
    const second = await boot([issue('Done')], {
      pool,
      workspace: { remove: () => Promise.reject(new Error('cannot remove')) },
    })
    await second.fiber.dispose()
  })

  it('turns template, workspace, and runner startup failures into durable retries', async () => {
    const template = await boot([issue()], { policy: { promptTemplate: '{{ unknown }}' } })
    await eventually(() => template.ctx.issueOrchestration.snapshot().retrying[0])
    expect(template.runner.pending).toHaveLength(0)
    await template.fiber.dispose()

    const workspace = await boot([issue()], {
      workspace: { prepare: () => Promise.reject(new Error('workspace offline')) },
    })
    await eventually(() => workspace.ctx.issueOrchestration.snapshot().retrying[0])
    await workspace.fiber.dispose()

    const runner = await boot([issue()], {
      runner: { start: () => Promise.reject(new Error('runner failed')) },
    })
    await eventually(() => runner.ctx.issueOrchestration.snapshot().retrying[0])
    await runner.fiber.dispose()
  })

  it.each([
    { label: 'missing', next: [] as TrackerIssue[], removed: false },
    { label: 'terminal', next: [issue('Done')], removed: true },
    { label: 'unroutable', next: [{ ...issue(), dispatchable: false }], removed: false },
  ])('reconciles a running issue that becomes $label', async ({ next, removed }) => {
    const harness = await boot()
    await eventually(() => harness.runner.pending[0])
    harness.setIssues(next)
    harness.ctx.issueOrchestration.refresh()
    await expect(harness.runner.pending[0]?.run.result).resolves.toMatchObject({ stopReason: 'cancelled' })
    await eventually(() => harness.ctx.issueOrchestration.snapshot().running.length === 0 ? true : undefined)
    expect(harness.workspace.removed.includes('/work/ENG-1')).toBe(removed)
    await harness.fiber.dispose()
  })

  it('keeps a running issue when reconciliation transport fails', async () => {
    const harness = await boot()
    await eventually(() => harness.runner.pending[0])
    harness.tracker.fetchIssuesByIds = () => Promise.reject(new Error('refresh offline'))
    harness.ctx.issueOrchestration.refresh()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(harness.ctx.issueOrchestration.snapshot().running).toHaveLength(1)
    await harness.fiber.dispose()
  })

  it.each([
    { label: 'missing', next: [] as TrackerIssue[], removed: false },
    { label: 'terminal', next: [issue('Done')], removed: true },
    { label: 'eligible update', next: [{ ...issue(), title: 'Updated title' }], removed: false },
  ])('reconciles blocked work for $label', async ({ next, removed }) => {
    const harness = await boot()
    await eventually(() => harness.runner.pending[0])
    harness.runner.pending[0]?.settle({ stopReason: 'blocked', sessionId: SessionId('session-1'), turns: 1 })
    await eventually(() => harness.ctx.issueOrchestration.snapshot().blocked[0])
    harness.setIssues(next)
    harness.ctx.issueOrchestration.refresh()
    if (next.length === 1 && next[0]?.state !== 'Done') {
      await eventually(() => harness.ctx.issueOrchestration.snapshot().blocked[0]?.issue.title === 'Updated title'
        ? true : undefined)
    } else {
      await eventually(() => harness.ctx.issueOrchestration.snapshot().blocked.length === 0 ? true : undefined)
    }
    expect(harness.workspace.removed.includes('/work/ENG-1')).toBe(removed)
    await harness.fiber.dispose()
  })

  it('keeps blocked work when its reconciliation read fails', async () => {
    const harness = await boot()
    await eventually(() => harness.runner.pending[0])
    harness.runner.pending[0]?.settle({ stopReason: 'blocked', sessionId: SessionId('session-1'), turns: 1 })
    await eventually(() => harness.ctx.issueOrchestration.snapshot().blocked[0])
    harness.tracker.fetchIssuesByIds = () => Promise.reject(new Error('blocked refresh offline'))
    harness.ctx.issueOrchestration.refresh()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(harness.ctx.issueOrchestration.snapshot().blocked).toHaveLength(1)
    await harness.fiber.dispose()
  })

  it.each([
    { label: 'missing', issueValue: undefined },
    { label: 'terminal', issueValue: issue('Done') },
    { label: 'unroutable', issueValue: { ...issue(), dispatchable: false } },
  ])('settles a due retry whose exact refresh is $label', async ({ issueValue }) => {
    const pool = new MemoryMediaPool()
    await seedRecord(pool, {
      provider: 'memory', workflowRevision: 'old', issue: issue(), status: 'retrying', attempt: 2,
      workspacePath: '/work/ENG-1', nextRetryAt: 0, updatedAt: 1,
    })
    const harness = await boot(issueValue === undefined ? [] : [issueValue], { pool })
    await eventually(() => {
      const snapshot = harness.ctx.issueOrchestration.snapshot()
      return snapshot.running.length + snapshot.retrying.length + snapshot.blocked.length === 0 ? true : undefined
    })
    expect(harness.runner.pending).toHaveLength(0)
    await harness.fiber.dispose()
  })

  it('reschedules a due retry while capacity is full', async () => {
    const pool = new MemoryMediaPool()
    await seedRecord(pool, {
      provider: 'memory', workflowRevision: 'old', issue: issue(), status: 'retrying', attempt: 2,
      nextRetryAt: 0, updatedAt: 1,
    })
    await seedRecord(pool, {
      provider: 'memory', workflowRevision: 'old', issue: secondIssue(), status: 'retrying', attempt: 2,
      nextRetryAt: 0, updatedAt: 1,
    })
    const harness = await boot([issue(), secondIssue()], { pool })
    await eventually(() => harness.runner.pending[0])
    const queued = await eventually(() => harness.ctx.issueOrchestration.snapshot().retrying[0])
    expect(queued.error).toBe('waiting for an orchestration capacity slot')
    await harness.fiber.dispose()
  })

  it.each([
    { label: 'missing', refresh: () => Promise.resolve([] as TrackerIssue[]) },
    { label: 'stale', refresh: () => Promise.resolve([{ ...issue(), dispatchable: false }]) },
    { label: 'failed', refresh: () => Promise.reject(new Error('candidate refresh failed')) },
  ])('revalidates a candidate that is $label before dispatch', async ({ refresh, label }) => {
    const harness = await boot([], {
      tracker: {
        fetchIssuesByStates: states => Promise.resolve(states.includes('Todo') ? [issue()] : []),
        fetchIssuesByIds: refresh,
      },
    })
    if (label === 'failed') {
      await eventually(() => harness.ctx.issueOrchestration.snapshot().retrying[0])
    } else {
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(harness.ctx.issueOrchestration.snapshot().running).toEqual([])
    }
    expect(harness.runner.pending).toHaveLength(0)
    await harness.fiber.dispose()
  })

  it('batches exact-id revalidation into one provider read per tick group', async () => {
    let candidateCalls = 0
    const harness = await boot([issue(), secondIssue()], {
      policy: { maxConcurrentRuns: 2 },
      tracker: {
        fetchIssuesByIds: (ids) => {
          candidateCalls += 1
          return Promise.resolve([issue(), secondIssue()].filter(item => ids.includes(item.id)))
        },
      },
    })
    await eventually(() => harness.runner.pending.length === 2 ? true : undefined)
    expect(candidateCalls).toBe(1)
    await harness.fiber.dispose()

    const pool = new MemoryMediaPool()
    await seedRecord(pool, {
      provider: 'memory', workflowRevision: 'old', issue: issue(), status: 'retrying', attempt: 2,
      nextRetryAt: 0, updatedAt: 1,
    })
    await seedRecord(pool, {
      provider: 'memory', workflowRevision: 'old', issue: secondIssue(), status: 'retrying', attempt: 2,
      nextRetryAt: 0, updatedAt: 1,
    })
    let retryCalls = 0
    const due = await boot([issue(), secondIssue()], {
      pool,
      policy: { maxConcurrentRuns: 2 },
      tracker: {
        fetchIssuesByIds: (ids) => {
          retryCalls += 1
          return Promise.resolve([issue(), secondIssue()].filter(item => ids.includes(item.id)))
        },
      },
    })
    await eventually(() => due.runner.pending.length === 2 ? true : undefined)
    // One startup claim cleanup read plus one due-retry revalidation read for both records.
    expect(retryCalls).toBe(2)
    await due.fiber.dispose()
  })

  it('keeps polling when the workflow read fails inside a tick', async () => {
    let changes = 0
    const harness = await boot([], {
      policy: { pollIntervalMs: 10 },
      onContext: (ctx) => { ctx.on('issue-orchestration/changed', () => { changes += 1 }) },
    })
    await eventually(() => changes >= 4 ? true : undefined)
    const broken = new Error('workflow read failed')
    harness.workflow.reload = () => Promise.reject(broken)
    harness.workflow.current = () => { throw broken }
    const atBreak = changes
    await eventually(() => changes >= atBreak + 4 ? true : undefined)
    await harness.fiber.dispose()
  })

  it('contains a complete poll failure and diagnoses a direct pre-initialization read', async () => {
    const direct = new DurableIssueOrchestrator(new Context())
    expect(() => direct.snapshot()).toThrow(/domain is not open/)
    const harness = await boot([], {
      tracker: {
        fetchIssuesByStates: states => states.includes('Done')
          ? Promise.resolve([])
          : Promise.reject(new Error('poll offline')),
      },
    })
    await eventually(() => harness.ctx.issueOrchestration.snapshot().revision >= 2 ? true : undefined)
    expect(harness.ctx.issueOrchestration.snapshot().checking).toBe(false)
    await harness.fiber.dispose()
  })

  it('sorts priority and tie-breakers and renders absent optional issue text', async () => {
    const sparse = (({ description: _description, createdAt: _createdAt, priority: _priority, ...rest }) => rest)(issue())
    const low = { ...sparse, id: TrackerIssueId('low'), identifier: 'ZZZ', priority: 9 }
    const tied = { ...sparse, id: TrackerIssueId('tied'), identifier: 'AAA' }
    const preferred = { ...sparse, id: TrackerIssueId('preferred'), identifier: 'MID', priority: 2 }
    const harness = await boot([low, tied, preferred], {
      policy: { promptTemplate: '{{ issue.description }}|{{ issue.url }}|{{ issue.id }}' },
    })
    await eventually(() => harness.runner.pending[0])
    expect(harness.runner.pending[0]?.request.issue.id).toBe(preferred.id)
    expect(harness.runner.pending[0]?.request.prompt).toBe(`||${preferred.id}`)
    await harness.fiber.dispose()
  })

  it('publishes checking state before the next poll is armed', async () => {
    let observed = false
    const harness = await boot([], {
      onContext: (ctx) => {
        ctx.on('issue-orchestration/changed', () => {
          const service = ctx.get('issueOrchestration')
          if (service === undefined) return
          const current = service.snapshot()
          if (current.checking && current.nextPollAt === undefined) observed = true
        })
      },
    })
    await eventually(() => observed ? true : undefined)
    await harness.fiber.dispose()
  })

  it('deletes a stored terminal claim during startup cleanup through locate', async () => {
    const pool = new MemoryMediaPool()
    await seedRecord(pool, {
      provider: 'memory', workflowRevision: 'old', issue: issue('Done'), status: 'blocked', attempt: 2,
      updatedAt: 1,
    })
    const harness = await boot([issue('Done')], { pool })
    expect(harness.ctx.issueOrchestration.snapshot().blocked).toEqual([])
    expect(harness.workspace.removed).toContain('/work/ENG-1')
    await harness.fiber.dispose()
  })

  it('leaves a record-less terminal issue untouched at startup', async () => {
    let stateFetches = 0
    const harness = await boot([issue('Done')], {
      tracker: { fetchIssuesByStates: (states) => { stateFetches += 1; return Promise.resolve(states.includes('Done') ? [issue('Done')] : []) } },
    })
    expect(harness.workspace.removed).toEqual([])
    expect(stateFetches).toBe(0)
    await harness.fiber.dispose()
  })

  it('handles due retry terminal cleanup and refresh failure after startup', async () => {
    const terminalPool = new MemoryMediaPool()
    await seedRecord(terminalPool, {
      provider: 'memory', workflowRevision: 'old', issue: issue(), status: 'retrying', attempt: 2,
      nextRetryAt: 0, updatedAt: 1,
    })
    const terminal = await boot([], {
      pool: terminalPool,
      tracker: {
        fetchIssuesByStates: () => Promise.resolve([]),
        fetchIssuesByIds: () => Promise.resolve([issue('Done')]),
      },
    })
    await eventually(() => terminal.ctx.issueOrchestration.snapshot().retrying.length === 0 ? true : undefined)
    expect(terminal.workspace.removed).toContain('/work/ENG-1')
    await terminal.fiber.dispose()

    const failurePool = new MemoryMediaPool()
    await seedRecord(failurePool, {
      provider: 'memory', workflowRevision: 'old', issue: issue(), status: 'retrying', attempt: 2,
      nextRetryAt: 0, updatedAt: 1,
    })
    const failure = await boot([], {
      pool: failurePool,
      tracker: {
        fetchIssuesByStates: () => Promise.resolve([]),
        fetchIssuesByIds: () => Promise.reject(new Error('due refresh offline')),
      },
    })
    const retried = await eventually(() => {
      const entry = failure.ctx.issueOrchestration.snapshot().retrying[0]
      return entry?.attempt === 3 ? entry : undefined
    })
    expect(retried).toMatchObject({ attempt: 3, error: 'due refresh offline' })
    await failure.fiber.dispose()
  })

  it('uses fallback settlement errors and retries a completed refresh failure', async () => {
    const stalled = await boot([issue()], {
      policy: { pollIntervalMs: 10, stallTimeoutMs: 20, failureRetryBaseMs: 10 },
      runner: { includeCancelError: false },
    })
    await eventually(() => stalled.runner.pending[1], 1_000)
    expect(stalled.ctx.issueOrchestration.snapshot().running[0]?.attempt).toBe(2)
    await stalled.fiber.dispose()

    const failed = await boot([issue()])
    await eventually(() => failed.runner.pending[0])
    failed.runner.pending[0]?.settle({ stopReason: 'failed', sessionId: SessionId('session-1'), turns: 1 })
    await eventually(() => failed.ctx.issueOrchestration.snapshot().retrying[0]?.error === 'failed' ? true : undefined)
    await failed.fiber.dispose()

    const completed = await boot([issue()])
    await eventually(() => completed.runner.pending[0])
    completed.tracker.fetchIssuesByIds = () => Promise.reject(new Error('completion refresh failed'))
    completed.runner.pending[0]?.settle({ stopReason: 'completed', sessionId: SessionId('session-1'), turns: 1 })
    await eventually(() => completed.ctx.issueOrchestration.snapshot().retrying[0]?.error === 'completion refresh failed'
      ? true : undefined)
    await completed.fiber.dispose()

    const inactive = await boot([issue()])
    await eventually(() => inactive.runner.pending[0])
    inactive.setIssues([issue('Human Review')])
    inactive.runner.pending[0]?.settle({
      stopReason: 'completed', sessionId: SessionId('session-1'), turns: 1,
    })
    await eventually(() => inactive.ctx.issueOrchestration.snapshot().running.length === 0 ? true : undefined)
    expect(inactive.workspace.removed).not.toContain('/work/ENG-1')
    await inactive.fiber.dispose()
  })

  it('treats a retry record without a due timestamp as immediately due', async () => {
    const pool = new MemoryMediaPool()
    await seedRecord(pool, {
      provider: 'memory', workflowRevision: 'old', issue: issue(), status: 'retrying', attempt: 2,
      updatedAt: 1,
    })
    const harness = await boot([issue()], { pool })
    await eventually(() => harness.runner.pending[0])
    expect(harness.runner.pending[0]?.request.attempt).toBe(2)
    await harness.fiber.dispose()
  })

  it('enforces per-state capacity and groups multiple blocked records for one provider', async () => {
    const pool = new MemoryMediaPool()
    await seedRecord(pool, {
      provider: 'memory', workflowRevision: 'old', issue: issue(), status: 'retrying', attempt: 2,
      nextRetryAt: 0, updatedAt: 1,
    })
    await seedRecord(pool, {
      provider: 'memory', workflowRevision: 'old', issue: secondIssue(), status: 'retrying', attempt: 2,
      nextRetryAt: 0, updatedAt: 1,
    })
    const capacity = await boot([issue(), secondIssue()], {
      pool,
      policy: { maxConcurrentRuns: 2, maxConcurrentRunsByState: { todo: 1 } },
    })
    await eventually(() => capacity.runner.pending[0])
    expect(capacity.ctx.issueOrchestration.snapshot().retrying[0]?.error)
      .toBe('waiting for an orchestration capacity slot')
    await capacity.fiber.dispose()

    const blockedPool = new MemoryMediaPool()
    await seedRecord(blockedPool, {
      provider: 'memory', workflowRevision: 'old', issue: issue(), status: 'blocked', attempt: 2, updatedAt: 1,
    })
    await seedRecord(blockedPool, {
      provider: 'memory', workflowRevision: 'old', issue: secondIssue(), status: 'blocked', attempt: 2, updatedAt: 1,
    })
    const grouped = await boot([issue(), secondIssue()], { pool: blockedPool })
    await eventually(() => grouped.ctx.issueOrchestration.snapshot().blocked.every(entry => entry.updatedAt > 1)
      ? true : undefined)
    await grouped.fiber.dispose()
  })
})
