/** Host Remote for Code Index health, lifecycle actions, and bounded search debug. */
import type { Context } from '@relay-harness/cordis'
import type { CodeIndexWorkspace } from '@relay-harness/rlh-code-index'
import { SessionId } from '@relay-harness/rlh-session'
import { Remote, TypertLookupFailure, TypertRemoteService } from '@relay-harness/rlh-typert-protocol'
import type {} from '@relay-harness/rlh-code-index'
import type { CodeIndexManagementStatus, CodeIndexRebuildRequest, CodeIndexSearchDebugRequest, CodeIndexSearchDebugResult, CodeIndexSessionRequest } from './types.ts'
export type * from './types.ts'

const MAX_QUERY_CHARS = 500
const MAX_DEBUG_TOP_K = 20
const MAX_PATHS = 20

/** Remote-only management surface over `ctx.codeIndex`. */
export class CodeIndexCenterGateway extends TypertRemoteService {
  static inject = ['codeIndex', 'sessions']
  constructor(ctx: Context) { super(ctx, 'codeIndexCenter') }

  /** Return current management health.
   * @param request - attached Session selecting the workspace.
   * @returns current bounded management status.
   */
  @Remote('status')
  async status(request: CodeIndexSessionRequest): Promise<CodeIndexManagementStatus> {
    const workspace = await this.workspace(request.sessionId)
    return withWorkspace(workspace.workspaceRoot, await workspace.managementStatus())
  }

  /** Run ordinary incremental refresh.
   * @param request - attached Session selecting the workspace.
   * @returns settled status after refresh.
   */
  @Remote('refresh')
  async refresh(request: CodeIndexSessionRequest): Promise<CodeIndexManagementStatus> {
    const workspace = await this.workspace(request.sessionId)
    await workspace.refresh({ reason: 'manual' })
    return withWorkspace(workspace.workspaceRoot, await workspace.managementStatus())
  }

  /** Reconcile derived generations without reset.
   * @param request - attached Session selecting the workspace.
   * @returns settled status after reconciliation.
   */
  @Remote('reconcile')
  async reconcile(request: CodeIndexSessionRequest): Promise<CodeIndexManagementStatus> {
    const workspace = await this.workspace(request.sessionId)
    return withWorkspace(workspace.workspaceRoot, await workspace.reconcile())
  }

  /** Force a confirmation-gated rebuild.
   * @param request - exact destructive confirmation token.
   * @returns settled status after rebuild.
   */
  @Remote('rebuild')
  async rebuild(request: CodeIndexRebuildRequest): Promise<CodeIndexManagementStatus> {
    if (request.confirmation !== 'REBUILD') throw new Error('codeIndexCenter rebuild requires confirmation token REBUILD')
    const workspace = await this.workspace(request.sessionId)
    await workspace.refresh({ reason: 'manual', forceRebuild: true })
    return withWorkspace(workspace.workspaceRoot, await workspace.managementStatus())
  }

  /** Execute bounded search diagnostics.
   * @param request - bounded query options.
   * @returns compact search diagnostics without hydrated bodies.
   */
  @Remote('search')
  async search(request: CodeIndexSearchDebugRequest): Promise<CodeIndexSearchDebugResult> {
    const query = request.query.trim()
    if (query.length === 0 || Array.from(query).length > MAX_QUERY_CHARS) throw new Error('codeIndexCenter query must contain 1..500 characters')
    const topK = request.topK ?? 10
    if (!Number.isSafeInteger(topK) || topK < 1 || topK > MAX_DEBUG_TOP_K) throw new Error('codeIndexCenter topK must be 1..20')
    if ((request.paths?.length ?? 0) > MAX_PATHS) throw new Error('codeIndexCenter paths must not exceed 20 entries')
    const workspace = await this.workspace(request.sessionId)
    const result = await workspace.search({ query, topK, ...(request.paths === undefined ? {} : { paths: request.paths }) })
    return { result: result as unknown as CodeIndexSearchDebugResult['result'], executedTopK: topK }
  }

  private async workspace(sessionId: string): Promise<CodeIndexWorkspace> {
    const session = this.ctx.sessions.get(SessionId(sessionId))
    if (session === undefined) {
      throw new TypertLookupFailure({
        code: 'session-not-found',
        message: `session "${sessionId}" not found (not attached)`,
        details: { sessionId },
      })
    }
    const cwd = session.header.cwd
    if (cwd === undefined) {
      throw new TypertLookupFailure({
        code: 'workspace-required',
        message: `session "${sessionId}" has no workspace cwd`,
        details: { sessionId },
      })
    }
    return this.ctx.codeIndex.forWorkspace(cwd)
  }
}

function withWorkspace(
  workspaceRoot: string,
  status: Awaited<ReturnType<CodeIndexWorkspace['managementStatus']>>,
): CodeIndexManagementStatus {
  return { workspaceRoot, ...status }
}
export default CodeIndexCenterGateway
