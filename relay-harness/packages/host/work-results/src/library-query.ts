/** Bounded retained corpus observations over the existing deliverables projection cache. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@relay-harness/cordis'
import type { SessionHeader, SessionId } from '@relay-harness/rlh-session'
import type {} from '@relay-harness/rlh-session-projection-cache'
import { deliverablesProjection } from './projection.ts'
import type { DeliverablesProjection, WorkLibraryPage, WorkLibraryRequest, WorkLibraryRevision } from './types.ts'

/** Deployment bounds; query pages never enumerate the complete corpus again. */
export interface LibraryQueryConfig {
  readonly scanSessionsPerPage: number
  readonly maxResultsPerPage: number
  readonly defaultResultsPerPage: number
  readonly maxLibraryQueries: number
  readonly libraryQueryTtlMs: number
  readonly maxLibrarySessions: number
}
interface Observation {
  readonly header: SessionHeader
  result?: { inventory: DeliverablesProjection; throughSeq: number } | { unavailable: true }
  pending?: Promise<void>
}
interface Query {
  readonly revision: WorkLibraryRevision
  readonly query: string
  readonly epoch: number
  readonly expiresAt: number
  readonly records: Observation[]
  /** Index of `records` by source identity for constant-time invalidation checks. */
  readonly bySession: Map<SessionId, Observation>
  readonly total: number
}

/** Retains bounded metadata and page observations, not an independently writable Work database. */
export class LibraryQueries {
  private readonly queries = new Map<WorkLibraryRevision, Query>()
  private epoch = 0
  constructor(private readonly ctx: Context, private readonly config: LibraryQueryConfig) {
    const invalidate = (): void => { this.epoch += 1; this.queries.clear() }
    ctx.on('session/created', invalidate, { global: true })
    ctx.on('session/disposed', invalidate, { global: true })
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'tool/result') return
      // A result only invalidates when it comes from a Session outside a retained
      // observation or actually changes an observed inventory; identical or failed
      // outputs keep a still-valid page alive.
      for (const query of this.queries.values()) {
        const row = query.bySession.get(session.id)
        if (row === undefined) { invalidate(); return }
        if (row.result === undefined || !('inventory' in row.result)) continue
        if (deliverablesProjection.apply(row.result.inventory, event) !== row.result.inventory) { invalidate(); return }
      }
    }, { global: true })
    ctx.effect(() => () => { this.queries.clear() }, 'work-results: Library query observations')
  }

  /** Read a bounded page, reusing live or persisted projection values and retaining each source cut.
   * @param request - Filename query and opaque continuation.
   * @param signal - Trusted caller cancellation.
   * @returns Source-attributed observations; end-of-cursor never means the live universe was exhaustive.
   */
  async read(request: WorkLibraryRequest, signal: AbortSignal): Promise<WorkLibraryPage> {
    signal.throwIfAborted()
    const text = request.query?.trim().toLocaleLowerCase() ?? ''
    if (Array.from(text).length > 500) throw new Error('workResults query exceeds 500 characters')
    let sessionOffset = offset(request.sessionOffset)
    let pathOffset = offset(request.pathOffset)
    const limit = request.limit ?? this.config.defaultResultsPerPage
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.config.maxResultsPerPage) throw new Error('workResults invalid result limit')
    this.expire()
    let query: Query
    if (request.corpusRevision !== undefined || sessionOffset > 0 || pathOffset > 0) {
      const existing = request.corpusRevision === undefined ? undefined : this.queries.get(request.corpusRevision)
      if (existing === undefined || existing.query !== text || existing.epoch !== this.epoch) throw changed()
      query = existing
    } else {
      const epoch = this.epoch
      const records = await this.ctx.sessionQuery.listSessions(signal)
      signal.throwIfAborted()
      if (epoch !== this.epoch) throw changed()
      const queryRecords = records.slice(0, this.config.maxLibrarySessions).map(record => ({ header: record.header }))
      query = {
        revision: randomUUID() as WorkLibraryRevision, query: text, epoch,
        expiresAt: Date.now() + this.config.libraryQueryTtlMs,
        records: queryRecords,
        bySession: new Map(queryRecords.map(record => [record.header.id, record])),
        total: records.length,
      }
      while (this.queries.size >= this.config.maxLibraryQueries) {
        const oldest = this.queries.keys().next().value
        if (oldest === undefined) break
        this.queries.delete(oldest)
      }
      this.queries.set(query.revision, query)
    }
    const entries: WorkLibraryPage['entries'][number][] = []
    const observedSessionIds: SessionId[] = []
    let scannedSessions = 0
    let unindexedResults = 0
    let unavailableSessions = 0
    while (sessionOffset < query.records.length && scannedSessions < this.config.scanSessionsPerPage) {
      signal.throwIfAborted()
      const observation = query.records[sessionOffset]
      if (observation === undefined) break
      // A cancelled caller owns no permanently cached failure; later reads can retry the observation.
      await this.observe(observation, signal)
      signal.throwIfAborted()
      const result = observation.result
      if (result === undefined) throw new Error('Library observation did not settle')
      scannedSessions += 1
      observedSessionIds.push(observation.header.id)
      if ('unavailable' in result) {
        unavailableSessions += 1; sessionOffset += 1; pathOffset = 0; continue
      }
      unindexedResults += result.inventory.unindexedResults
      while (pathOffset < result.inventory.paths.length) {
        const path = result.inventory.paths[pathOffset++]
        if (path === undefined || !path.toLocaleLowerCase().includes(text)) continue
        entries.push({ sessionId: observation.header.id, path, sourceThroughSeq: result.throughSeq,
          ...(observation.header.cwd === undefined ? {} : { cwd: observation.header.cwd }) })
        if (entries.length === limit) break
      }
      if (pathOffset >= result.inventory.paths.length) { sessionOffset += 1; pathOffset = 0 }
      if (entries.length === limit) break
    }
    if (query.epoch !== this.epoch || !this.queries.has(query.revision) || Date.now() >= query.expiresAt) throw changed()
    return {
      entries, scannedSessions, totalSessions: query.total, unindexedResults, unavailableSessions,
      observedSessionIds,
      coverage: { scope: 'observed-corpus', snapshotId: query.revision, omittedSessions: query.total - query.records.length },
      next: sessionOffset < query.records.length ? { sessionOffset, pathOffset, corpusRevision: query.revision } : null,
    }
  }

  private async observe(row: Observation, signal: AbortSignal): Promise<void> {
    if (row.result !== undefined) return
    if (row.pending !== undefined) { await row.pending; signal.throwIfAborted(); return }
    const pending = (async () => {
      try {
        const live = this.ctx.sessions.get(row.header.id)
        if (live !== undefined) {
          const projection = this.ctx.sessionProjections.snapshot(live)
          const inventory = projection.values.deliverables
          if (inventory === undefined) throw new Error('deliverables projection unavailable')
          row.result = { inventory: { paths: [...inventory.paths], unindexedResults: inventory.unindexedResults }, throughSeq: projection.asOfSeq }
          return
        }
        const cache = this.ctx.get('sessionProjectionCache')
        if (cache !== undefined) {
          const projection = await cache.coldSnapshot(row.header.id, signal)
          signal.throwIfAborted()
          if (projection.values.deliverables !== undefined) {
            row.result = { inventory: projection.values.deliverables, throughSeq: projection.asOfSeq }
            return
          }
        }
        const source = await this.ctx.sessionQuery.readSession(row.header.id)
        signal.throwIfAborted()
        row.result = { inventory: source.events.reduce((value, event) => deliverablesProjection.apply(value, event), deliverablesProjection.init()), throughSeq: source.events.at(-1)?.seq ?? -1 }
      } catch (error) {
        if (signal.aborted) throw error
        row.result = { unavailable: true }
      }
    })()
    row.pending = pending
    try { await pending } finally { delete row.pending }
  }

  private expire(): void {
    const now = Date.now()
    for (const [id, query] of this.queries) if (query.expiresAt <= now) this.queries.delete(id)
  }
}
function offset(value: number | undefined): number {
  const resolved = value ?? 0
  if (!Number.isSafeInteger(resolved) || resolved < 0) throw new Error('workResults invalid pagination offset')
  return resolved
}
function changed(): Error { return new Error('workResults Library changed; restart the search') }
