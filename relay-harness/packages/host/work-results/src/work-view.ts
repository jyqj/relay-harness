/** Passive application reads over existing session, goal, execution and context owners. */
import { createHash } from 'node:crypto'
import type { Context } from '@relay-harness/cordis'
import type { SessionEvent, SessionId } from '@relay-harness/rlh-session'
import type { ContentBlock } from '@relay-harness/rlh-llm'
import { foldGoal } from '@relay-harness/rlh-goal'
import type {} from '@relay-harness/rlh-subagent'
import type {} from '@relay-harness/rlh-context-engine'
import { deliverablesProjection, workAcceptanceProjection } from './projection.ts'
import { confirmationBlockers } from './confirmation-policy.ts'
import { executionRecovery, executionRelationship } from './execution-facts.ts'
import type { WorkView, WorkExecutionEntry, WorkHistoryPage, WorkHistoryRequest } from './types.ts'

/** Read one Work without creating an Agent, arming a Goal, or claiming a child lease.
 * @param ctx - Host services, already authorized by the caller's transport.
 * @param id - Exact durable session address.
 * @param maxExecutions - Maximum independently observed execution entries returned.
 * @param signal - Read cancellation.
 * @returns Orthogonal facts and advisory actions with an explicit source cut.
 */
export async function readWorkView(ctx: Context, id: SessionId, maxExecutions: number, signal: AbortSignal): Promise<WorkView> {
  signal.throwIfAborted()
  const snapshot = await ctx.sessionQuery.readSession(id)
  signal.throwIfAborted()
  const events = snapshot.events
  const throughSeq = events.at(-1)?.seq ?? -1
  const owner = ctx.agents.get(id)
  const resident = owner !== undefined
  const review = events.reduce((value, event) => workAcceptanceProjection.apply(value, event), workAcceptanceProjection.init())
  const outputs = events.reduce((value, event) => deliverablesProjection.apply(value, event), deliverablesProjection.init())
  const foldedGoal = foldGoal(events)
  const goal = foldedGoal.goal === undefined ? null : {
    id: foldedGoal.goal.id, revision: foldedGoal.goal.revision, objective: foldedGoal.goal.objective,
    phase: foldedGoal.goal.phase, roundsStarted: foldedGoal.roundsStarted,
  }
  const missing: string[] = []
  const entries: WorkExecutionEntry[] = [{
    id, sessionId: id, kind: 'agent', label: id, activity: owner?.status ?? 'inactive',
    recovery: owner !== undefined ? 'resident' : snapshot.session.origin === 'subagent' ? 'unknown' : 'explicit-resume',
    relationship: executionRelationship({
      workSessionId: id, sessionId: id,
      ...snapshot.session.parentSession === undefined ? {} : { parentSessionId: snapshot.session.parentSession },
      ...snapshot.session.origin === undefined ? {} : { origin: snapshot.session.origin },
    }, owner !== undefined),
    recoveryCapabilities: executionRecovery({
      evidence: 'session', resident: owner !== undefined,
      ...snapshot.session.origin === undefined ? {} : { origin: snapshot.session.origin },
    }),
  }]
  const jobs = owner === undefined ? [] : ctx.jobs.list(owner).filter(job => job.ownerSession === id)
  for (const job of jobs) entries.push({
    id: job.id, sessionId: id, kind: 'job', label: job.label,
    activity: job.status === 'running' || job.status === 'stopping' ? job.status : 'inactive',
    ...(job.status === 'completed' || job.status === 'killed' || job.status === 'failed' ? { outcome: job.status } : {}),
    recovery: job.status === 'running' || job.status === 'stopping' ? 'resident' : 'history-only',
    relationship: executionRelationship({ workSessionId: id, sessionId: id },
      job.status === 'running' || job.status === 'stopping'),
    recoveryCapabilities: executionRecovery({
      evidence: 'job', resident: job.status === 'running' || job.status === 'stopping',
    }),
  })
  const subagents = ctx.get('subagents')
  if (subagents === undefined) missing.push('subagent-catalog-unavailable')
  else {
    try {
      for (const child of await subagents.listDescendants(id, signal)) {
        const live = ctx.agents.get(child.id)
        if (child.kind === 'diagnostic') missing.push(`subagent-${child.reason}:${child.id}`)
        entries.push({
          id: child.id, sessionId: child.id, parentSessionId: child.parentId, kind: 'subagent',
          label: child.kind === 'child' ? child.label ?? child.id : child.id,
          activity: live?.status ?? (child.kind === 'child' && child.activity === 'inactive' ? 'inactive' : 'unknown'),
          recovery: live !== undefined ? 'resident'
            : child.kind === 'child' && child.mode === 'continuable' ? 'explicit-resume'
              : child.kind === 'child' ? 'history-only' : 'unknown',
          relationship: executionRelationship({
            workSessionId: id, sessionId: child.id, parentSessionId: child.parentId,
            ...child.kind === 'child' ? { mode: child.mode } : {},
          }, live !== undefined),
          recoveryCapabilities: executionRecovery({
            evidence: 'subagent', resident: live !== undefined,
            ...child.kind === 'child' ? { mode: child.mode } : {},
          }),
        })
      }
    } catch (error) {
      if (signal.aborted) throw error
      missing.push('subagent-catalog-read-failed')
    }
  }
  signal.throwIfAborted()
  // Each domain retains its own clock. This flag only compares the addressed Session cut.
  const current = owner !== undefined && ctx.agents.get(id) === owner && owner.session.seq - 1 === throughSeq
  if (!resident) missing.push('runtime-not-resident', 'process-local-job-history-unavailable')
  else if (!current) missing.push('session-cut-superseded')
  const pending = owner === undefined ? { approvals: 0, questions: 0 } : ctx.hostInteractions.pendingFor(id)
  const blockers: string[] = owner === undefined ? ['runtime-unavailable'] : confirmationBlockers({
    root: ctx.agents.roots().includes(owner), reviewable: review.reviewable, idle: owner.status === 'idle',
    queuedInput: owner.inbox.hasPending, approvals: pending.approvals, questions: pending.questions,
    runningJobs: jobs.some(job => job.status === 'running' || job.status === 'stopping'),
  })
  if (!current) blockers.push('source-changed')
  const context = owner?.ctx.get('contextEngine')
  const omitted = Math.max(0, entries.length - maxExecutions)
  if (omitted > 0) missing.push('execution-display-limit')
  return {
    sessionId: id,
    ...(snapshot.session.cwd === undefined ? {} : { cwd: snapshot.session.cwd }),
    ...(snapshot.session.parentSession === undefined ? {} : { parentSessionId: snapshot.session.parentSession }),
    relation: snapshot.session.origin === 'subagent' ? 'delegated' : snapshot.session.parentSession === undefined ? 'root' : 'fork',
    source: { throughSeq, resident, current }, goal,
    execution: { activity: !current || entries.some(entry => entry.activity === 'unknown') ? 'unknown' : entries.some(entry => entry.activity === 'running' || entry.activity === 'stopping') ? 'running' : 'idle', entries: entries.slice(0, maxExecutions), omitted },
    attention: { ...pending, available: current }, outputs, review,
    actions: { confirmRecord: { allowed: blockers.length === 0, blockers, scope: 'session-log' } },
    capabilities: { contextAvailable: context !== undefined, activationRequired: !resident,
      contextSources: context?.describeContributors().filter(source => source.purposes.includes('tool_retrieval')) ?? [] },
    coverage: { missing, scope: 'observed-session-and-descendants' },
  }
}

/** Project a bounded page of existing final message text, retaining exact event positions.
 * @param id - Source identity.
 * @param events - One detached contiguous source observation.
 * @param request - Upper-exclusive event boundary and row limit.
 * @param maxRows - Deployment maximum result rows.
 * @param maxChars - Total rendered text code-point allowance.
 * @returns A read-only page; tool, reasoning and binary content are not promoted to instructions.
 */
export function readWorkHistory(id: SessionId, events: readonly SessionEvent[], request: WorkHistoryRequest, maxRows: number, maxChars: number): WorkHistoryPage {
  const observedThroughSeq = events.at(-1)?.seq ?? -1
  const throughSeq = request.snapshot?.throughSeq ?? observedThroughSeq
  if (!Number.isSafeInteger(throughSeq) || throughSeq < -1 || throughSeq > observedThroughSeq) throw new Error('history observation changed; restart the read')
  const hash = createHash('sha256').update(JSON.stringify([id, throughSeq]))
  for (const event of events) {
    if (event.seq > throughSeq) break
    hash.update(JSON.stringify(event))
  }
  const snapshot = { throughSeq, digest: hash.digest('hex') }
  if (request.snapshot !== undefined && request.snapshot.digest !== snapshot.digest) throw new Error('history observation changed; restart the read')
  const before = request.beforeSeq ?? throughSeq + 1
  const limit = request.limit ?? Math.min(50, maxRows)
  if ((before !== Infinity && (!Number.isSafeInteger(before) || before < 0)) || !Number.isSafeInteger(limit) || limit < 1 || limit > maxRows) throw new Error('invalid history page bounds')
  const rows: WorkHistoryPage['rows'][number][] = []
  let chars = maxChars
  let nextBeforeSeq: number | null = null
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || event.seq > throughSeq || event.seq >= before) continue
    if (event.type !== 'user/message' && event.type !== 'assistant/message' && event.type !== 'tool/result') continue
    if (event.surfaceOp !== 'append') continue
    const message = event.type === 'user/message' ? event.data : event.data.message
    const text = textOnly(message.content)
    if (text === '') continue
    if (rows.length === limit || chars === 0) { nextBeforeSeq = rows.at(-1)?.seq ?? before; break }
    const points = Array.from(text)
    rows.push({ seq: event.seq, kind: event.type === 'assistant/message' ? 'assistant' : event.type === 'tool/result' ? 'tool' : 'user',
      text: points.slice(0, chars).join(''), truncated: points.length > chars })
    chars -= Math.min(chars, points.length)
  }
  return { sessionId: id, throughSeq, snapshot, rows: rows.reverse(), nextBeforeSeq, scope: 'text-messages-only' }
}

function textOnly(blocks: readonly ContentBlock[]): string {
  const texts: string[] = []
  const pending = [...blocks]
  while (pending.length > 0) {
    const block = pending.shift()
    if (block?.type === 'text') texts.push(block.text)
    else if (block?.type === 'tool-result') pending.unshift(...block.content)
  }
  return texts.join('\n')
}
