/** Typed product URLs. A URL with a Session identity always opens a passive record, never starts work. */
import { createSnapshotStore } from '@relay-harness/rlh-client-runtime/client'
import type { SessionId } from '@relay-harness/rlh-client-runtime/client'

/** Known destinations; record addresses are independent of the active conversation selection. */
export type ProductRoute =
  | { readonly page: 'conversation' | 'work' | 'library' }
  | { readonly page: 'record'; readonly sessionId: SessionId }
  | { readonly page: 'record'; readonly error: 'invalid-route' }

/** Parse a product hash without interpreting paths or activating the referenced Session.
 * @param hash - Browser fragment.
 * @returns A supported route, no product fragment, or an explicit invalid-record state.
 */
export function parseProductRoute(hash: string): ProductRoute | undefined {
  if (hash === '' || hash === '#') return undefined
  if (!hash.startsWith('#relay/')) return undefined
  const path = hash.slice('#relay/'.length)
  if (path === 'conversation' || path === 'work' || path === 'library') return { page: path }
  if (path.startsWith('record/')) {
    try {
      const id = decodeURIComponent(path.slice('record/'.length))
      if (id.length > 0 && id.length <= 1024 && !/[\u0000-\u001f\u007f]/u.test(id)) return { page: 'record', sessionId: id as SessionId }
    } catch { /* A malformed percent encoding is an invalid external URL, not a different Session. */ }
  }
  return { page: 'record', error: 'invalid-route' }
}

/** Encode only view identity; never include drafts, queries, file paths or credentials.
 * @param route - Validated navigation state.
 * @returns Product URL fragment.
 */
export function productRouteHash(route: ProductRoute): string {
  return route.page === 'record'
    ? 'sessionId' in route ? `#relay/record/${encodeURIComponent(route.sessionId)}` : '#relay/invalid'
    : `#relay/${route.page}`
}

/** Observable passive-record selection shared by navigation and the resident record page. */
export class ProductRouteStore {
  private readonly store = createSnapshotStore<ProductRoute>({ page: 'conversation' })
  /** Return the current read-only destination. */
  getSnapshot = (): ProductRoute => this.store.getSnapshot()
  /** Observe destination changes.
   * @param listener - Callback invoked after a new route is committed.
   * @returns Listener disposer.
   */
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)
  /** Commit a validated route without changing execution or conversation state.
   * @param route - New product destination.
   */
  set(route: ProductRoute): void { this.store.set(route) }
}
