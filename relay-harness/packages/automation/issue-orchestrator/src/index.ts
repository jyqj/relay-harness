/**
 * Durable single-writer issue scheduler with reconciliation, retry, blocked state, and recovery.
 * @module @relay-harness/rlh-issue-orchestrator
 */

import { Context, Service } from '@relay-harness/cordis'
import { Remote, TypertRemoteService } from '@relay-harness/rlh-typert-protocol'
import type { KvTable } from '@relay-harness/rlh-storage-domain'
import { IssueOrchestrationError } from '@relay-harness/rlh-issue-orchestration'
import type {
  IssueCommand,
  IssueOrchestrationEntry,
  IssueOrchestrationSnapshot,
  IssueRefreshResult,
} from '@relay-harness/rlh-issue-orchestration'
import type { IssueRun, IssueRunEvent, IssueRunResult } from '@relay-harness/rlh-issue-runner'
import type { IssueWorkspace } from '@relay-harness/rlh-issue-workspace'
import type { IssueWorkflowPolicy } from '@relay-harness/rlh-issue-workflow'
import type { TrackerIssue, TrackerProvider } from '@relay-harness/rlh-tracker'
import type { TrackerIssueId } from '@relay-harness/rlh-tracker/types'
import { issueOrchestratorDomainSpec, type IssueOrchestrationRecord } from './spec.ts'

export { issueOrchestratorDomainSpec, issueOrchestrationRecord, trackerIssue } from './spec.ts'

interface LiveRun {
  readonly run: IssueRun
  readonly workspace: IssueWorkspace
  issue: TrackerIssue
  disposition?: 'terminal' | 'release' | 'retry'
}

type IssueTable = KvTable<TrackerIssueId, IssueOrchestrationRecord>

/** Poll cadence for a tick whose policy read failed and left no cached interval; matches the workflow-file default. */
const TICK_FALLBACK_POLL_INTERVAL_MS = 30_000

function normalized(value: string): string {
  return value.trim().toLowerCase()
}

function issueEligible(issue: TrackerIssue, policy: IssueWorkflowPolicy): boolean {
  const active = new Set(policy.activeStates.map(normalized))
  const terminal = new Set(policy.terminalStates.map(normalized))
  const labels = new Set(issue.labels.map(normalized))
  return issue.dispatchable
    && active.has(normalized(issue.state))
    && !terminal.has(normalized(issue.state))
    && policy.requiredLabels.every(label => labels.has(normalized(label)))
}

function terminalIssue(issue: TrackerIssue, policy: IssueWorkflowPolicy): boolean {
  return policy.terminalStates.some(state => normalized(state) === normalized(issue.state))
}

function compareIssues(left: TrackerIssue, right: TrackerIssue): number {
  const leftPriority = left.priority !== undefined && left.priority >= 1 && left.priority <= 4
    ? left.priority : 5
  const rightPriority = right.priority !== undefined && right.priority >= 1 && right.priority <= 4
    ? right.priority : 5
  return leftPriority - rightPriority
    || (left.createdAt ?? Number.MAX_SAFE_INTEGER) - (right.createdAt ?? Number.MAX_SAFE_INTEGER)
    || left.identifier.localeCompare(right.identifier)
}

function renderTemplate(template: string, issue: TrackerIssue, attempt: number): string {
  const values: Record<string, string> = {
    'issue.id': issue.id,
    'issue.identifier': issue.identifier,
    'issue.title': issue.title,
    'issue.description': issue.description ?? '',
    'issue.state': issue.state,
    'issue.url': issue.url ?? '',
    attempt: String(attempt),
  }
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_match, key: string) => {
    const value = values[key]
    if (value === undefined) throw new Error(`issue workflow template references unknown value ${JSON.stringify(key)}`)
    return value
  })
}

function view(record: IssueOrchestrationRecord): IssueOrchestrationEntry {
  return structuredClone({
    issue: record.issue,
    status: record.status,
    attempt: record.attempt,
    ...(record.workspacePath === undefined ? {} : { workspacePath: record.workspacePath }),
    ...(record.sessionId === undefined ? {} : { sessionId: record.sessionId }),
    ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }),
    ...(record.lastProgressAt === undefined ? {} : { lastProgressAt: record.lastProgressAt }),
    ...(record.nextRetryAt === undefined ? {} : { nextRetryAt: record.nextRetryAt }),
    ...(record.error === undefined ? {} : { error: record.error }),
    updatedAt: record.updatedAt,
  })
}

function workspaceFrom(record: IssueOrchestrationRecord): IssueWorkspace | undefined {
  return record.workspacePath === undefined ? undefined : {
    issueId: record.issue.id,
    path: record.workspacePath,
    created: false,
    preparedAt: record.updatedAt,
  }
}

/** Local-timer provider; durable records, not timers or live handles, own restart recovery. */
export class DurableIssueOrchestrator extends TypertRemoteService {
  static inject = ['trackers', 'issueWorkflow', 'issueWorkspace', 'issueRunner', 'storageDomain']

  private table?: IssueTable
  private domainClose!: () => Promise<void>
  private readonly live = new Map<TrackerIssueId, LiveRun>()
  private chain: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined
  private nextPollAt: number | undefined
  private lastPollIntervalMs: number | undefined
  private checking = false
  private stopping = false
  private revision = 0

  constructor(ctx: Context) {
    super(ctx, 'issueOrchestration')
  }

  protected async [Service.init](): Promise<void> {
    const domain = await this.ctx.storageDomain.open(issueOrchestratorDomainSpec)
    this.table = domain.table('issues')
    this.domainClose = () => domain.close()
    await this.recoverInterruptedRuns()
    await this.cleanupTerminalWorkspaces()
    this.schedule(0)
    this.ctx.effect(() => async () => {
      this.stopping = true
      /* v8 ignore next -- timer absence is the narrow teardown-during-tick case; the active tick is joined through chain below. */
      if (this.timer !== undefined) clearTimeout(this.timer)
      this.timer = undefined
      this.nextPollAt = undefined
      const runs = [...this.live.values()]
      for (const entry of runs) entry.run.cancel('issue orchestrator disposed')
      await Promise.allSettled(runs.map(entry => entry.run.dispose()))
      this.live.clear()
      await this.chain
      await this.domainClose()
    }, 'issue-orchestrator.lifecycle()')
  }

  /**
   * Read committed records and poll state.
   * @returns A detached projection.
   */
  @Remote
  snapshot(): IssueOrchestrationSnapshot {
    const records = [...this.requireTable().entries()].map(([, record]) => view(record))
    const workflowRevision = this.ctx.issueWorkflow.current().revision
    return {
      revision: this.revision,
      workflowRevision,
      checking: this.checking,
      ...(this.nextPollAt === undefined ? {} : { nextPollAt: this.nextPollAt }),
      running: records.filter(record => record.status === 'claimed' || record.status === 'running'),
      retrying: records.filter(record => record.status === 'retrying'),
      blocked: records.filter(record => record.status === 'blocked'),
    }
  }

  /**
   * Request an immediate poll.
   * @returns A coalescing receipt.
   */
  @Remote
  refresh(): IssueRefreshResult {
    const coalesced = this.checking || (this.nextPollAt !== undefined && this.nextPollAt <= Date.now())
    if (!coalesced) this.schedule(0)
    return { queued: true, coalesced, requestedAt: Date.now() }
  }

  /**
   * Retry blocked or queued work.
   * @param command Issue to retry now.
   * @returns After the durable transition.
   */
  @Remote
  retry(command: IssueCommand): Promise<void> {
    return this.enqueue(async () => {
      const record = this.requireRecord(command.issueId)
      if (record.status === 'running' || record.status === 'claimed') {
        throw new IssueOrchestrationError(`issue ${command.issueId} is currently running`, 'ISSUE_RUNNING')
      }
      await this.put(command.issueId, {
        ...record,
        status: 'retrying',
        nextRetryAt: Date.now(),
        updatedAt: Date.now(),
      })
      this.schedule(0)
    })
  }

  /**
   * Release a non-running claim.
   * @param command Issue to release.
   * @returns After durable deletion.
   */
  @Remote
  release(command: IssueCommand): Promise<void> {
    return this.enqueue(async () => {
      const record = this.requireRecord(command.issueId)
      if (record.status === 'running' || record.status === 'claimed') {
        throw new IssueOrchestrationError(`issue ${command.issueId} is currently running`, 'ISSUE_RUNNING')
      }
      await this.delete(command.issueId)
    })
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const slice = this.chain.then(operation)
    this.chain = slice.catch((error: unknown) => {
      this.ctx.logger.error(`issue orchestrator operation failed: ${String(error)}`)
    })
    return slice
  }

  private schedule(delayMs: number): void {
    if (this.stopping) return
    const target = Date.now() + Math.max(0, delayMs)
    if (this.timer !== undefined && this.nextPollAt !== undefined && this.nextPollAt <= target) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.nextPollAt = target
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.nextPollAt = undefined
      void this.enqueue(() => this.tick())
    }, Math.max(0, target - Date.now()))
    this.timer.unref()
  }

  private async tick(): Promise<void> {
    /* v8 ignore next -- schedule clears every timer before teardown sets stopping; no stopped tick is admitted. */
    if (this.stopping) return
    this.checking = true
    this.publish()
    // Resolve the failure cadence before any throwing call so a broken workflow read cannot stall the poll loop.
    const fallbackDelayMs = this.fallbackPollDelayMs()
    try {
      await this.ctx.issueWorkflow.reload()
      const policy = this.ctx.issueWorkflow.current().policy
      await this.reconcile(policy)
      await this.dispatchDueRetries(policy)
      await this.dispatchCandidates(policy)
      this.schedule(this.nextDriveDelay(policy))
    } catch (error: unknown) {
      this.ctx.logger.error(`issue orchestrator poll failed: ${String(error)}`)
      this.schedule(fallbackDelayMs)
    } finally {
      this.checking = false
      this.publish()
    }
  }

  /** Poll cadence for a failed tick; never throws, so the loop always re-arms. */
  private fallbackPollDelayMs(): number {
    try {
      const { pollIntervalMs } = this.ctx.issueWorkflow.current().policy
      this.lastPollIntervalMs = pollIntervalMs
      return pollIntervalMs
    } catch {
      /* v8 ignore next -- an unreadable workflow before any successful tick never cached an interval;
         the workflow-file default keeps polling. */
      return this.lastPollIntervalMs ?? TICK_FALLBACK_POLL_INTERVAL_MS
    }
  }

  private async recoverInterruptedRuns(): Promise<void> {
    const now = Date.now()
    for (const [id, record] of this.requireTable().entries()) {
      if (record.status !== 'running' && record.status !== 'claimed') continue
      await this.put(id, {
        ...record,
        status: 'retrying',
        attempt: record.attempt + 1,
        nextRetryAt: now,
        error: 'recovered an interrupted host run after restart',
        updatedAt: now,
      })
    }
  }

  /**
   * Remove workspaces for claimed issues that ended terminal. Only issues with a durable
   * claim record are touched: a record-less tracker directory is never deleted, so startup
   * cost scales with locally claimed work, not with the provider's terminal backlog.
   */
  private async cleanupTerminalWorkspaces(): Promise<void> {
    const { policy } = this.ctx.issueWorkflow.current()
    const groups = this.groupRecords(['claimed', 'running', 'retrying', 'blocked'])
    for (const [providerName, records] of groups) {
      let issues: readonly TrackerIssue[]
      try {
        issues = await this.ctx.trackers.require(providerName).fetchIssuesByIds(records.map(([id]) => id))
      } catch (error: unknown) {
        this.ctx.logger.warn(`issue orchestrator startup terminal cleanup skipped for provider ${providerName}: ${String(error)}`)
        continue
      }
      const visible = new Map(issues.map(issue => [issue.id, issue]))
      for (const [id, record] of records) {
        const issue = visible.get(id)
        if (issue === undefined || !terminalIssue(issue, policy)) continue
        try {
          await this.cleanupRecord(record, issue)
          await this.delete(id)
        } catch (error: unknown) {
          this.ctx.logger.warn(`terminal workspace cleanup failed for ${issue.identifier}: ${String(error)}`)
        }
      }
    }
  }

  private async reconcile(policy: IssueWorkflowPolicy): Promise<void> {
    await this.reconcileRunning(policy)
    await this.reconcileBlocked(policy)
  }

  private async reconcileRunning(policy: IssueWorkflowPolicy): Promise<void> {
    const now = Date.now()
    for (const [issueId, entry] of this.live) {
      const record = this.requireTable().get(issueId)
      /* v8 ignore next -- live publication follows the running record commit and operators cannot delete running rows. */
      if (record === undefined) continue
      const lastProgressAt = record.lastProgressAt
      /* v8 ignore next -- every live entry is published only after its running record commits lastProgressAt. */
      if (lastProgressAt === undefined) throw new Error(`live issue ${issueId} has no last-progress timestamp`)
      if (policy.stallTimeoutMs > 0 && now - lastProgressAt > policy.stallTimeoutMs) {
        entry.disposition = 'retry'
        entry.run.cancel(`issue run stalled for more than ${String(policy.stallTimeoutMs)} ms`)
      }
    }
    const groups = this.groupRecords(['running'])
    for (const [providerName, records] of groups) {
      let issues: readonly TrackerIssue[]
      try {
        issues = await this.ctx.trackers.require(providerName)
          .fetchIssuesByIds(records.map(([id]) => id))
      } catch (error: unknown) {
        this.ctx.logger.warn(`running issue reconciliation failed for provider ${providerName}: ${String(error)}`)
        continue
      }
      const visible = new Map(issues.map(issue => [issue.id, issue]))
      for (const [id, record] of records) {
        const issue = visible.get(id)
        const live = this.live.get(id)
        /* v8 ignore next -- startup recovers every persisted running row before a tick; new running rows publish a live handle first. */
        if (live === undefined) continue
        if (issue === undefined) {
          live.disposition = 'release'
          live.run.cancel('issue is no longer visible')
        } else if (terminalIssue(issue, policy)) {
          live.issue = issue
          live.disposition = 'terminal'
          live.run.cancel('issue entered a terminal tracker state')
        } else if (!issueEligible(issue, policy)) {
          live.issue = issue
          live.disposition = 'release'
          live.run.cancel('issue is no longer eligible')
        } else {
          live.issue = issue
          await this.put(id, { ...record, issue, updatedAt: Date.now() })
        }
      }
    }
  }

  private async reconcileBlocked(policy: IssueWorkflowPolicy): Promise<void> {
    const groups = this.groupRecords(['blocked'])
    for (const [providerName, records] of groups) {
      let issues: readonly TrackerIssue[]
      try {
        issues = await this.ctx.trackers.require(providerName)
          .fetchIssuesByIds(records.map(([id]) => id))
      } catch (error: unknown) {
        this.ctx.logger.warn(`blocked issue reconciliation failed for provider ${providerName}: ${String(error)}`)
        continue
      }
      const visible = new Map(issues.map(issue => [issue.id, issue]))
      for (const [id, record] of records) {
        const issue = visible.get(id)
        if (issue === undefined || !issueEligible(issue, policy)) {
          if (issue !== undefined && terminalIssue(issue, policy)) await this.cleanupRecord(record, issue)
          await this.delete(id)
        } else {
          await this.put(id, { ...record, issue, updatedAt: Date.now() })
        }
      }
    }
  }

  private async dispatchDueRetries(policy: IssueWorkflowPolicy): Promise<void> {
    for (const [providerName, all] of this.groupRecords(['retrying'])) {
      const records = all.filter(([, record]) => (record.nextRetryAt ?? 0) <= Date.now())
      if (records.length === 0) continue
      const provider = this.ctx.trackers.require(providerName)
      let issues: readonly TrackerIssue[]
      try {
        issues = await provider.fetchIssuesByIds(records.map(([id]) => id))
      } catch (error: unknown) {
        for (const [, record] of records) {
          await this.scheduleFailure(record.provider, record.issue, record.attempt, record.workspacePath, error, policy)
        }
        continue
      }
      const visible = new Map(issues.map(issue => [issue.id, issue]))
      for (const [id, record] of records) {
        if (!this.hasCapacity(record.issue, policy)) {
          await this.put(id, {
            ...record,
            nextRetryAt: Date.now() + policy.pollIntervalMs,
            error: 'waiting for an orchestration capacity slot',
            updatedAt: Date.now(),
          })
          continue
        }
        const issue = visible.get(id)
        if (issue === undefined) {
          await this.delete(id)
        } else if (terminalIssue(issue, policy)) {
          await this.cleanupRecord(record, issue)
          await this.delete(id)
        } else if (!issueEligible(issue, policy)) {
          await this.delete(id)
        } else {
          await this.dispatch(provider, issue, record.attempt, policy)
        }
      }
    }
  }

  private async dispatchCandidates(policy: IssueWorkflowPolicy): Promise<void> {
    const provider = this.ctx.trackers.require(policy.trackerProvider)
    const candidates = [...await provider.fetchIssuesByStates(policy.activeStates)]
      .sort(compareIssues)
      .filter(issue => issueEligible(issue, policy) && this.requireTable().get(issue.id) === undefined)
    if (candidates.length === 0) return
    let fresh: readonly TrackerIssue[]
    try {
      fresh = await provider.fetchIssuesByIds(candidates.map(issue => issue.id))
    } catch (error: unknown) {
      for (const issue of candidates) {
        await this.scheduleFailure(provider.name, issue, 1, undefined, error, policy)
      }
      return
    }
    const visible = new Map(fresh.map(issue => [issue.id, issue]))
    for (const issue of candidates) {
      if (!this.hasCapacity(issue, policy)) continue
      const exact = visible.get(issue.id)
      if (exact === undefined || !issueEligible(exact, policy)) continue
      await this.dispatch(provider, exact, 1, policy)
    }
  }

  private async dispatch(
    provider: TrackerProvider,
    issue: TrackerIssue,
    attempt: number,
    policy: IssueWorkflowPolicy,
  ): Promise<void> {
    /* v8 ignore next -- the serialized caller rechecked capacity immediately before entering dispatch. */
    if (!this.hasCapacity(issue, policy)) return
    const now = Date.now()
    let record: IssueOrchestrationRecord = {
      provider: provider.name,
      workflowRevision: this.ctx.issueWorkflow.current().revision,
      issue,
      status: 'claimed',
      attempt,
      updatedAt: now,
    }
    await this.put(issue.id, record)
    let workspace: IssueWorkspace | undefined
    try {
      workspace = await this.ctx.issueWorkspace.prepare(issue)
      record = { ...record, workspacePath: workspace.path, updatedAt: Date.now() }
      await this.put(issue.id, record)
      await this.ctx.issueWorkspace.beforeRun(workspace, issue)
      const tools = this.ctx.trackers.bindTools(provider.name)
      const run = await this.ctx.issueRunner.start({
        issue,
        workspace,
        attempt,
        maxTurns: policy.maxTurns,
        prompt: renderTemplate(policy.promptTemplate, issue, attempt),
        continuationPrompt: (turn, maxTurns) => renderTemplate(
          `${policy.continuationTemplate}\n\nContinuation turn ${String(turn)} of ${String(maxTurns)}.`,
          issue,
          attempt,
        ),
        trackerTools: tools,
        refreshIssue: async (signal) => {
          const [refreshed] = await provider.fetchIssuesByIds([issue.id], signal)
          return refreshed
        },
        shouldContinue: refreshed => issueEligible(refreshed, policy),
        onEvent: (event) => { this.observeRun(issue.id, event) },
      })
      const live: LiveRun = { run, workspace, issue }
      this.live.set(issue.id, live)
      await this.put(issue.id, {
        ...record,
        status: 'running',
        sessionId: run.sessionId,
        startedAt: Date.now(),
        lastProgressAt: Date.now(),
        updatedAt: Date.now(),
      })
      void run.result.then(result => this.enqueue(() => this.settleRun(issue.id, live, result, policy)))
    } catch (error: unknown) {
      if (workspace !== undefined) await this.ctx.issueWorkspace.afterRun(workspace, issue)
      await this.scheduleFailure(provider.name, issue, attempt, workspace?.path, error, policy)
    }
  }

  private observeRun(issueId: TrackerIssueId, event: IssueRunEvent): void {
    void this.enqueue(async () => {
      const record = this.requireTable().get(issueId)
      if (record?.status !== 'running' || record.sessionId !== event.sessionId) return
      await this.put(issueId, { ...record, lastProgressAt: event.at, updatedAt: event.at })
    })
  }

  private async settleRun(
    issueId: TrackerIssueId,
    live: LiveRun,
    result: IssueRunResult,
    policy: IssueWorkflowPolicy,
  ): Promise<void> {
    /* v8 ignore next -- one Promise result invokes settlement once for the exact published live entry. */
    if (this.live.get(issueId) !== live) return
    this.live.delete(issueId)
    // A settled run released one capacity slot; coalesce a fresh reconciliation/dispatch tick.
    this.schedule(0)
    await this.ctx.issueWorkspace.afterRun(live.workspace, live.issue)
    const record = this.requireTable().get(issueId)
    /* v8 ignore next -- running records cannot be released by operators and this owner deletes only after settlement. */
    if (record === undefined) return
    if (live.disposition === 'terminal') {
      await this.cleanupRecord(record, live.issue)
      await this.delete(issueId)
      return
    }
    if (live.disposition === 'release') {
      await this.delete(issueId)
      return
    }
    if (live.disposition === 'retry') {
      await this.scheduleFailure(record.provider, live.issue, record.attempt, live.workspace.path, result.error ?? 'stalled run', policy)
      return
    }
    if (result.stopReason === 'blocked') {
      await this.put(issueId, {
        ...record,
        status: 'blocked',
        attempt: record.attempt + 1,
        error: result.error ?? 'agent requires operator input',
        updatedAt: Date.now(),
      })
      return
    }
    if (result.stopReason === 'failed' || result.stopReason === 'cancelled') {
      await this.scheduleFailure(
        record.provider, live.issue, record.attempt, live.workspace.path,
        result.error ?? result.stopReason, policy,
      )
      return
    }
    try {
      const provider = this.ctx.trackers.require(record.provider)
      const [refreshed] = await provider.fetchIssuesByIds([issueId])
      if (refreshed === undefined || !issueEligible(refreshed, policy)) {
        if (refreshed !== undefined && terminalIssue(refreshed, policy)) await this.cleanupRecord(record, refreshed)
        await this.delete(issueId)
      } else {
        await this.scheduleContinuation(record, refreshed, policy)
      }
    } catch (error: unknown) {
      await this.scheduleFailure(record.provider, live.issue, record.attempt, live.workspace.path, error, policy)
    }
  }

  /**
   * Requeue a completed run whose issue stayed eligible: the attempt increments (never resets),
   * the delay grows exponentially from `continuationRetryMs`, and the configured continuation
   * bound parks the issue in blocked state so a no-progress loop stays operator-visible.
   */
  private async scheduleContinuation(
    record: IssueOrchestrationRecord,
    refreshed: TrackerIssue,
    policy: IssueWorkflowPolicy,
  ): Promise<void> {
    if (policy.maxContinuationAttempts > 0 && record.attempt > policy.maxContinuationAttempts) {
      const error = `issue stayed eligible after ${String(record.attempt)} attempts; continuation bound of ${String(policy.maxContinuationAttempts)} reached`
      this.ctx.logger.warn(`issue orchestrator parked ${refreshed.identifier}: ${error}`)
      await this.put(record.issue.id, {
        ...record,
        issue: refreshed,
        status: 'blocked',
        error,
        updatedAt: Date.now(),
      })
      return
    }
    const attempt = record.attempt + 1
    const delay = Math.min(
      policy.continuationRetryMs * (2 ** Math.min(Math.max(0, record.attempt - 1), 20)),
      policy.maxRetryBackoffMs,
    )
    await this.put(record.issue.id, {
      ...record,
      issue: refreshed,
      status: 'retrying',
      attempt,
      nextRetryAt: Date.now() + delay,
      error: 'issue remains active after the completed run',
      updatedAt: Date.now(),
    })
    this.schedule(delay)
  }

  private async scheduleFailure(
    provider: string,
    issue: TrackerIssue,
    attempt: number,
    workspacePath: string | undefined,
    error: unknown,
    policy: IssueWorkflowPolicy,
  ): Promise<void> {
    const exponent = Math.min(Math.max(0, attempt - 1), 20)
    const delay = Math.min(policy.failureRetryBaseMs * (2 ** exponent), policy.maxRetryBackoffMs)
    await this.put(issue.id, {
      provider,
      workflowRevision: this.ctx.issueWorkflow.current().revision,
      issue,
      status: 'retrying',
      attempt: attempt + 1,
      ...(workspacePath === undefined ? {} : { workspacePath }),
      nextRetryAt: Date.now() + delay,
      error: error instanceof Error ? error.message : String(error),
      updatedAt: Date.now(),
    })
    this.schedule(delay)
  }

  private async cleanupRecord(record: IssueOrchestrationRecord, issue: TrackerIssue): Promise<void> {
    const workspace = workspaceFrom(record) ?? await this.ctx.issueWorkspace.locate(issue)
    await this.ctx.issueWorkspace.remove(workspace, issue)
  }

  private hasCapacity(issue: TrackerIssue, policy: IssueWorkflowPolicy): boolean {
    const active = [...this.requireTable().entries()]
      .filter(([, record]) => record.status === 'running' || record.status === 'claimed')
    if (active.length >= policy.maxConcurrentRuns) return false
    const state = normalized(issue.state)
    const limit = policy.maxConcurrentRunsByState[state] ?? policy.maxConcurrentRuns
    return active.filter(([, record]) => normalized(record.issue.state) === state).length < limit
  }

  /** Poll on cadence, or earlier when the nearest durable retry becomes due. */
  private nextDriveDelay(policy: IssueWorkflowPolicy): number {
    const now = Date.now()
    let delay = policy.pollIntervalMs
    for (const [, record] of this.requireTable().entries()) {
      if (record.status !== 'retrying' || record.nextRetryAt === undefined) continue
      delay = Math.min(delay, Math.max(0, record.nextRetryAt - now))
    }
    return delay
  }

  private groupRecords(statuses: readonly IssueOrchestrationRecord['status'][]): Map<string, Array<[TrackerIssueId, IssueOrchestrationRecord]>> {
    const result = new Map<string, Array<[TrackerIssueId, IssueOrchestrationRecord]>>()
    for (const entry of this.requireTable().entries()) {
      if (!statuses.includes(entry[1].status)) continue
      const group = result.get(entry[1].provider)
      if (group === undefined) result.set(entry[1].provider, [entry])
      else group.push(entry)
    }
    return result
  }

  private requireRecord(id: TrackerIssueId): IssueOrchestrationRecord {
    const record = this.requireTable().get(id)
    if (record === undefined) throw new IssueOrchestrationError(`issue ${id} is not tracked`, 'ISSUE_NOT_FOUND')
    return record
  }

  private requireTable(): IssueTable {
    if (this.table === undefined) throw new Error('issue orchestrator domain is not open')
    return this.table
  }

  private async put(id: TrackerIssueId, record: IssueOrchestrationRecord): Promise<void> {
    await this.requireTable().put(id, structuredClone(record))
    this.publish()
  }

  private async delete(id: TrackerIssueId): Promise<void> {
    /* v8 ignore next -- every caller proves record presence or just read the same record from the serialized table. */
    if (await this.requireTable().delete(id)) this.publish()
  }

  private publish(): void {
    this.revision += 1
    this.ctx.emit('issue-orchestration/changed', this.revision)
  }
}

export default DurableIssueOrchestrator
