import type { ClientContext } from '@relay-harness/rlh-client-runtime/client'
import type { CodeIndexManagementStatus, CodeIndexSearchDebugRequest, CodeIndexSearchDebugResult } from '@relay-harness/rlh-api-remotes/client'
/** Session-scoped Client cache for Code Index Center status. */
export class CodeIndexCenterStore {
  private readonly cached = new Map<string, CodeIndexManagementStatus>()
  private readonly pending = new Map<string, object>()
  private readonly maintenance = new Map<string, Set<Promise<void>>>()
  private disposed = false
  constructor(private readonly ctx: ClientContext) {}
  /** Read cached or current status after this Session's pending maintenance settles.
   * @param sessionId - attached Session selecting the workspace.
   * @param fresh - bypass the scoped cache.
   * @returns current workspace management status.
   */
  async status(sessionId: string, fresh = false): Promise<CodeIndexManagementStatus> {
    this.assertActive()
    for (let pending = this.maintenance.get(sessionId); pending !== undefined; pending = this.maintenance.get(sessionId)) {
      await Promise.all(pending)
      this.assertActive()
      fresh = true
    }
    const cached = this.cached.get(sessionId)
    if (!fresh && cached !== undefined) return cached
    return this.request(sessionId, async () => unwrap(await this.ctx.remote.codeIndexCenter.status({ sessionId }), 'status'))
  }
  /** Incrementally refresh one Session workspace.
   * @param sessionId - attached Session selecting the workspace.
   * @returns settled workspace management status.
   */
  async refresh(sessionId: string): Promise<CodeIndexManagementStatus> {
    return this.maintain(sessionId, async () => unwrap(await this.ctx.remote.codeIndexCenter.refresh({ sessionId }), 'refresh'))
  }
  /** Reconcile derived generations for one Session workspace.
   * @param sessionId - attached Session selecting the workspace.
   * @returns reconciled workspace management status.
   */
  async reconcile(sessionId: string): Promise<CodeIndexManagementStatus> {
    return this.maintain(sessionId, async () => unwrap(await this.ctx.remote.codeIndexCenter.reconcile({ sessionId }), 'reconcile'))
  }
  /** Execute a confirmed destructive rebuild for one Session workspace.
   * @param sessionId - attached Session selecting the workspace.
   * @returns rebuilt workspace management status.
   */
  async rebuild(sessionId: string): Promise<CodeIndexManagementStatus> {
    return this.maintain(sessionId, async () => unwrap(await this.ctx.remote.codeIndexCenter.rebuild({ sessionId, confirmation: 'REBUILD' }), 'rebuild'))
  }
  /** Run bounded search diagnostics in one Session workspace.
   * @param request - Session-scoped bounded search request.
   * @returns compact diagnostic search result.
   */
  async search(request: CodeIndexSearchDebugRequest): Promise<CodeIndexSearchDebugResult> {
    this.assertActive()
    return unwrap(await this.ctx.remote.codeIndexCenter.search(request), 'search')
  }
  /** Drop every workspace cache after connection reset. */
  invalidate(): void { this.cached.clear(); this.pending.clear() }
  /** Permanently retire this plugin instance and its cache publication owners. */
  dispose(): void {
    this.disposed = true
    this.invalidate()
  }
  private assertActive(): void {
    if (this.disposed) throw new Error('Code Index Center store disposed')
  }
  private async maintain(sessionId: string, load: () => Promise<CodeIndexManagementStatus>): Promise<CodeIndexManagementStatus> {
    this.assertActive()
    const completion = Promise.withResolvers<void>()
    const pending = this.maintenance.get(sessionId) ?? new Set<Promise<void>>()
    this.maintenance.set(sessionId, pending)
    pending.add(completion.promise)
    try {
      return await this.request(sessionId, load)
    } finally {
      pending.delete(completion.promise)
      if (pending.size === 0) this.maintenance.delete(sessionId)
      completion.resolve()
    }
  }
  private async request(sessionId: string, load: () => Promise<CodeIndexManagementStatus>): Promise<CodeIndexManagementStatus> {
    const owner = {}
    this.pending.set(sessionId, owner)
    try {
      const value = await load()
      if (this.pending.get(sessionId) === owner) this.cached.set(sessionId, value)
      return value
    } finally {
      if (this.pending.get(sessionId) === owner) this.pending.delete(sessionId)
    }
  }
}
function unwrap<T>(result:{ ok:true;value:T }|{ ok:false;error:{ code:string;message:string } },label:string):T{if(!result.ok)throw new Error(`codeIndexCenter.${label}: ${result.error.code}: ${result.error.message}`);return result.value}
