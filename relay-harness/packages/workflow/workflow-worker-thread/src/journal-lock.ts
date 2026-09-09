import { loadNodeSqlite } from '@relay-harness/rlh-sqlite-runtime'
/** Process-lifetime SQLite writer claim for one workflow journal. */
import { chmodSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { WorkflowJournalError } from './journal.ts'

/**
 * Exclude other hosts before reading, repairing, or appending a run journal.
 * The SQLite transaction remains held until child quiescence; process death
 * releases the OS lock without stale-pid deletion or an expiring lease.
 * @param journalPath - absolute path of the protected journal.
 * @returns idempotent release for the run's resource owner.
 */
export function claimWorkflowJournal(journalPath: string): () => void {
  const path = `${journalPath}.writer.sqlite`
  let db: DatabaseSync | undefined
  try {
    mkdirSync(dirname(journalPath), { recursive: true, mode: 0o700 })
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (stat !== undefined && (!stat.isFile() || stat.isSymbolicLink())) {
      throw new WorkflowJournalError('workflow writer claim is not a regular file', 'JOURNAL_INVALID')
    }
    db = new (loadNodeSqlite().DatabaseSync)(path)
    chmodSync(path, 0o600)
    db.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')
  } catch (error: unknown) {
    db?.close()
    if (error instanceof WorkflowJournalError) throw error
    const busy = typeof error === 'object' && error !== null
      && 'errcode' in error && (error.errcode === 5 || error.errcode === 6)
    throw new WorkflowJournalError(
      busy ? 'workflow journal is owned by another live run' : 'workflow writer claim failed',
      busy ? 'JOURNAL_BUSY' : 'JOURNAL_IO',
      { cause: error },
    )
  }
  const held = db
  let released = false
  return () => {
    if (released) return
    held.close()
    released = true
  }
}
