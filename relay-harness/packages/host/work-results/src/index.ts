/** User-only Work acceptance and Library adapter over canonical Session logs. */
import { createHash, randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import type { Agent } from '@relay-harness/rlh-agent'
import type { Session } from '@relay-harness/rlh-session'
import type {} from '@relay-harness/rlh-session-persistence'
import type {} from '@relay-harness/rlh-session-query'
import type {} from '@relay-harness/rlh-jobs'
import type {} from '@relay-harness/rlh-api-gateway'
import type {} from '@relay-harness/rlh-host-apiproxy'
import { RpcId } from '@relay-harness/rlh-host-apiproxy/api'
import { Remote, TypertRemoteService } from '@relay-harness/rlh-typert-protocol'
import { deliverablesProjection, workAcceptanceProjection, readAcceptedRevision } from './projection.ts'
import type {
  WorkAcceptanceProjection, WorkVerifiedReview, WorkAcceptRequest, WorkAcceptReceipt,
  WorkLibraryRequest, WorkLibraryPage, WorkLibraryEntry, WorkOpenRequest, WorkLibraryRevision,
} from './types.ts'

export type * from './types.ts'

declare module '@relay-harness/cordis' { interface Context { workResults: WorkResultsService } }

/** Deployment bounds for one Library request. */
export interface Config {
  /** Maximum existing Session logs inspected per page. */
  readonly scanSessionsPerPage?: number
  /** Maximum output rows a caller may request. */
  readonly maxResultsPerPage?: number
  /** Row limit used when the request omits one. */
  readonly defaultResultsPerPage?: number
}

/** Stateless business adapter; accepted versions and file inventories remain log projections. */
export class WorkResultsService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionQuery', 'sessionProjections', 'jobs', 'typertGateway', 'apiProxy', 'hostInteractions']
  static Config: z<Config> = z.object({
    scanSessionsPerPage: z.natural().min(1).max(100).default(20),
    maxResultsPerPage: z.natural().min(1).max(500).default(100),
    defaultResultsPerPage: z.natural().min(1).max(500).default(50),
  })
  private readonly config: Required<Config>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'workResults')
    this.config = config as Required<Config>
    if (this.config.defaultResultsPerPage > this.config.maxResultsPerPage) throw new Error('workResults defaultResultsPerPage exceeds maxResultsPerPage')
    ctx.sessionProjections.register(deliverablesProjection)
    ctx.sessionProjections.register(workAcceptanceProjection)
  }

  /**
   * Read the exact review prefix without changing goal or task state.
   * @param agent - addressed live agent resolved by the existing Remote lookup.
   * @param signal - cancellation through the captured durability verification.
   * @returns the captured review cut and only its physically verified receipt.
   */
  @Remote('get') async get(agent: Agent, signal: AbortSignal): Promise<WorkVerifiedReview> {
    this.userRequest('get')
    this.assertLive(agent)
    const cut = this.acceptance(agent.session)
    const through = agent.session.seq - 1
    const receipt = agent.session.events.findLast(event => event.type === 'work/accepted')
    if (receipt === undefined) return { ...cut, verifiedThroughSeq: -1, current: true }
    if (!await this.ctx.sessions.flush(agent.session)) throw new Error('workResults persistence checkpoint is unavailable')
    this.userRequest('get')
    signal.throwIfAborted()
    this.assertLive(agent)
    const stored = await this.ctx.sessionPersistence.readFrom(agent.id, receipt.seq, signal)
    this.userRequest('get')
    this.assertLive(agent)
    const persisted = stored.events.find(event => event.seq === receipt.seq)
    if (persisted?.type !== 'work/accepted' || readAcceptedRevision(persisted.data) !== cut.acceptedRevision
      || (stored.events.at(-1)?.seq ?? -1) < through) throw new Error('workResults confirmation is not durably recorded')
    return { ...cut, verifiedThroughSeq: through, current: this.acceptance(agent.session).reviewRevision === cut.reviewRevision }
  }

  /**
   * Record explicit user acceptance after final quiescence and revision checks.
   * @param agent - exact live runtime root being reviewed.
   * @param request - expected non-acceptance log revision shown to the user.
   * @param signal - trusted carrier cancellation, never a wire argument.
   * @returns a receipt only after durability; later work makes its current flag false.
   */
  @Remote('accept') async accept(agent: Agent, request: WorkAcceptRequest, signal: AbortSignal): Promise<WorkAcceptReceipt> {
    this.userRequest('accept')
    signal.throwIfAborted()
    this.assertReviewable(agent, request.reviewRevision)
    return agent.runMaintenance(async (maintenanceSignal) => {
      if (!await this.ctx.sessions.flush(agent.session)) throw new Error('workResults persistence checkpoint is unavailable')
      this.userRequest('accept')
      signal.throwIfAborted()
      maintenanceSignal.throwIfAborted()
      this.assertReviewable(agent, request.reviewRevision)
      const prior = this.acceptance(agent.session)
      let recordedSeq: number
      if (prior.acceptedRevision === request.reviewRevision) {
        const receipt = agent.session.events.findLast(event => event.type === 'work/accepted')
        if (receipt === undefined) throw new Error('workResults acceptance projection has no source receipt')
        recordedSeq = receipt.seq
      } else {
        recordedSeq = agent.session.append('work/accepted', { reviewedThroughSeq: request.reviewRevision, actor: 'host-client' }).seq
      }
      if (!await this.ctx.sessions.flush(agent.session)) throw new Error('workResults persistence checkpoint is unavailable')
      this.userRequest('accept')
      const stored = await this.ctx.sessionPersistence.readFrom(agent.id, recordedSeq, signal)
      this.userRequest('accept')
      const persisted = stored.events.find(event => event.seq === recordedSeq)
      if (persisted?.type !== 'work/accepted' || readAcceptedRevision(persisted.data) !== request.reviewRevision) {
        throw new Error('workResults confirmation is not durably recorded')
      }
      return {
        reviewedThroughSeq: request.reviewRevision, recordedSeq,
        current: this.acceptance(agent.session).reviewRevision === request.reviewRevision,
      }
    })
  }

  /**
   * Scan a bounded page of existing Session logs without activating any agent.
   * @param request - filename query, pagination position, and result bound.
   * @param signal - cancellation between bounded non-activating reads.
   * @returns source-attributed outputs and explicit scan/incomplete-history coverage.
   */
  @Remote('list') async list(request: WorkLibraryRequest, signal: AbortSignal): Promise<WorkLibraryPage> {
    this.userRequest('list')
    signal.throwIfAborted()
    const query = request.query?.trim().toLocaleLowerCase() ?? ''
    if (query.length > 500) throw new Error('workResults query exceeds 500 characters')
    let sessionOffset = this.offset(request.sessionOffset)
    let pathOffset = this.offset(request.pathOffset)
    const limit = request.limit ?? this.config.defaultResultsPerPage
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > this.config.maxResultsPerPage) throw new Error('workResults invalid result limit')
    const records = await this.ctx.sessionQuery.listSessions(signal)
    this.userRequest('list')
    const corpusRevision = await this.libraryRevision(records, query, signal)
    this.userRequest('list')
    if ((sessionOffset > 0 || pathOffset > 0) && request.corpusRevision !== corpusRevision) throw new Error('workResults Library changed; restart the search')
    const entries: WorkLibraryEntry[] = []
    let scannedSessions = 0
    let unindexedResults = 0
    let unavailableSessions = 0
    while (sessionOffset < records.length && scannedSessions < this.config.scanSessionsPerPage) {
      const record = records[sessionOffset]
      if (record === undefined) break
      let snapshot: Awaited<ReturnType<typeof this.ctx.sessionQuery.readSession>>
      try { snapshot = await this.ctx.sessionQuery.readSession(record.header.id) } catch {
        this.userRequest('list')
        unavailableSessions += 1
        scannedSessions += 1
        sessionOffset += 1
        pathOffset = 0
        continue
      }
      this.userRequest('list')
      scannedSessions += 1
      const inventory = snapshot.events.reduce((state, event) => deliverablesProjection.apply(state, event), deliverablesProjection.init())
      unindexedResults += inventory.unindexedResults
      while (pathOffset < inventory.paths.length) {
        const path = inventory.paths[pathOffset++]
        if (path === undefined || !path.toLocaleLowerCase().includes(query)) continue
        entries.push({ sessionId: snapshot.session.id, path, ...snapshot.session.cwd === undefined ? {} : { cwd: snapshot.session.cwd } })
        if (entries.length === limit) break
      }
      if (pathOffset >= inventory.paths.length) { sessionOffset += 1; pathOffset = 0 }
      if (entries.length === limit) break
    }
    if (corpusRevision !== await this.libraryRevision(await this.ctx.sessionQuery.listSessions(signal), query, signal)) throw new Error('workResults Library changed during the scan; restart the search')
    this.userRequest('list')
    return {
      entries, scannedSessions, totalSessions: records.length, unindexedResults, unavailableSessions,
      next: sessionOffset < records.length ? { sessionOffset, pathOffset, corpusRevision } : null,
    }
  }

  /**
   * Validate a captured output against its source Session and open it on the Host.
   * @param request - source Session identity and exact execution-recorded path.
   * @param signal - carrier cancellation through native-open completion.
   * @returns after the existing native-open operation succeeds.
   */
  @Remote('open') async open(request: WorkOpenRequest, signal: AbortSignal): Promise<void> {
    this.userRequest('open')
    signal.throwIfAborted()
    const source = await this.ctx.sessionQuery.readSession(request.sessionId)
    this.userRequest('open')
    const inventory = source.events.reduce((state, event) => deliverablesProjection.apply(state, event), deliverablesProjection.init())
    if (!inventory.paths.includes(request.path)) throw new Error('workResults output is not recorded in the source Session')
    const cwd = source.session.cwd
    let candidate: string
    if (isAbsolute(request.path)) candidate = resolve(request.path)
    else {
      if (cwd === undefined) throw new Error('workResults relative output has no source directory')
      candidate = resolve(cwd, request.path)
    }
    const target = await realpath(candidate)
    this.userRequest('open')
    const current = await this.ctx.sessionQuery.readSession(request.sessionId)
    this.userRequest('open')
    const currentInventory = current.events.reduce(
      (state, event) => deliverablesProjection.apply(state, event), deliverablesProjection.init(),
    )
    if (current.session.cwd !== cwd || !currentInventory.paths.includes(request.path)) {
      throw new Error('workResults source changed before opening the output')
    }
    const finalTarget = await realpath(candidate)
    this.userRequest('open')
    if (finalTarget !== target) {
      throw new Error('workResults output changed before opening; review it again')
    }
    const response = await this.ctx.apiProxy.host.openPath({ rpcId: RpcId(randomUUID()), payload: { path: target } }, signal)
    if (!response.result.ok) throw new Error(response.result.error.message)
  }

  private userRequest(method: string): AbortSignal {
    const request = this.ctx.typertGateway.currentTrustedRequest()
    if (request?.endpoint !== `workResults/${method}` || this.ctx.agents.currentInitiator() !== undefined) {
      throw new Error('workResults requires an active explicit user Remote request')
    }
    request.signal.throwIfAborted()
    return request.signal
  }

  private assertLive(agent: Agent): void {
    if (this.ctx.agents.get(agent.id) !== agent || this.ctx.sessions.get(agent.id) !== agent.session) throw new Error('workResults Session is not the live owner')
  }

  private assertReviewable(agent: Agent, revision: number): void {
    this.assertLive(agent)
    if (!this.ctx.agents.roots().includes(agent)) throw new Error('workResults only accepts a root Work')
    const pending = this.ctx.hostInteractions.pendingFor(agent.id)
    if (!this.acceptance(agent.session).reviewable || agent.status !== 'idle' || agent.inbox.hasPending || pending.approvals > 0 || pending.questions > 0
      || this.ctx.jobs.list(agent).some(job => job.ownerSession === agent.id && (job.status === 'running' || job.status === 'stopping'))) {
      throw new Error('workResults cannot accept while work or human interactions remain pending')
    }
    if (!Number.isSafeInteger(revision) || revision < 0 || this.acceptance(agent.session).reviewRevision !== revision) throw new Error('workResults review revision changed; refresh before accepting')
  }

  private acceptance(session: Session): WorkAcceptanceProjection {
    const value = this.ctx.sessionProjections.snapshot(session).values.workAcceptance
    if (value === undefined) throw new Error('workResults acceptance projection is unavailable')
    return value
  }

  private async libraryRevision(records: Awaited<ReturnType<Context['sessionQuery']['listSessions']>>, query: string, signal: AbortSignal): Promise<WorkLibraryRevision> {
    const persisted = new Map((await this.ctx.sessionPersistence.listSnapshots(signal)).map(row => [row.header.id, row.revision]))
    const stamps = records.map((record) => {
      const live = this.ctx.sessions.get(record.header.id)
      return [record.header.id, live === undefined ? ['stored', persisted.get(record.header.id)] : ['live', live.header.createdAt, this.ctx.sessionProjections.snapshot(live).values.deliverables]]
    })
    return createHash('sha256').update(JSON.stringify([query, stamps])).digest('hex') as WorkLibraryRevision
  }

  private offset(value: number | undefined): number {
    const offset = value ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('workResults invalid pagination offset')
    return offset
  }
}

export default WorkResultsService
