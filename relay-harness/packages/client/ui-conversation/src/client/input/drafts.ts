/**
 * Discarded-composer-draft registry: tombstones for composer input whose
 * target Session scope was disposed before the user could send it. Live
 * drafts stay in the per-session chat store mirror (stores.ts); this
 * root-scoped registry holds only the discarded leftovers, keyed by Session
 * identity, so a teardown surfaces the unsent input as discarded instead of
 * silently destroying it — and a reopen shows the discarded notice, never
 * live composer text (RFC §5.4 draft lifecycle).
 */
import {
  createSnapshotStore, type ObservableSnapshot, type SessionId, type SnapshotStore,
} from '@relay-harness/rlh-client-runtime/client'

/** One retained draft: the clipboard-projection text and when it was discarded. */
export interface DiscardedDraft {
  readonly text: string
  /** Unix epoch ms of the teardown that discarded the draft. */
  readonly at: number
}

/** localStorage-friendly entries shape (a plain record, keyed by Session id). */
type Entries = Readonly<Record<string, DiscardedDraft>>

const PERSIST_KEY = 'rlh.conversation.drafts.discarded'

/** Retained tombstones are bounded; the oldest `at` drops first. */
const LIMIT = 20

/**
 * Root-scoped registry of discarded composer drafts. One instance per
 * conversation plugin fiber; the persisted record survives reloads so a
 * draft discarded while the page was closed still surfaces on reopen.
 */
export class DiscardedDraftRegistry {
  private readonly store: SnapshotStore<Entries> = createSnapshotStore<Entries>(
    {}, { persist: { name: PERSIST_KEY } },
  )

  /** Read the full tombstone table (inspection face). */
  getSnapshot(): Entries {
    return this.store.getSnapshot()
  }

  /** @param listener - change observer. @returns subscription disposer. */
  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener)
  }

  /**
   * Record a disposed session's unsent draft. Empty text is not user input
   * worth a tombstone, and re-recording an identical text keeps the original
   * discard time.
   * @param sessionId - the disposed Session.
   * @param text - the clipboard projection of the unsent draft.
   */
  discard(sessionId: SessionId, text: string): void {
    if (text === '') return
    const current = this.store.getSnapshot()
    if (current[sessionId]?.text === text) return
    const merged: Record<string, DiscardedDraft> = { ...current, [sessionId]: { text, at: Date.now() } }
    const entries = Object.entries(merged).sort(([, a], [, b]) => a.at - b.at)
    this.store.set(Object.fromEntries(entries.slice(Math.max(0, entries.length - LIMIT))))
  }

  /**
   * Take the tombstone back into the composer (explicit restore): the entry
   * is removed and its text returned for the caller to write through
   * `inputActions.setDraft`.
   * @param sessionId - the Session whose draft to restore.
   * @returns the retained text, or undefined when nothing was retained.
   */
  restore(sessionId: SessionId): string | undefined {
    const current = this.store.getSnapshot()
    const entry = current[sessionId]
    if (entry === undefined) return undefined
    this.store.set(Object.fromEntries(Object.entries(current).filter(([id]) => id !== sessionId)))
    return entry.text
  }

  /**
   * Drop a tombstone for good (explicit discard).
   * @param sessionId - the Session whose retained draft to drop.
   */
  dismiss(sessionId: SessionId): void {
    const current = this.store.getSnapshot()
    if (current[sessionId] === undefined) return
    this.store.set(Object.fromEntries(Object.entries(current).filter(([id]) => id !== sessionId)))
  }

  /**
   * Per-session observable for a slot hooks compartment (one face per call
   * wraps the shared store, so subscribers stay cheap and identity follows
   * the caller's session).
   * @param sessionId - the Session whose tombstone to observe.
   * @returns the observable entry face.
   */
  face(sessionId: SessionId): ObservableSnapshot<DiscardedDraft | undefined> {
    return {
      getSnapshot: () => this.store.getSnapshot()[sessionId],
      subscribe: fn => this.store.subscribe(fn),
    }
  }
}
