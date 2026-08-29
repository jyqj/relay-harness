/** Host Remote for governed long-term-memory inspection and mutation. */

import type { Context } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import type {} from '@relay-harness/rlh-context-engine/types'
import { MemoryId } from '@relay-harness/rlh-memory'
import type {} from '@relay-harness/rlh-memory-outcome-reconciler'
import type {
  MemoryConflictCandidate,
  MemoryEntry,
  MemoryEvidence,
  MemoryKind,
  MemoryScope,
  MemoryStatus,
} from '@relay-harness/rlh-memory/types'
import type { Session, SessionEvent } from '@relay-harness/rlh-session'
import { SessionId as brandSessionId } from '@relay-harness/rlh-session'
import type {} from '@relay-harness/rlh-session-query'
import { Remote, TypertLookupFailure, TypertRemoteService } from '@relay-harness/rlh-typert-protocol'
import type {} from 'zod'
import type {
  MemoryCenterDeleteRequest,
  MemoryCenterDetail,
  MemoryCenterEntry,
  MemoryCenterListRequest,
  MemoryCenterMutationRequest,
  MemoryCenterReadRequest,
  MemoryCenterRejectRequest,
  MemoryCenterReviseRequest,
  MemoryCenterSearchRequest,
  MemoryCenterScope,
  MemoryCenterSnapshot,
  MemoryConflictComparison,
  MemoryGovernanceAction,
  MemoryGovernanceRequestedEventData,
  MemoryUsageOccurrence,
  MemoryUsageCoverage,
} from './types.ts'

export type * from './types.ts'

const DEFAULT_USER_ID = 'local'
const DEFAULT_AGENT_ID = 'relay-harness'
const DEFAULT_PAGE_SIZE = 50
const MAX_QUERY_CHARS = 500
const MAX_GOVERNANCE_EXCERPT_CHARS = 4_096
const DEFAULT_USAGE_CONCURRENCY = 4

declare module '@relay-harness/rlh-session/types' {
  interface SessionEventMap {
    /** User governance intent captured before a successful append-only memory revision. */
    'memory/governance-requested': MemoryGovernanceRequestedEventData
  }
}

/** Memory Center scope defaults. */
export interface Config {
  /** Stable user partition shared with the Memory Context contributor. Defaults to `local`. */
  readonly userId?: string
  /** Stable Agent partition shared with the Memory Context contributor. Defaults to `relay-harness`. */
  readonly agentId?: string
  /** Concurrent non-activating Session Query reads for why-used aggregation. Defaults to 4. */
  readonly usageConcurrency?: number
}

export const Config: z<Config> = z.object({
  userId: z.string().default(DEFAULT_USER_ID),
  agentId: z.string().default(DEFAULT_AGENT_ID),
  usageConcurrency: z.number().step(1).min(1).default(DEFAULT_USAGE_CONCURRENCY),
})

/** Remote-only management surface over the canonical longTermMemory service. */
export class MemoryCenterGateway extends TypertRemoteService {
  static inject = ['longTermMemory', 'sessions']
  private readonly userId: string
  private readonly agentId: string
  private readonly usageConcurrency: number

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'memoryCenter')
    this.userId = requireText('userId', config.userId ?? DEFAULT_USER_ID)
    this.agentId = requireText('agentId', config.agentId ?? DEFAULT_AGENT_ID)
    this.usageConcurrency = config.usageConcurrency ?? DEFAULT_USAGE_CONCURRENCY
    if (!Number.isSafeInteger(this.usageConcurrency) || this.usageConcurrency < 1) {
      throw new Error('memoryCenter usageConcurrency must be a positive safe integer')
    }
  }

  /**
   * List or substring-search current materialized entries without recall accounting.
   * @param request - exact workspace, filters, optional attached session, and page window.
   * @returns the filtered page and bounded why-used coverage.
   */
  @Remote('list')
  async list(request: MemoryCenterListRequest): Promise<MemoryCenterSnapshot> {
    const { scope } = this.readContext(request)
    const { limit, offset } = pageWindow(request.limit, request.offset)
    const query = request.query?.trim().toLocaleLowerCase() ?? ''
    if (Array.from(query).length > MAX_QUERY_CHARS) throw new Error(`memoryCenter query must not exceed ${MAX_QUERY_CHARS} characters`)
    if (query === '') {
      const page = await this.ctx.longTermMemory.list({
        scope,
        limit,
        offset,
        ...request.statuses === undefined ? {} : { statuses: request.statuses },
        ...request.kinds === undefined ? {} : { kinds: request.kinds },
        includeExpired: request.includeExpired ?? true,
      })
      const usage = await this.usageView(scope, page.entries)
      return {
        scope,
        entries: page.entries.map(entry => centerEntry(entry, usage.byId)),
        total: page.total,
        offset: page.offset,
        hasMore: page.hasMore,
        usageCoverage: usage.coverage,
      }
    }

    const all = await this.collect(scope, request.statuses, request.kinds, request.includeExpired ?? true)
    const matched = all.filter(entry => [entry.content, entry.summary ?? '', entry.kind, entry.status, entry.trust]
      .some(value => value.toLocaleLowerCase().includes(query)))
    const entries = matched.slice(offset, offset + limit)
    const usage = await this.usageView(scope, entries)
    return {
      scope,
      entries: entries.map(entry => centerEntry(entry, usage.byId)),
      total: matched.length,
      offset,
      hasMore: offset + entries.length < matched.length,
      usageCoverage: usage.coverage,
    }
  }

  /**
   * Search every selected governance state, including expired/tombstoned rows recall excludes.
   * @param request - exact workspace, required query, filters, and page window.
   * @returns the matching governance page.
   */
  @Remote('search')
  search(request: MemoryCenterSearchRequest): Promise<MemoryCenterSnapshot> {
    return this.list(request)
  }

  /**
   * Read exact evidence, usage, and canonical supersession links.
   * @param request - exact workspace, id, and optional attached session.
   * @returns the current entry, linked comparisons, and why-used coverage.
   */
  @Remote('read')
  async read(request: MemoryCenterReadRequest): Promise<MemoryCenterDetail> {
    const { scope } = this.readContext(request)
    const entry = await this.requireEntry(scope, request.id)
    const linked: MemoryConflictComparison[] = []
    if (entry.supersedes !== undefined) {
      const previous = await this.ctx.longTermMemory.read(scope, entry.supersedes)
      if (previous !== undefined) linked.push({
        relation: 'supersedes',
        entry: centerEntry(previous, new Map()),
        score: 1,
        reasons: ['canonical supersedes link'],
        detectorId: 'long-term-memory',
      })
    }
    if (entry.supersededBy !== undefined) {
      const next = await this.ctx.longTermMemory.read(scope, entry.supersededBy)
      if (next !== undefined) linked.push({
        relation: 'superseded-by',
        entry: centerEntry(next, new Map()),
        score: 1,
        reasons: ['canonical supersededBy link'],
        detectorId: 'long-term-memory',
      })
    }
    const deterministic = await this.ctx.longTermMemory.findConflicts({ scope, id: entry.id, limit: 50 })
    const richer = await this.semanticConflicts(scope, entry, deterministic)
    const conflicts = mergeConflicts(linked, [...deterministic, ...richer])
    const observed = [entry, ...conflicts.map(item => item.entry.entry)]
    const usage = await this.usageView(scope, observed)
    let outcomeCoverage: MemoryCenterDetail['outcomeCoverage'] = 'complete'
    const reconciler = this.ctx.get('memoryOutcomeReconciler')
    if (reconciler !== undefined) {
      try {
        await reconciler.ensureReconciled(true)
      } catch {
        outcomeCoverage = 'unavailable'
      }
    } else {
      outcomeCoverage = 'unavailable'
    }
    const [signals, outcomes] = await Promise.all([
      this.ctx.longTermMemory.listSignals(scope, entry.id),
      this.ctx.longTermMemory.listOutcomes({ scope, id: entry.id, limit: 50 }),
    ])
    return {
      memory: centerEntry(entry, usage.byId),
      conflicts: conflicts.map(item => ({ ...item, entry: centerEntry(item.entry.entry, usage.byId) })),
      signals,
      outcomes,
      outcomeSummary: summarizeOutcomes(outcomes),
      outcomeCoverage,
      usageCoverage: usage.coverage,
    }
  }

  /**
   * Promote a candidate/disputed memory after an explicit user confirmation.
   * @param request - attached session and memory id.
   * @returns the approved current detail.
   */
  @Remote('approve')
  async approve(request: MemoryCenterMutationRequest): Promise<MemoryCenterDetail> {
    const { session, scope, entry } = await this.mutationContext(request)
    if (entry.status !== 'candidate' && entry.status !== 'disputed') {
      throw new Error(`memoryCenter can approve only candidate or disputed memories, got ${entry.status}`)
    }
    const evidence = await governanceEvidence(this.ctx, session, scope, entry, 'approve', entry.content)
    await this.assertUnchanged(scope, entry)
    await this.ctx.longTermMemory.revise({
      scope,
      id: entry.id,
      expectedRevision: entry.revision,
      status: 'active',
      trust: 'user-stated',
      confidence: Math.max(entry.confidence, 0.9),
      ...entry.validUntil !== undefined && entry.validUntil <= Date.now() ? { validUntil: null } : {},
      evidence: [evidence],
      governance: { kind: 'user_confirmed', sessionId: session.id, eventSeqs: evidence.eventSeqs },
    })
    return this.read({ workspaceId: scope.workspaceId, sessionId: session.id, id: entry.id })
  }

  /**
   * Reject a candidate/disputed memory by appending a user-evidenced tombstone.
   * @param request - attached session, memory id, and reason.
   * @returns the tombstoned current detail.
   */
  @Remote('reject')
  async reject(request: MemoryCenterRejectRequest): Promise<MemoryCenterDetail> {
    const { session, scope, entry } = await this.mutationContext(request)
    if (entry.status !== 'candidate' && entry.status !== 'disputed') {
      throw new Error(`memoryCenter can reject only candidate or disputed memories, got ${entry.status}`)
    }
    const reason = requireText('reason', request.reason)
    const evidence = await governanceEvidence(this.ctx, session, scope, entry, 'reject', reason)
    await this.assertUnchanged(scope, entry)
    await this.ctx.longTermMemory.forget({
      scope,
      id: entry.id,
      expectedRevision: entry.revision,
      reason,
      evidence: [evidence],
      governance: { kind: 'user_rejected', sessionId: session.id, eventSeqs: evidence.eventSeqs },
    })
    return this.read({ workspaceId: scope.workspaceId, sessionId: session.id, id: entry.id })
  }

  /**
   * Append a user-authored replacement revision; previous evidence remains immutable.
   * @param request - attached session, memory id, and replacement fields.
   * @returns the revised current detail.
   */
  @Remote('revise')
  async revise(request: MemoryCenterReviseRequest): Promise<MemoryCenterDetail> {
    const { session, scope, entry } = await this.mutationContext(request)
    if (entry.status === 'tombstoned' || entry.status === 'superseded') {
      throw new Error(`memoryCenter cannot revise ${entry.status} memory ${entry.id}`)
    }
    const excerpt = request.content?.trim() ?? request.summary?.trim() ?? `revise memory ${entry.id}`
    const evidence = await governanceEvidence(this.ctx, session, scope, entry, 'revise', excerpt)
    await this.assertUnchanged(scope, entry)
    await this.ctx.longTermMemory.revise({
      scope,
      id: entry.id,
      expectedRevision: entry.revision,
      ...request.content === undefined ? {} : { content: request.content },
      ...request.summary === undefined ? {} : { summary: request.summary },
      ...request.importance === undefined ? {} : { importance: request.importance },
      ...request.confidence === undefined ? {} : { confidence: request.confidence },
      ...request.status === undefined ? {} : { status: request.status },
      ...request.validUntil === undefined ? {} : { validUntil: request.validUntil },
      trust: 'user-stated',
      evidence: [evidence],
      governance: { kind: 'user_confirmed', sessionId: session.id, eventSeqs: evidence.eventSeqs },
    })
    return this.read({ workspaceId: scope.workspaceId, sessionId: session.id, id: entry.id })
  }

  /**
   * Append a tombstone; no physical deletion or invented retention policy occurs.
   * @param request - attached session, memory id, and reason.
   * @returns the tombstoned current detail.
   */
  @Remote('delete')
  async delete(request: MemoryCenterDeleteRequest): Promise<MemoryCenterDetail> {
    const { session, scope, entry } = await this.mutationContext(request)
    const reason = requireText('reason', request.reason)
    const evidence = await governanceEvidence(this.ctx, session, scope, entry, 'tombstone', reason)
    await this.assertUnchanged(scope, entry)
    await this.ctx.longTermMemory.forget({
      scope,
      id: entry.id,
      expectedRevision: entry.revision,
      reason,
      evidence: [evidence],
      governance: { kind: 'user_rejected', sessionId: session.id, eventSeqs: evidence.eventSeqs },
    })
    return this.read({ workspaceId: scope.workspaceId, sessionId: session.id, id: entry.id })
  }

  private scope(workspaceId: string): MemoryScope {
    return { workspaceId: requireText('workspaceId', workspaceId), userId: this.userId, agentId: this.agentId }
  }

  private session(sessionId: string | undefined): Session | undefined {
    return sessionId === undefined ? undefined : this.ctx.sessions.get(brandSessionId(sessionId))
  }

  private requireSession(sessionId: string): Session {
    const session = this.session(sessionId)
    if (session === undefined) {
      throw new TypertLookupFailure({
        code: 'session-not-found',
        message: `session "${sessionId}" not found (not attached)`,
        details: { sessionId },
      })
    }
    return session
  }

  private readContext(request: MemoryCenterScope): { session: Session; scope: MemoryScope } {
    const session = this.requireSession(request.sessionId)
    const workspaceId = session.header.cwd ?? 'global'
    if (request.workspaceId !== workspaceId) {
      throw new TypertLookupFailure({
        code: 'workspace-scope-mismatch',
        message: `session "${request.sessionId}" does not own workspace scope "${request.workspaceId}"`,
        details: { sessionId: request.sessionId, workspaceId: request.workspaceId },
      })
    }
    return { session, scope: this.scope(workspaceId) }
  }

  private async mutationContext(request: MemoryCenterMutationRequest): Promise<{
    session: Session
    scope: MemoryScope
    entry: MemoryEntry
  }> {
    if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) {
      throw new Error('memoryCenter expectedRevision must be a positive safe integer')
    }
    const session = this.requireSession(request.sessionId)
    const scope = this.scope(session.header.cwd ?? 'global')
    const entry = await this.requireEntry(scope, request.id)
    if (entry.revision !== request.expectedRevision) {
      throw new Error(
        `memoryCenter revision conflict for ${entry.id}: expected ${request.expectedRevision}, current ${entry.revision}`,
      )
    }
    return { session, scope, entry }
  }

  private async assertUnchanged(scope: MemoryScope, observed: MemoryEntry): Promise<void> {
    const current = await this.requireEntry(scope, observed.id)
    if (current.revision !== observed.revision) {
      throw new Error(
        `memoryCenter revision conflict for ${observed.id}: expected ${observed.revision}, current ${current.revision}`,
      )
    }
  }

  private async requireEntry(scope: MemoryScope, id: string): Promise<MemoryEntry> {
    const entry = await this.ctx.longTermMemory.read(scope, MemoryId(requireText('id', id)))
    if (entry === undefined) throw new Error(`memoryCenter: memory ${id} was not found in the requested scope`)
    return entry
  }

  private async collect(
    scope: MemoryScope,
    statuses: readonly MemoryStatus[] | undefined,
    kinds: readonly MemoryKind[] | undefined,
    includeExpired: boolean,
  ): Promise<MemoryEntry[]> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const entries = new Map<string, MemoryEntry>()
      let offset = 0
      let expectedTotal: number | undefined
      while (true) {
        const page = await this.ctx.longTermMemory.list({
          scope,
          limit: DEFAULT_PAGE_SIZE,
          offset,
          ...statuses === undefined ? {} : { statuses },
          ...kinds === undefined ? {} : { kinds },
          includeExpired,
        })
        expectedTotal ??= page.total
        if (page.total !== expectedTotal) break
        for (const entry of page.entries) entries.set(entry.id, entry)
        if (!page.hasMore) {
          if (entries.size === expectedTotal) return [...entries.values()]
          break
        }
        if (page.entries.length === 0) break
        offset += page.entries.length
      }
    }
    throw new Error('memoryCenter governance catalog changed repeatedly during pagination; retry the read')
  }

  private async semanticConflicts(
    scope: MemoryScope,
    target: MemoryEntry,
    deterministic: readonly MemoryConflictCandidate[],
  ): Promise<readonly MemoryConflictCandidate[]> {
    const detector = this.ctx.get('memoryConflictDetector')
    if (detector === undefined) return []
    const candidates = await this.collect(scope, ['candidate', 'active', 'disputed'], undefined, true)
    const deterministicIds = new Set(deterministic.map(item => item.entry.id))
    let found: readonly MemoryConflictCandidate[]
    try {
      found = await detector.detect({
        target,
        candidates: candidates.filter(item => item.id !== target.id && !deterministicIds.has(item.id)),
        limit: 50,
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`memoryCenter semantic conflict detector failed: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
    return found.filter(item => item.relation === 'semantic-conflict'
      && item.entry.id !== target.id
      && item.entry.scope.workspaceId === scope.workspaceId
      && item.entry.scope.userId === scope.userId
      && item.entry.scope.agentId === scope.agentId
      && Number.isFinite(item.score) && item.score >= 0 && item.score <= 1
      && item.reasons.length > 0 && item.reasons.every(reason => reason.trim() !== '')
      && item.detectorId.trim() !== '')
  }

  private async usageView(
    scope: MemoryScope,
    entries: readonly MemoryEntry[],
  ): Promise<{
    coverage: MemoryUsageCoverage
    byId: ReadonlyMap<string, readonly MemoryUsageOccurrence[]>
  }> {
    const sessionQuery = this.ctx.get('sessionQuery')
    if (sessionQuery === undefined) {
      return {
        coverage: { status: 'unavailable', sessionsScanned: 0, sessionsFailed: 0 },
        byId: new Map(),
      }
    }
    const wanted = new Set<string>(entries.map(entry => entry.id))
    const byId = new Map<string, MemoryUsageOccurrence[]>()
    let failed = 0
    const records = (await sessionQuery.listSessions())
      .filter(record => record.persisted && (record.header.cwd ?? 'global') === scope.workspaceId)
    let next = 0
    const workers = Array.from({ length: Math.min(this.usageConcurrency, records.length) }, async () => {
      while (next < records.length) {
        const index = next
        next += 1
        const record = records[index]
        if (record === undefined) continue
        try {
          const snapshot = await sessionQuery.readSession(record.header.id)
          collectUsage(snapshot.session.id, snapshot.events, wanted, byId)
        } catch {
          failed += 1
        }
      }
    })
    await Promise.all(workers)
    for (const values of byId.values()) {
      values.sort((left, right) => left.eventTime - right.eventTime
        || left.sessionId.localeCompare(right.sessionId)
        || left.eventSeq - right.eventSeq)
    }
    return {
      coverage: {
        status: failed === 0 ? 'complete' : 'partial',
        sessionsScanned: records.length - failed,
        sessionsFailed: failed,
      },
      byId,
    }
  }
}

export default MemoryCenterGateway

async function governanceEvidence(
  ctx: Context,
  session: Session,
  scope: MemoryScope,
  entry: MemoryEntry,
  action: MemoryGovernanceAction,
  excerpt: string,
): Promise<MemoryEvidence> {
  const normalized = Array.from(requireText('governance excerpt', excerpt))
    .slice(0, MAX_GOVERNANCE_EXCERPT_CHARS)
    .join('')
  const event = session.append('memory/governance-requested', {
    memoryId: entry.id,
    action,
    workspaceId: scope.workspaceId,
    excerpt: normalized,
  })
  // The Memory revision cites this exact event. Drive the Session Store's one durability barrier
  // before committing the separate Memory database so a configured backend cannot retain a
  // revision whose evidence event was still only buffered in process memory.
  if (!(await ctx.sessions.flush(session))) {
    throw new Error(
      `memoryCenter cannot commit governance for ${entry.id}: no Session durability listener participated`,
    )
  }
  return {
    sessionId: session.id,
    eventSeqs: [event.seq],
    verification: 'user-statement',
    excerpt: normalized,
  }
}

function centerEntry(entry: MemoryEntry, usage: ReadonlyMap<string, readonly MemoryUsageOccurrence[]>): MemoryCenterEntry {
  return {
    entry,
    freshness: entry.validUntil !== undefined && entry.validUntil <= Date.now() ? 'expired' : 'current',
    whyUsed: (usage.get(entry.id) ?? []).map(item => ({
      ...item,
      revisionState: item.memoryRevision === undefined
        ? 'unknown' as const
        : item.memoryRevision === entry.revision ? 'current' as const : 'historical' as const,
    })),
  }
}

function collectUsage(
  sessionId: string,
  events: readonly SessionEvent[],
  wanted: ReadonlySet<string>,
  byId: Map<string, MemoryUsageOccurrence[]>,
): void {
  for (const event of events) {
    if (event.type !== 'context/prepared') continue
    for (const contribution of event.data.contributions) {
      if (contribution.messageEventSeqs.length === 0) continue
      for (const evidence of contribution.evidence) {
        const id = memoryIdOfEvidence(evidence)
        if (id === undefined || !wanted.has(id)) continue
        const memoryRevision = memoryRevisionOfEvidence(evidence)
        const occurrence: MemoryUsageOccurrence = {
          sessionId,
          turn: event.data.turn,
          step: event.data.step,
          eventSeq: event.seq,
          eventTime: event.time,
          evidenceId: evidence.evidenceId,
          ...memoryRevision === undefined ? {} : { memoryRevision },
          revisionState: 'unknown',
        }
        byId.set(id, [...byId.get(id) ?? [], occurrence])
      }
    }
  }
}

function mergeConflicts(
  linked: readonly MemoryConflictComparison[],
  detected: readonly MemoryConflictCandidate[],
): MemoryConflictComparison[] {
  const result = [...linked]
  const seen = new Set(linked.map(item => `${item.relation}\u0000${item.entry.entry.id}`))
  for (const item of detected) {
    const key = `${item.relation}\u0000${item.entry.id}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push({
      relation: item.relation,
      entry: centerEntry(item.entry, new Map()),
      score: item.score,
      reasons: [...item.reasons],
      detectorId: item.detectorId,
    })
  }
  return result
}

function summarizeOutcomes(
  outcomes: readonly import('@relay-harness/rlh-memory/types').MemoryOutcome[],
): import('./types.ts').MemoryOutcomeSummary {
  let positive = 0
  let negative = 0
  let neutral = 0
  for (const outcome of outcomes) {
    if (outcome.impact === 'positive') positive += 1
    else if (outcome.impact === 'negative') negative += 1
    else neutral += 1
  }
  const ranked = positive + negative
  const rankingAdjustment = ranked === 0
    ? 0
    : Math.max(-0.1, Math.min(0.1, ((positive - negative) / Math.max(4, ranked)) * 0.1))
  return { positive, negative, neutral, rankingAdjustment }
}

function memoryIdOfEvidence(evidence: SessionEvent<'context/prepared'>['data']['contributions'][number]['evidence'][number]): string | undefined {
  if (evidence.resource.sourceId === 'long-term-memory') return evidence.resource.key
  const match = /^memory:([^:]+):\d+$/.exec(evidence.evidenceId)
  return match?.[1]
}

function memoryRevisionOfEvidence(
  evidence: SessionEvent<'context/prepared'>['data']['contributions'][number]['evidence'][number],
): number | undefined {
  const revision = evidence.resource.sourceId === 'long-term-memory'
    ? evidence.resource.revision
    : /^memory:[^:]+:(\d+)$/u.exec(evidence.evidenceId)?.[1]
  if (revision === undefined || !/^\d+$/u.test(revision)) return undefined
  const value = Number(revision)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function requireText(label: string, value: string): string {
  const text = value.trim()
  if (text.length === 0) throw new Error(`memoryCenter ${label} must not be blank`)
  return text
}

function pageWindow(limitInput: number | undefined, offsetInput: number | undefined): { limit: number; offset: number } {
  const limit = limitInput ?? DEFAULT_PAGE_SIZE
  const offset = offsetInput ?? 0
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DEFAULT_PAGE_SIZE) {
    throw new Error(`memoryCenter limit must be an integer from 1 through ${DEFAULT_PAGE_SIZE}`)
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('memoryCenter offset must be a non-negative safe integer')
  }
  return { limit, offset }
}
