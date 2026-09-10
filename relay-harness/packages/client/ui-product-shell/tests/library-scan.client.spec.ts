import { describe, expect, it } from 'vitest'
import type { WorkLibraryEntry, WorkLibraryPage } from '@relay-harness/rlh-host-work-results/types'
import { mergeLibraryPage } from '../src/client/library-scan.ts'

function page(overrides: Partial<WorkLibraryPage> = {}): WorkLibraryPage {
  return { entries: [], scannedSessions: 1, totalSessions: 2, unindexedResults: 0, unavailableSessions: 0, next: null, ...overrides }
}
function entry(sessionId: string, path: string, cwd = '/work'): WorkLibraryEntry {
  return { sessionId: sessionId as WorkLibraryEntry['sessionId'], path, cwd }
}

describe('Library scan coverage', () => {
  it.each([
    [1, 0, true, false], [0, 1, false, true], [1, 1, true, true], [0, 0, false, false],
  ] as const)('retains earlier gaps after a clean final page (%s, %s)', (unindexedResults, unavailableSessions, unindexed, unavailable) => {
    const first = mergeLibraryPage(null, page({ unindexedResults, unavailableSessions }))
    const lastPage = page()
    const scan = mergeLibraryPage(first, lastPage)
    expect(scan.hadUnindexedResults).toBe(unindexed)
    expect(scan.hadUnavailableSessions).toBe(unavailable)
    expect(scan.page).toBe(lastPage)
    expect(scan.page.scannedSessions).toBe(1)
    expect(scan.page.unindexedResults).toBe(0)
    expect(scan.page.unavailableSessions).toBe(0)
  })

  it('also records gaps first encountered on a continuation page', () => {
    const initial = mergeLibraryPage(null, page())
    const scan = mergeLibraryPage(initial, page({ unindexedResults: 2, unavailableSessions: 1 }))
    expect(scan.hadUnindexedResults).toBe(true)
    expect(scan.hadUnavailableSessions).toBe(true)
    expect(initial.hadUnindexedResults).toBe(false)
    expect(initial.hadUnavailableSessions).toBe(false)
  })

  it('deduplicates by source Session and path without merging identically named outputs from different Sessions', () => {
    const first = entry('a', 'out.txt')
    const other = entry('b', 'out.txt')
    const updated = entry('a', 'out.txt', '/canonical')
    const initial = mergeLibraryPage(null, page({ entries: [first, other] }))
    const scan = mergeLibraryPage(initial, page({ entries: [updated, entry('a', 'second.txt')] }))
    expect(scan.entries).toEqual([updated, other, entry('a', 'second.txt')])
    expect(initial.entries).toEqual([first, other])
  })

  it('resets both results and gaps for an explicit new scan, without accumulating repeated Session scans', () => {
    const older = mergeLibraryPage(null, page({ entries: [entry('a', 'old.txt')], unindexedResults: 2, unavailableSessions: 1 }))
    const fresh = mergeLibraryPage(null, page({ entries: [entry('b', 'new.txt')] }))
    expect(fresh.entries).toEqual([entry('b', 'new.txt')])
    expect(fresh.hadUnindexedResults).toBe(false)
    expect(fresh.hadUnavailableSessions).toBe(false)
    expect(older.hadUnindexedResults).toBe(true)
    const repeated = mergeLibraryPage(fresh, page({ entries: [entry('b', 'new.txt')] }))
    expect(repeated.entries).toHaveLength(1)
    expect(repeated.page.scannedSessions).toBe(1)
  })
})
