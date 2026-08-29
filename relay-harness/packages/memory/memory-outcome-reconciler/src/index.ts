/** Durable Session-to-Memory outcome reconciliation without Agent activation. */

import { createHash } from 'node:crypto'
import { Context, Service } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import type {} from '@relay-harness/rlh-context-engine/types'
import type {} from '@relay-harness/rlh-goal'
import { MemoryId, type LongTermMemory } from '@relay-harness/rlh-memory'
import type { MemoryId as MemoryIdType, MemoryOutcome, MemoryScope } from '@relay-harness/rlh-memory/types'
import type { MessageFeedbackItem } from '@relay-harness/rlh-message-feedback/types'
import type {} from '@relay-harness/rlh-message-feedback'
import type { MessageId } from '@relay-harness/rlh-llm/brand'
import type { SessionEvent, SessionId } from '@relay-harness/rlh-session/types'
import type { Session } from '@relay-harness/rlh-session'
import type {} from '@relay-harness/rlh-session-query'

/** Cordis plugin name. */
export const name = 'memory-outcome-reconciler'
/** Required canonical Memory, non-activating Session Query, and feedback services. */
export const inject = ['longTermMemory', 'sessionQuery', 'messageFeedback']

const DEFAULT_USER_ID = 'local'
const DEFAULT_AGENT_ID = 'relay-harness'
const DEFAULT_CONCURRENCY = 4

/** Reconciler scope and bounded persisted-read policy. */
export interface Config {
  /** Stable user partition shared with Memory recall. Defaults to `local`. */
  readonly userId?: string
  /** Stable Agent partition shared with Memory recall. Defaults to `relay-harness`. */
  readonly agentId?: string
  /** Concurrent persisted Session reads during a complete reconciliation. Defaults to 4. */
  readonly concurrency?: number
}

/** Validate and default outcome reconciliation policy. */
export const Config: z<Config> = z.object({
  userId: z.string().default(DEFAULT_USER_ID),
  agentId: z.string().default(DEFAULT_AGENT_ID),
  concurrency: z.number().step(1).min(1).default(DEFAULT_CONCURRENCY),
})

declare module '@relay-harness/cordis' {
  interface Context {
    memoryOutcomeReconciler: MemoryOutcomeReconciler
  }
}

interface RecallTurn {
  readonly turn: number
  readonly contextSeq: number
  readonly memoryIds: readonly MemoryIdType[]
  readonly assistant?: { readonly id: MessageId; readonly seq: number; readonly time: number }
  readonly end?: SessionEvent<'turn/end'>
}

/** Host service maintaining idempotent Memory outcome observations from durable Session facts. */
export class MemoryOutcomeReconciler extends Service {
  static Config = Config
  private readonly userId: string
  private readonly agentId: string
  private readonly concurrency: number
  private initial: Promise<void> | undefined
  private fullInFlight: Promise<void> | undefined
  private readonly tails = new Map<SessionId, Promise<void>>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'memoryOutcomeReconciler')
    this.userId = requireText('userId', config.userId ?? DEFAULT_USER_ID)
    this.agentId = requireText('agentId', config.agentId ?? DEFAULT_AGENT_ID)
    this.concurrency = config.concurrency ?? DEFAULT_CONCURRENCY
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1) {
      throw new Error('memory outcome reconciliation concurrency must be a positive safe integer')
    }

    ctx.on('session/event', (session, event) => {
      if (!outcomeRelevant(event)) return
      void this.scheduleAfterDurability(session)
    })
    ctx.on('message-feedback/changed', (change) => { this.schedule(change.sessionId) })
    ctx.effect(() => async () => { await Promise.allSettled(this.tails.values()) }, 'memoryOutcomes.drain')
  }

  /** Start the non-blocking persisted-corpus reconciliation after all injected services are ready. */
  protected [Service.init](): void {
    void this.ensureReconciled().catch(() => {
      // ensureReconciled already logs the authoritative startup failure; live event retries continue.
    })
  }

  /**
   * Reconcile the complete live-preferred persisted corpus once per process unless explicitly refreshed.
   * @param refresh - force a new full observation after the initial pass.
   * @returns after every readable Session has settled independently.
   */
  ensureReconciled(refresh: boolean = false): Promise<void> {
    if (this.fullInFlight !== undefined) return this.fullInFlight
    if (refresh || this.initial === undefined) {
      const tracked = this.reconcileAll().catch((error: unknown) => {
        if (this.initial === tracked) this.initial = undefined
        this.ctx.logger.warn(`memory-outcome-reconciler: full reconciliation failed: ${errorMessage(error)}`)
        throw error
      }).finally(() => {
        if (this.fullInFlight === tracked) this.fullInFlight = undefined
      })
      this.initial = tracked
      this.fullInFlight = tracked
    }
    return this.initial
  }

  /**
   * Reconcile all logical Sessions through Session Query without resuming an Agent.
   * @returns after the bounded worker pool settles all Sessions.
   */
  async reconcileAll(): Promise<void> {
    const sessionQuery = this.requireService('sessionQuery')
    const sessions = (await sessionQuery.listSessions()).filter(record => record.persisted)
    let next = 0
    const failures: unknown[] = []
    const workers = Array.from({ length: Math.min(this.concurrency, sessions.length) }, async () => {
      while (next < sessions.length) {
        const index = next
        next += 1
        const record = sessions[index]
        if (record === undefined) continue
        await this.reconcileSession(record.header.id).catch((error: unknown) => {
          this.ctx.logger.warn(`memory-outcome-reconciler: ${record.header.id}: ${errorMessage(error)}`)
          failures.push(error)
        })
      }
    })
    await Promise.all(workers)
    if (failures.length > 0) {
      throw new AggregateError(failures, `memory outcome reconciliation failed for ${failures.length} Session(s)`)
    }
  }

  /**
   * Reconcile one logical Session through the live-preferred non-activating Session Query read.
   * @param sessionId - logical Session identity.
   * @returns after its complete derived outcome set replaces the previous set.
   */
  reconcileSession(sessionId: SessionId): Promise<void> {
    const prior = this.tails.get(sessionId) ?? Promise.resolve()
    const current = prior.catch(() => {}).then(async () => {
      const sessionQuery = this.requireService('sessionQuery')
      const memory = this.requireService('longTermMemory')
      const snapshot = await sessionQuery.readSession(sessionId)
      const scope = this.scope(snapshot.session.cwd)
      const feedback = await this.feedback(sessionId)
      const outcomes = await deriveOutcomes(
        memory,
        scope,
        sessionId,
        snapshot.events,
        feedback,
      )
      await memory.reconcileOutcomes({ scope, sessionId, outcomes })
    }).finally(() => {
      if (this.tails.get(sessionId) === current) this.tails.delete(sessionId)
    })
    this.tails.set(sessionId, current)
    return current
  }

  private schedule(sessionId: SessionId): void {
    void this.reconcileSession(sessionId).catch((error: unknown) => {
      this.ctx.logger.warn(`memory-outcome-reconciler: ${sessionId}: ${errorMessage(error)}`)
    })
  }

  private async scheduleAfterDurability(session: Session): Promise<void> {
    const sessions = this.ctx.get('sessions')
    if (sessions !== undefined) {
      try {
        if (!(await sessions.flush(session))) {
          this.ctx.logger.debug(`memory-outcome-reconciler: no durability listener for ${session.id}`)
          return
        }
      } catch (error: unknown) {
        this.ctx.logger.warn(`memory-outcome-reconciler: durability failed for ${session.id}: ${errorMessage(error)}`)
        return
      }
    }
    this.schedule(session.id)
  }

  private scope(cwd: string | undefined): MemoryScope {
    return { workspaceId: cwd ?? 'global', userId: this.userId, agentId: this.agentId }
  }

  private async feedback(sessionId: SessionId): Promise<readonly MessageFeedbackItem[]> {
    const result = await this.requireService('messageFeedback').list({ sessionId })
    if (!result.ok) {
      throw new Error(`message feedback unavailable for ${sessionId}: ${result.error.code}`)
    }
    return result.value.items
  }

  private requireService<K extends 'longTermMemory' | 'sessionQuery' | 'messageFeedback'>(key: K): Context[K] {
    const service = this.ctx.get(key)
    if (service === undefined) throw new Error(`memory outcome reconciler requires ${key}`)
    return service
  }
}

export default MemoryOutcomeReconciler

async function deriveOutcomes(
  memory: LongTermMemory,
  scope: MemoryScope,
  sessionId: SessionId,
  events: readonly SessionEvent[],
  feedback: readonly MessageFeedbackItem[],
): Promise<MemoryOutcome[]> {
  const turns = recalledTurns(events)
  const known = new Map<MemoryIdType, boolean>()
  const exists = async (id: MemoryIdType): Promise<boolean> => {
    let present = known.get(id)
    if (present === undefined) {
      present = await memory.read(scope, id) !== undefined
      known.set(id, present)
    }
    return present
  }
  const outcomes: MemoryOutcome[] = []
  for (const turn of turns) {
    for (const memoryId of turn.memoryIds) {
      if (!(await exists(memoryId))) continue
      if (turn.end !== undefined) {
        const completed = turn.end.data.reason.kind === 'completed' || turn.end.data.reason.kind === 'max-tokens'
        outcomes.push(outcome({
          scope, sessionId, memoryId, turn: turn.turn,
          kind: completed ? 'turn-completed' : 'turn-failed',
          impact: 'neutral',
          sourceEventSeqs: [turn.contextSeq, turn.end.seq],
          observedAt: turn.end.time,
          ...turn.assistant === undefined ? {} : { assistantMessageId: turn.assistant.id },
        }))
      }
      const item = turn.assistant === undefined
        ? undefined
        : feedback.find(candidate => candidate.messageId === turn.assistant?.id)
      if (item !== undefined && turn.assistant !== undefined) {
        outcomes.push(outcome({
          scope, sessionId, memoryId, turn: turn.turn,
          kind: item.rating === 'positive' ? 'assistant-positive' : 'assistant-negative',
          impact: item.rating,
          sourceEventSeqs: [turn.contextSeq, turn.assistant.seq],
          sourceRef: `message-feedback:${item.version}`,
          assistantMessageId: turn.assistant.id,
          observedAt: item.updatedAt,
        }))
      }
    }
  }

  for (const event of events) {
    if (event.type !== 'goal/change') continue
    const work = event.data.operation === 'complete'
      ? { kind: 'work-completed' as const, impact: 'positive' as const }
      : event.data.operation === 'block'
        ? { kind: 'work-blocked' as const, impact: 'neutral' as const }
        : undefined
    if (work === undefined) continue
    const goalId = event.data.operation === 'clear' ? event.data.cleared.id : event.data.goal.id
    const create = [...events].reverse().find(candidate => candidate.type === 'goal/change'
      && candidate.seq < event.seq
      && candidate.data.operation === 'create'
      && candidate.data.goal.id === goalId)
    if (create === undefined) continue
    const prior = [...turns].reverse().find(turn => turn.contextSeq < event.seq
      && turn.contextSeq > create.seq)
    if (prior === undefined) continue
    for (const memoryId of prior.memoryIds) {
      if (!(await exists(memoryId))) continue
      outcomes.push(outcome({
        scope, sessionId, memoryId, turn: prior.turn,
        kind: work.kind,
        impact: work.impact,
        sourceEventSeqs: [prior.contextSeq, event.seq],
        observedAt: event.time,
        ...prior.assistant === undefined ? {} : { assistantMessageId: prior.assistant.id },
      }))
    }
  }
  return outcomes.sort((left, right) => left.observedAt - right.observedAt || left.id.localeCompare(right.id))
}

function recalledTurns(events: readonly SessionEvent[]): RecallTurn[] {
  const turns: RecallTurn[] = []
  for (const event of events) {
    if (event.type !== 'context/prepared') continue
    const ids = new Set<MemoryIdType>()
    for (const contribution of event.data.contributions) {
      if (contribution.messageEventSeqs.length === 0) continue
      for (const evidence of contribution.evidence) {
        const id = memoryIdOfEvidence(evidence)
        if (id !== undefined) ids.add(id)
      }
    }
    if (ids.size === 0) continue
    const assistant = events.find(candidate => candidate.type === 'assistant/message'
      && candidate.data.turn === event.data.turn)
    const end = events.find(candidate => candidate.type === 'turn/end'
      && candidate.data.turn === event.data.turn)
    turns.push({
      turn: event.data.turn,
      contextSeq: event.seq,
      memoryIds: [...ids],
      ...assistant?.type !== 'assistant/message' ? {} : {
        assistant: { id: assistant.data.message.id, seq: assistant.seq, time: assistant.time },
      },
      ...end?.type !== 'turn/end' ? {} : { end },
    })
  }
  return turns
}

function memoryIdOfEvidence(
  evidence: SessionEvent<'context/prepared'>['data']['contributions'][number]['evidence'][number],
): MemoryIdType | undefined {
  if (evidence.resource.sourceId === 'long-term-memory') return MemoryId(evidence.resource.key)
  const match = /^memory:([^:]+):\d+$/u.exec(evidence.evidenceId)
  return match === null ? undefined : MemoryId(match[1] as string)
}

function outcome(input: Omit<MemoryOutcome, 'id'>): MemoryOutcome {
  return {
    ...input,
    id: createHash('sha256').update(JSON.stringify([
      1,
      input.scope.workspaceId,
      input.scope.userId,
      input.scope.agentId,
      input.sessionId,
      input.memoryId,
      input.turn,
      input.kind,
      input.assistantMessageId ?? null,
      input.sourceEventSeqs,
      input.sourceRef ?? null,
    ])).digest('hex'),
  }
}

function outcomeRelevant(event: SessionEvent): boolean {
  return event.type === 'turn/end'
    || (event.type === 'goal/change'
      && (event.data.operation === 'complete' || event.data.operation === 'block'))
}

function requireText(label: string, value: string): string {
  const normalized = value.trim()
  if (normalized === '') throw new Error(`memory outcome ${label} must not be blank`)
  return normalized
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
