/** Current-session Work summary derived only from existing client projections. */
import type { HostObservable } from '@relay-harness/rlh-client-ui-slots'
import type { WorkAcceptanceProjection } from '@relay-harness/rlh-host-work-results/types'
import type { ISessions } from '@relay-harness/rlh-client-runtime/client'

/** Compact product projection rendered by the Work sidebar page. */
export interface WorkSummary {
  readonly sessionId: string | undefined
  readonly goal: { readonly objective: string; readonly phase: string } | null
  readonly plan: { readonly active: boolean; readonly pending: boolean } | null
  readonly jobs: { readonly total: number; readonly running: number }
  readonly trajectoryRecords: number
  readonly deliverables: readonly string[]
  /** Null means the Host projection is unavailable; positive means older successes lacked capture. */
  readonly unindexedResults: number | null
  readonly acceptance: WorkAcceptanceProjection | null
  readonly approvals: number
  readonly questions: number
  readonly completion: 'complete' | 'running' | 'idle' | 'paused' | 'blocked'
  readonly cwd: string | undefined
}

const EMPTY: WorkSummary = {
  sessionId: undefined,
  goal: null,
  plan: null,
  jobs: { total: 0, running: 0 },
  trajectoryRecords: 0,
  deliverables: [],
  unindexedResults: null,
  acceptance: null,
  approvals: 0,
  questions: 0,
  completion: 'idle',
  cwd: undefined,
}

/** Keeps one current-session subscription and republishes a compact derived snapshot. */
export class CurrentWorkProjection implements HostObservable<WorkSummary> {
  private snapshot: WorkSummary = EMPTY
  private readonly listeners = new Set<() => void>()
  private session: NonNullable<ReturnType<ISessions['binding']>>['session'] | undefined
  private inputs: readonly unknown[] | undefined
  private offSession: (() => void) | undefined
  private readonly offList: () => void

  constructor(private readonly sessions: ISessions) {
    this.offList = sessions.list.subscribe(() => { this.rebind() })
    this.rebind()
  }

  getSnapshot(): WorkSummary { return this.snapshot }

  /** Subscribe to current Work projection changes.
   * @param listener - callback invoked after each new snapshot.
   * @returns disposer for this subscription.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Release current-session and list subscriptions. */
  dispose(): void {
    this.offList()
    this.offSession?.()
    this.offSession = undefined
    this.listeners.clear()
  }

  private rebind(): void {
    const current = this.sessions.list.getSnapshot().current
    const session = current === undefined ? undefined : this.sessions.binding(current)?.session
    if (session !== this.session) {
      this.offSession?.()
      this.session = session
      this.offSession = session?.subscribe(() => { this.publish() })
    }
    this.publish()
  }

  private publish(): void {
    const next = this.derive()
    if (sameWork(this.snapshot, next)) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }

  private derive(): WorkSummary {
    const list = this.sessions.list.getSnapshot()
    const sessionId = list.current
    if (sessionId === undefined) { this.inputs = undefined; return EMPTY }
    const summary = list.byId[sessionId]
    const projections = summary?.projectionValues as Record<string, unknown> | undefined
    const goalValue = projections?.goal as { goal?: { objective?: unknown; phase?: unknown } } | null | undefined
    const planValue = projections?.plan as { active?: unknown; pending?: unknown } | undefined
    const jobs = list.jobsBySession[sessionId] ?? EMPTY_JOBS
    const conversation = this.session?.getSnapshot()
    const trajectory = (conversation?.views as unknown as { get(key: string): unknown } | undefined)
      ?.get('trajectory') as { eventNodes?: readonly unknown[] } | undefined
    const inventory = summary?.projectionValues?.deliverables
    const executing = conversation?.running === true || jobs.some(job => job.status === 'running' || job.status === 'stopping')
    const acceptance = executing ? null : summary?.projectionValues?.workAcceptance ?? null
    const trajectoryRecords = trajectory?.eventNodes?.length ?? 0
    const inputs = [sessionId, summary?.cwd, goalValue, planValue, jobs, inventory, acceptance,
      conversation?.pending, conversation?.running, trajectoryRecords]
    if (this.inputs !== undefined && inputs.every((value, index) => Object.is(value, this.inputs?.[index]))) return this.snapshot
    this.inputs = inputs
    const goal = goalValue?.goal !== undefined
      ? {
        objective: typeof goalValue.goal.objective === 'string' ? goalValue.goal.objective : '',
        phase: typeof goalValue.goal.phase === 'string' ? goalValue.goal.phase : 'active',
      }
      : null
    const plan = planValue === undefined ? null : {
      active: planValue.active === true,
      pending: planValue.pending === true,
    }
    const approvals = conversation?.pending.filter(item => item.kind === 'approval').length ?? 0
    const questions = conversation?.pending.filter(item => item.kind === 'question').length ?? 0
    const runningJobs = jobs.filter(job => job.status === 'running' || job.status === 'stopping').length
    return {
      sessionId,
      goal,
      plan,
      jobs: {
        total: jobs.length,
        running: runningJobs,
      },
      trajectoryRecords,
      deliverables: inventory?.paths ?? EMPTY.deliverables,
      unindexedResults: inventory?.unindexedResults ?? null,
      acceptance,
      approvals,
      questions,
      completion: executing
        ? 'running'
        : goal?.phase === 'complete' || goal?.phase === 'paused' || goal?.phase === 'blocked' ? goal.phase : 'idle',
      cwd: summary?.cwd,
    }
  }
}

/** Stable empty list avoids invalidating on unrelated session notifications. */
const EMPTY_JOBS: readonly { status: string }[] = []

/** Publish only changed Work facts even when a carrier repeats equivalent whole values. */
function sameWork(left: WorkSummary, right: WorkSummary): boolean {
  return left === right || (left.sessionId === right.sessionId && left.cwd === right.cwd
    && left.goal?.objective === right.goal?.objective && left.goal?.phase === right.goal?.phase
    && left.plan?.active === right.plan?.active && left.plan?.pending === right.plan?.pending
    && left.jobs.total === right.jobs.total && left.jobs.running === right.jobs.running
    && left.trajectoryRecords === right.trajectoryRecords && left.approvals === right.approvals
    && left.questions === right.questions && left.completion === right.completion
    && left.unindexedResults === right.unindexedResults
    && left.acceptance?.reviewRevision === right.acceptance?.reviewRevision
    && left.acceptance?.acceptedRevision === right.acceptance?.acceptedRevision
    && left.acceptance?.reviewable === right.acceptance?.reviewable
    && (left.deliverables === right.deliverables || (left.deliverables.length === right.deliverables.length
      && left.deliverables.every((path, index) => path === right.deliverables[index]))))
}
