/** Small Client cache over the generated memoryCenter Remote. */
import type {
  MemoryCenterDetail,
  MemoryCenterListRequest,
  MemoryCenterSnapshot,
} from '@relay-harness/rlh-api-remotes/client'
import type { ClientContext } from '@relay-harness/rlh-client-runtime/client'

/** Per-key request ownership prevents an older reply from replacing a newer read. */
class ReadCache<T> {
  private readonly values = new Map<string, T>()
  private readonly pending = new Map<string, object>()

  async read(key: string, fresh: boolean, load: () => Promise<T>): Promise<T> {
    if (!fresh) {
      const cached = this.values.get(key)
      if (cached !== undefined) return cached
    }
    const owner = {}
    this.pending.set(key, owner)
    try {
      const value = await load()
      if (this.pending.get(key) === owner) this.values.set(key, value)
      return value
    } finally {
      if (this.pending.get(key) === owner) this.pending.delete(key)
    }
  }

  clear(): void {
    this.values.clear()
    this.pending.clear()
  }
}

/** Exact-request cache for Memory Center list/search pages and details. */
export class MemoryCenterStore {
  private readonly pages = new ReadCache<MemoryCenterSnapshot>()
  private readonly details = new ReadCache<MemoryCenterDetail>()

  constructor(private readonly ctx: ClientContext) {}

  /**
   * Read one cached or fresh scoped page.
   * @param request - exact scope, filters, and page window.
   * @param fresh - bypass the page cache.
   * @returns the matching snapshot.
   */
  async list(request: MemoryCenterListRequest, fresh = false): Promise<MemoryCenterSnapshot> {
    return this.pages.read(JSON.stringify(request), fresh, async () => {
      const result = request.query === undefined
        ? await this.ctx.remote.memoryCenter.list(request)
        : await this.ctx.remote.memoryCenter.search({ ...request, query: request.query })
      return unwrap(result, request.query === undefined ? 'memoryCenter.list' : 'memoryCenter.search')
    })
  }

  /**
   * Read one cached or fresh scoped detail.
   * @param request - exact scope and memory identity.
   * @param fresh - bypass the detail cache.
   * @returns the governed detail.
   */
  async read(request: { workspaceId: string; sessionId: string; id: string }, fresh = false): Promise<MemoryCenterDetail> {
    return this.details.read(detailKey(request.workspaceId, request.sessionId, request.id), fresh, async () => (
      unwrap(await this.ctx.remote.memoryCenter.read(request), 'memoryCenter.read')
    ))
  }

  /**
   * Approve and invalidate all cached governance reads.
   * @param sessionId - attached evidence session.
   * @param id - memory identity.
   * @param expectedRevision - revision displayed when approval was requested.
   * @returns the approved detail.
   */
  async approve(sessionId: string, id: string, expectedRevision: number): Promise<MemoryCenterDetail> {
    const detail = unwrap(await this.ctx.remote.memoryCenter.approve({ sessionId, id, expectedRevision }), 'memoryCenter.approve')
    this.invalidate()
    return detail
  }

  /**
   * Reject and invalidate all cached governance reads.
   * @param sessionId - attached evidence session.
   * @param id - memory identity.
   * @param expectedRevision - revision displayed when rejection was requested.
   * @param reason - auditable rejection reason.
   * @returns the tombstoned detail.
   */
  async reject(sessionId: string, id: string, expectedRevision: number, reason: string): Promise<MemoryCenterDetail> {
    const detail = unwrap(await this.ctx.remote.memoryCenter.reject({ sessionId, id, expectedRevision, reason }), 'memoryCenter.reject')
    this.invalidate()
    return detail
  }

  /**
   * Revise and invalidate all cached governance reads.
   * @param sessionId - attached evidence session.
   * @param id - memory identity.
   * @param expectedRevision - revision displayed when editing began.
   * @param input - user-authored replacement fields.
   * @returns the revised detail.
   */
  async revise(sessionId: string, id: string, expectedRevision: number, input: {
    content: string
    summary: string | null
    importance: number
    confidence: number
    validUntil: number | null
  }): Promise<MemoryCenterDetail> {
    const detail = unwrap(await this.ctx.remote.memoryCenter.revise({ sessionId, id, expectedRevision, ...input }), 'memoryCenter.revise')
    this.invalidate()
    return detail
  }

  /**
   * Tombstone and invalidate all cached governance reads.
   * @param sessionId - attached evidence session.
   * @param id - memory identity.
   * @param expectedRevision - revision displayed when deletion was requested.
   * @param reason - auditable deletion reason.
   * @returns the tombstoned detail.
   */
  async tombstone(sessionId: string, id: string, expectedRevision: number, reason: string): Promise<MemoryCenterDetail> {
    const detail = unwrap(await this.ctx.remote.memoryCenter.delete({ sessionId, id, expectedRevision, reason }), 'memoryCenter.delete')
    this.invalidate()
    return detail
  }

  /** Drop every page and detail after connection or provider state changes. */
  invalidate(): void {
    this.pages.clear()
    this.details.clear()
  }
}

function detailKey(workspaceId: string, sessionId: string, id: string): string {
  return `${workspaceId}\u0000${sessionId}\u0000${id}`
}

function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }, label: string): T {
  if (!result.ok) throw new Error(`${label} failed: ${result.error.code}: ${result.error.message}`)
  return result.value
}
