/** Current-session Work summary derived only from existing client projections. */
import type { HostObservable } from '@relay-harness/rlh-client-ui-slots'
import type { ISessions, SessionId } from '@relay-harness/rlh-client-runtime/client'

/** Compact product projection rendered by the Work sidebar page. */
export interface WorkSummary {
  readonly sessionId: string | undefined
  readonly goal: { readonly objective: string; readonly phase: string } | null
  readonly plan: { readonly active: boolean; readonly pending: boolean } | null
  readonly jobs: { readonly total: number; readonly running: number }
  readonly trajectoryRecords: number
  readonly deliverables: readonly string[]
  readonly approvals: number
  readonly questions: number
  readonly completion: 'complete' | 'running' | 'idle'
  readonly cwd: string | undefined
}

const EMPTY: WorkSummary = {
  sessionId: undefined,
  goal: null,
  plan: null,
  jobs: { total: 0, running: 0 },
  trajectoryRecords: 0,
  deliverables: [],
  approvals: 0,
  questions: 0,
  completion: 'idle',
  cwd: undefined,
}

/** Keeps one current-session subscription and republishes a compact derived snapshot. */
export class CurrentWorkProjection implements HostObservable<WorkSummary> {
  private snapshot: WorkSummary = EMPTY
  private readonly listeners = new Set<() => void>()
  private sessionId: SessionId | undefined
  private offSession: (() => void) | undefined
  private readonly offList: () => void

  constructor(private readonly sessions: ISessions) {
    this.offList = sessions.list.subscribe(() => { this.rebind() })
    this.rebind()
  }

  getSnapshot(): WorkSummary { return this.snapshot }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  dispose(): void {
    this.offList()
    this.offSession?.()
    this.offSession = undefined
    this.listeners.clear()
  }

  private rebind(): void {
    const current = this.sessions.list.getSnapshot().current
    if (current !== this.sessionId) {
      this.offSession?.()
      this.offSession = undefined
      this.sessionId = current
      const session = current === undefined ? undefined : this.sessions.binding(current)?.session
      if (session !== undefined) this.offSession = session.subscribe(() => { this.publish() })
    }
    this.publish()
  }

  private publish(): void {
    this.snapshot = this.derive()
    for (const listener of [...this.listeners]) listener()
  }

  private derive(): WorkSummary {
    const list = this.sessions.list.getSnapshot()
    const sessionId = list.current
    if (sessionId === undefined) return EMPTY
    const summary = list.byId[sessionId]
    const projections = summary?.projectionValues as Record<string, unknown> | undefined
    const goalValue = projections?.goal as { goal?: { objective?: unknown; phase?: unknown } } | null | undefined
    const goal = goalValue?.goal !== undefined
      ? {
        objective: typeof goalValue.goal.objective === 'string' ? goalValue.goal.objective : '',
        phase: typeof goalValue.goal.phase === 'string' ? goalValue.goal.phase : 'active',
      }
      : null
    const planValue = projections?.plan as { active?: unknown; pending?: unknown } | undefined
    const plan = planValue === undefined ? null : {
      active: planValue.active === true,
      pending: planValue.pending === true,
    }
    const jobs = list.jobsBySession[sessionId] ?? []
    const conversation = this.sessions.binding(sessionId)?.session.getSnapshot()
    const trajectory = (conversation?.views as unknown as { get(key: string): unknown } | undefined)
      ?.get('trajectory') as { eventNodes?: readonly unknown[] } | undefined
    const deliverables = new Set<string>()
    for (const turn of conversation?.chat.timeline.turns.values() ?? []) {
      const data = (turn.data as unknown as { get(key: string): unknown }).get('deliverables') as
        { produced?: readonly { path?: unknown }[] } | undefined
      for (const produced of data?.produced ?? []) {
        if (typeof produced.path === 'string') deliverables.add(produced.path)
      }
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
      trajectoryRecords: trajectory?.eventNodes?.length ?? 0,
      deliverables: [...deliverables],
      approvals,
      questions,
      completion: goal?.phase === 'complete' ? 'complete' : conversation?.running === true || runningJobs > 0 ? 'running' : 'idle',
      cwd: summary?.cwd,
    }
  }
}
