import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { afterEach, describe, expect, it } from 'vitest'
import { claimWorkflowJournal } from '../src/journal-lock.ts'

const roots: string[] = []
const releases: (() => void)[] = []
afterEach(() => {
  for (const release of releases.splice(0)) release()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function journalPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'rlh-workflow-claim-'))
  roots.push(root)
  return join(root, 'journal.jsonl')
}

describe('workflow journal writer claim', () => {
  it('refuses a live process owner and recovers its OS lock after process exit', async () => {
    const path = journalPath()
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { DatabaseSync } from 'node:sqlite';
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN EXCLUSIVE');
      process.stdout.write('ready');
      setInterval(() => {}, 1000);
    `, `${path}.writer.sqlite`], { stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    try {
      await Promise.race([
        once(child.stdout, 'data'),
        exited.then(() => { throw new Error('writer exited before acquiring its lock') }),
      ])
      expect(() => claimWorkflowJournal(path)).toThrow(expect.objectContaining({ code: 'JOURNAL_BUSY' }))
    } finally {
      child.kill()
      await exited
    }
    releases.push(claimWorkflowJournal(path))
  })

  it('excludes another SQLite connection until the exact holder releases', () => {
    const path = journalPath()
    const release = claimWorkflowJournal(path)
    releases.push(release)
    expect(() => claimWorkflowJournal(path)).toThrow(expect.objectContaining({ code: 'JOURNAL_BUSY' }))
    release()
    release()
    releases.push(claimWorkflowJournal(path))
  })

  it('refuses a symlink writer database without touching its target', () => {
    const path = journalPath()
    const target = `${path}.target`
    writeFileSync(target, 'untouched')
    symlinkSync(target, `${path}.writer.sqlite`)
    expect(() => { releases.push(claimWorkflowJournal(path)) }).toThrow(expect.objectContaining({ code: 'JOURNAL_INVALID' }))
  })

  it('reports invalid SQLite state without granting a writer', () => {
    const path = journalPath()
    writeFileSync(`${path}.writer.sqlite`, 'not a database'.repeat(100))
    expect(() => claimWorkflowJournal(path)).toThrow(expect.objectContaining({ code: 'JOURNAL_IO' }))
  })
})


it('refuses a dangling writer symlink without creating its target', () => {
  const path = journalPath()
  const target = `${path}.missing-target`
  symlinkSync(target, `${path}.writer.sqlite`)
  expect(() => { releases.push(claimWorkflowJournal(path)) }).toThrow(expect.objectContaining({ code: 'JOURNAL_INVALID' }))
  expect(existsSync(target)).toBe(false)
})

it('normalizes an unusable journal parent into a journal IO error', () => {
  const path = journalPath()
  writeFileSync(path, 'parent is a file')
  expect(() => claimWorkflowJournal(join(path, 'journal.jsonl'))).toThrow(expect.objectContaining({ code: 'JOURNAL_IO' }))
})
