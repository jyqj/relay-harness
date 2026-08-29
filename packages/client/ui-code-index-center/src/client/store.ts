import type { ClientContext } from '@relay-harness/rlh-client-runtime/client'
import type { CodeIndexManagementStatus, CodeIndexSearchDebugRequest, CodeIndexSearchDebugResult } from '@relay-harness/rlh-api-remotes/client'
/** Session-scoped Client cache for Code Index Center status. */
export class CodeIndexCenterStore {
  private readonly cached = new Map<string, CodeIndexManagementStatus>()
  constructor(private readonly ctx: ClientContext) {}
  /** Read cached or current management status for one Host-resolved Session workspace.
   * @param sessionId - attached Session selecting the workspace.
   * @param fresh - bypass the scoped cache.
   * @returns current workspace management status.
   */
  async status(sessionId: string, fresh = false): Promise<CodeIndexManagementStatus> {
    const cached = this.cached.get(sessionId)
    if (!fresh && cached !== undefined) return cached
    return this.cache(sessionId, unwrap(await this.ctx.remote.codeIndexCenter.status({ sessionId }), 'status'))
  }
  /** Incrementally refresh one Session workspace.
   * @param sessionId - attached Session selecting the workspace.
   * @returns settled workspace management status.
   */
  async refresh(sessionId: string): Promise<CodeIndexManagementStatus> {
    return this.cache(sessionId, unwrap(await this.ctx.remote.codeIndexCenter.refresh({ sessionId }), 'refresh'))
  }
  /** Reconcile derived generations for one Session workspace.
   * @param sessionId - attached Session selecting the workspace.
   * @returns reconciled workspace management status.
   */
  async reconcile(sessionId: string): Promise<CodeIndexManagementStatus> {
    return this.cache(sessionId, unwrap(await this.ctx.remote.codeIndexCenter.reconcile({ sessionId }), 'reconcile'))
  }
  /** Execute a confirmed destructive rebuild for one Session workspace.
   * @param sessionId - attached Session selecting the workspace.
   * @returns rebuilt workspace management status.
   */
  async rebuild(sessionId: string): Promise<CodeIndexManagementStatus> {
    return this.cache(sessionId, unwrap(await this.ctx.remote.codeIndexCenter.rebuild({ sessionId, confirmation: 'REBUILD' }), 'rebuild'))
  }
  /** Run bounded search diagnostics in one Session workspace.
   * @param request - Session-scoped bounded search request.
   * @returns compact diagnostic search result.
   */
  async search(request: CodeIndexSearchDebugRequest): Promise<CodeIndexSearchDebugResult> {
    return unwrap(await this.ctx.remote.codeIndexCenter.search(request), 'search')
  }
  /** Drop every workspace cache after connection reset. */
  invalidate(): void { this.cached.clear() }
  private cache(sessionId: string, value: CodeIndexManagementStatus): CodeIndexManagementStatus {
    this.cached.set(sessionId, value)
    return value
  }
}
function unwrap<T>(result:{ ok:true;value:T }|{ ok:false;error:{ code:string;message:string } },label:string):T{if(!result.ok)throw new Error(`codeIndexCenter.${label}: ${result.error.code}: ${result.error.message}`);return result.value}
