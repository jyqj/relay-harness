/** User-only Work acceptance and Library adapter over canonical Session logs. */
import { randomUUID } from 'node:crypto'
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
import { LibraryQueries } from './library-query.ts'
import { readWorkView, readWorkHistory } from './work-view.ts'
import { confirmationBlockers } from './confirmation-policy.ts'
import { deliverablesProjection, workAcceptanceProjection, readAcceptedRevision } from './projection.ts'
import { latestContentReviewRead, readContentReview, sameContentSubject, workContentReviewProjection } from './content-review.ts'
import type {
  WorkAcceptanceProjection, WorkVerifiedReview, WorkAcceptRequest, WorkAcceptReceipt,
  WorkLibraryRequest, WorkLibraryPage, WorkOpenRequest,
  WorkReadRequest, WorkView, WorkHistoryRequest, WorkHistoryPage,
  WorkContentReview, WorkContentReviewRead, WorkContentReviewRequest, WorkContentReviewsProjection,
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
  /** Bounded execution rows in passive Work reads. */
  readonly maxExecutionEntries?: number
  /** Maximum text-message history rows returned per read. */
  readonly maxHistoryRows?: number
  /** Complete historical message text code-point allowance per read. */
  readonly maxHistoryChars?: number
  /** Maximum retained Library corpus observations. */
  readonly maxLibraryQueries?: number
  /** Lifespan of an opaque Library continuation in milliseconds. */
  readonly libraryQueryTtlMs?: number
  /** Maximum Session headers retained per Library observation; omissions are reported. */
  readonly maxLibrarySessions?: number
}

/** Stateless business adapter; accepted versions and file inventories remain log projections. */
export class WorkResultsService extends TypertRemoteService {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionQuery', 'sessionProjections', 'jobs', 'typertGateway', 'apiProxy', 'hostInteractions']
  static Config: z<Config> = z.object({
    scanSessionsPerPage: z.natural().min(1).max(100).default(20),
    maxResultsPerPage: z.natural().min(1).max(500).default(100),
    defaultResultsPerPage: z.natural().min(1).max(500).default(50),
    maxExecutionEntries: z.natural().min(1).max(1000).default(200),
    maxHistoryRows: z.natural().min(1).max(200).default(50),
    maxHistoryChars: z.natural().min(1).default(64000),
    maxLibraryQueries: z.natural().min(1).default(8),
    libraryQueryTtlMs: z.natural().min(1).default(120000),
    maxLibrarySessions: z.natural().min(1).default(10000),
  })
  private readonly config: Required<Config>
  private readonly library: LibraryQueries

  constructor(ctx: Context, config: Config) {
    super(ctx, 'workResults')
    this.config = config as Required<Config>
    if (this.config.defaultResultsPerPage > this.config.maxResultsPerPage) throw new Error('workResults defaultResultsPerPage exceeds maxResultsPerPage')
    ctx.sessionProjections.register(deliverablesProjection)
    ctx.sessionProjections.register(workAcceptanceProjection)
    ctx.sessionProjections.register(workContentReviewProjection)
    this.library = new LibraryQueries(ctx, this.config)
  }

  /** Read independent Work facts without resolving or resuming a live Agent.
   * @param request - Exact source Session address.
   * @param signal - Trusted request cancellation.
   * @returns Orthogonal goal, execution, coverage and action observations.
   */
  @Remote('inspect') async inspect(request: WorkReadRequest, signal: AbortSignal): Promise<WorkView> {
    this.userRequest('inspect')
    const view = await readWorkView(this.ctx, request.sessionId, this.config.maxExecutionEntries, signal)
    this.userRequest('inspect')
    return view
  }

  /** Read final message text without recovering execution or claiming a lease.
   * @param request - Source Session and bounded backward page.
   * @param signal - Trusted request cancellation.
   * @returns An immutable source cut, not a live conversation.
   */
  @Remote('history') async history(request: WorkHistoryRequest, signal: AbortSignal): Promise<WorkHistoryPage> {
    this.userRequest('history')
    const source = await this.ctx.sessionQuery.readSession(request.sessionId)
    this.userRequest('history')
    signal.throwIfAborted()
    return readWorkHistory(request.sessionId, source.events, request, this.config.maxHistoryRows, this.config.maxHistoryChars)
  }

  /** Verify a record without the Remote Agent resolver's implicit activation.
   * @param request - Exact Session identity.
   * @param signal - Request cancellation across persistence reads.
   * @returns The existing receipt semantics; a cold Session explicitly cannot be confirmed.
   */
  @Remote('review') async review(request: WorkReadRequest, signal: AbortSignal): Promise<WorkVerifiedReview> {
    this.userRequest('review')
    const agent = this.ctx.agents.get(request.sessionId)
    if (agent !== undefined) return this.verifyReview(agent, signal, 'review')
    const source = await this.ctx.sessionQuery.readSession(request.sessionId)
    this.userRequest('review')
    signal.throwIfAborted()
    const cut = source.events.reduce((state, event) => workAcceptanceProjection.apply(state, event), workAcceptanceProjection.init())
    return { ...cut, confirmationBlockedBy: ['runtime-unavailable'], verifiedThroughSeq: -1, current: false }
  }

  /**
   * Read the exact review prefix without changing goal or task state.
   * @param agent - addressed live agent resolved by the existing Remote lookup.
   * @param signal - cancellation through the captured durability verification.
   * @returns the captured review cut and only its physically verified receipt.
   */
  @Remote('get') async get(agent: Agent, signal: AbortSignal): Promise<WorkVerifiedReview> {
    return this.verifyReview(agent, signal, 'get')
  }

  private async verifyReview(agent: Agent, signal: AbortSignal, endpoint: 'get' | 'review'): Promise<WorkVerifiedReview> {
    this.userRequest(endpoint)
    this.assertLive(agent)
    const cut = this.acceptance(agent.session)
    const through = agent.session.seq - 1
    const receipt = agent.session.events.findLast(event => event.type === 'work/accepted')
    if (receipt === undefined) {
      return { ...cut, confirmationBlockedBy: this.confirmationBlockedBy(agent), verifiedThroughSeq: -1, current: true }
    }
    if (!await this.ctx.sessions.flush(agent.session)) throw new Error('workResults persistence checkpoint is unavailable')
    this.userRequest(endpoint)
    signal.throwIfAborted()
    this.assertLive(agent)
    const stored = await this.ctx.sessionPersistence.readFrom(agent.id, receipt.seq, signal)
    this.userRequest(endpoint)
    this.assertLive(agent)
    const persisted = stored.events.find(event => event.seq === receipt.seq)
    if (persisted?.type !== 'work/accepted' || readAcceptedRevision(persisted.data) !== cut.acceptedRevision
      || (stored.events.at(-1)?.seq ?? -1) < through) throw new Error('workResults confirmation is not durably recorded')
    return {
      ...cut, confirmationBlockedBy: this.confirmationBlockedBy(agent), verifiedThroughSeq: through,
      current: this.acceptance(agent.session).reviewRevision === cut.reviewRevision,
    }
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
    const result = await this.library.read(request, signal)
    this.userRequest('list')
    return result
  }

  /**
   * Read the latest explicit content review with its confirmed-vs-current comparison.
   * @param request - exact source Session address.
   * @param signal - cancellation through the non-activating source read.
   * @returns The latest review and per-version currency; the Host performs no fresh
   * re-reads, so every confirmed version reads `not-reverified` until a caller with a
   * fresh observation applies {@link contentCurrency}.
   */
  @Remote('contentReview') async contentReview(request: WorkReadRequest, signal: AbortSignal): Promise<WorkContentReviewRead> {
    this.userRequest('contentReview')
    const agent = this.ctx.agents.get(request.sessionId)
    let latest: WorkContentReview | null
    if (agent !== undefined) {
      this.assertLive(agent)
      latest = this.contentReviews(agent.session).latest
    } else {
      const source = await this.ctx.sessionQuery.readSession(request.sessionId)
      this.userRequest('contentReview')
      signal.throwIfAborted()
      latest = source.events
        .reduce((state, event) => workContentReviewProjection.apply(state, event), workContentReviewProjection.init()).latest
    }
    this.userRequest('contentReview')
    return latestContentReviewRead(latest)
  }

  /**
   * Record an explicit user content review bound to versions and check records, never to a log prefix.
   * @param agent - exact live Session receiving the durable `work/reviewed` event.
   * @param request - decision, observed content versions and check records.
   * @param signal - trusted carrier cancellation through the durability barrier.
   * @returns the recorded review; a byte-identical resubmission reuses the latest record.
   */
  @Remote('recordContentReview') async recordContentReview(agent: Agent, request: WorkContentReviewRequest, signal: AbortSignal): Promise<WorkContentReview> {
    this.userRequest('recordContentReview')
    signal.throwIfAborted()
    this.assertLive(agent)
    // Host-stamped fields; caller-supplied facts are validated by the same durable decoder.
    const candidate = readContentReview({
      reviewId: randomUUID(), decision: request.decision, contentVersions: request.contentVersions,
      contentVersionRefs: request.contentVersionRefs, checkRecords: request.checkRecords,
      checkRecordRefs: request.checkRecordRefs, actor: 'host-client', reviewedAt: Date.now(),
    })
    return agent.runMaintenance(async (maintenanceSignal) => {
      if (!await this.ctx.sessions.flush(agent.session)) throw new Error('workResults persistence checkpoint is unavailable')
      this.userRequest('recordContentReview')
      signal.throwIfAborted()
      maintenanceSignal.throwIfAborted()
      this.assertLive(agent)
      const latestEvent = agent.session.events.findLast(event => event.type === 'work/reviewed')
      const prior = latestEvent === undefined ? null : readContentReview(latestEvent.data)
      const recordedSeq = latestEvent !== undefined && prior !== null && sameContentSubject(prior, candidate)
        ? latestEvent.seq
        : agent.session.append('work/reviewed', candidate).seq
      if (!await this.ctx.sessions.flush(agent.session)) throw new Error('workResults persistence checkpoint is unavailable')
      this.userRequest('recordContentReview')
      const stored = await this.ctx.sessionPersistence.readFrom(agent.id, recordedSeq, signal)
      this.userRequest('recordContentReview')
      const persisted = stored.events.find(event => event.seq === recordedSeq)
      if (persisted?.type !== 'work/reviewed') throw new Error('workResults content review is not durably recorded')
      return readContentReview(persisted.data)
    })
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
    const blockers = this.confirmationBlockedBy(agent)
    if (blockers.includes('not-root')) throw new Error('workResults only accepts a root Work')
    if (blockers.length > 0) throw new Error('workResults cannot accept while work or human interactions remain pending')
    if (!Number.isSafeInteger(revision) || revision < 0 || this.acceptance(agent.session).reviewRevision !== revision) throw new Error('workResults review revision changed; refresh before accepting')
  }

  private confirmationBlockedBy(agent: Agent): WorkVerifiedReview['confirmationBlockedBy'] {
    const pending = this.ctx.hostInteractions.pendingFor(agent.id)
    return confirmationBlockers({
      root: this.ctx.agents.roots().includes(agent),
      reviewable: this.acceptance(agent.session).reviewable,
      idle: agent.status === 'idle',
      queuedInput: agent.inbox.hasPending,
      approvals: pending.approvals,
      questions: pending.questions,
      runningJobs: this.ctx.jobs.list(agent).some(job => job.ownerSession === agent.id && (job.status === 'running' || job.status === 'stopping')),
    })
  }

  private acceptance(session: Session): WorkAcceptanceProjection {
    const value = this.ctx.sessionProjections.snapshot(session).values.workAcceptance
    if (value === undefined) throw new Error('workResults acceptance projection is unavailable')
    return value
  }

  private contentReviews(session: Session): WorkContentReviewsProjection {
    const value = this.ctx.sessionProjections.snapshot(session).values.workContentReviews
    if (value === undefined) throw new Error('workResults content review projection is unavailable')
    return value
  }


}

export default WorkResultsService
