/** Accumulates execution-recorded outputs without treating per-page counts as corpus totals. */
import type { WorkLibraryEntry, WorkLibraryPage } from '@relay-harness/rlh-host-work-results/types'

/** Results and observed gaps for one query and its accepted continuation pages. */
export interface LibraryScan {
  readonly entries: readonly WorkLibraryEntry[]
  /** Counts remain local to this page; a Session can be scanned on multiple pages. */
  readonly page: WorkLibraryPage
  readonly hadUnindexedResults: boolean
  readonly hadUnavailableSessions: boolean
}

/**
 * Merge a successfully read page, preserving source identity and earlier gaps.
 * @param previous - earlier pages of the same scan, or null for a new query/restart.
 * @param page - the Host response for the accepted request generation.
 * @returns accumulated outputs and conservative scan coverage, without double-counted totals.
 */
export function mergeLibraryPage(previous: LibraryScan | null, page: WorkLibraryPage): LibraryScan {
  const entries = new Map((previous?.entries ?? []).map(entry => [JSON.stringify([entry.sessionId, entry.path]), entry]))
  for (const entry of page.entries) entries.set(JSON.stringify([entry.sessionId, entry.path]), entry)
  return {
    entries: [...entries.values()],
    page,
    hadUnindexedResults: previous?.hadUnindexedResults === true || page.unindexedResults > 0,
    hadUnavailableSessions: previous?.hadUnavailableSessions === true || page.unavailableSessions > 0,
  }
}
