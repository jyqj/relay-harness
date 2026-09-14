/** Main-content navigation; independent of session selection and execution permissions. */
import { createSnapshotStore } from '@relay-harness/rlh-client-runtime/client'
import type { HostObservable } from '@relay-harness/rlh-client-ui-slots'

/** A user-requested page, with a revision for keyboard focus on repeated navigation. */
export interface MainNavigationSnapshot {
  readonly page: string
  readonly revision: number
}

/** Layout-owned observable used by the main content and navigation contributions. */
export class MainNavigation implements HostObservable<MainNavigationSnapshot> {
  private readonly store = createSnapshotStore<MainNavigationSnapshot>({ page: 'conversation', revision: 0 })
  getSnapshot = (): MainNavigationSnapshot => this.store.getSnapshot()
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /** Select a content page without changing the selected Session or its permissions.
   * @param page - Registered shell.page key, or conversation for the resident chat.
   */
  open(page: string): void {
    this.store.set({ page, revision: this.store.getSnapshot().revision + 1 })
  }
}
