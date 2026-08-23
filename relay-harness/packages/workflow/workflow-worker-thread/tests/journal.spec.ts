import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkflowRunId } from '@relay-harness/rlh-workflow'
import {
  MAX_WORKFLOW_JOURNAL_BYTES,
  WorkflowJournal,
  workflowJournalExists,
  workflowRequestHash,
} from '../src/journal.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function path(): string {
  const root = mkdtempSync(join(tmpdir(), 'rlh-workflow-journal-'))
  roots.push(root)
  return join(root, 'journal.jsonl')
}

const runId = WorkflowRunId('run-1')
const fingerprint = workflowRequestHash('workflow', { script: 'same', args: { b: 2, a: 1 } })
const request = { prompt: 'inspect', provider: 'p', model: 'm' }
const result = { output: [{ type: 'text' as const, text: 'done' }], stopReason: 'completed' }

describe('WorkflowJournal', () => {
  it('hashes canonical JSON independently of object key insertion order', () => {
    expect(workflowRequestHash('kind', { b: 2, a: [{ z: true, y: null }] }))
      .toBe(workflowRequestHash('kind', { a: [{ y: null, z: true }], b: 2 }))
    expect(workflowRequestHash('other', { a: 1 })).not.toBe(workflowRequestHash('kind', { a: 1 }))
    expect(() => workflowRequestHash('bad', { value: Symbol('x') })).toThrow(/not losslessly JSON/)
  })

  it('creates, appends out-of-order terminal calls, loads, and replays detached outcomes', () => {
    const journalPath = path()
    const journal = WorkflowJournal.create(journalPath, runId, fingerprint)
    expect(workflowJournalExists(journalPath)).toBe(true)
    journal.record(2, { prompt: 'second' }, { kind: 'start-error', rendered: 'no route' })
    journal.record(1, request, { kind: 'settled', childId: 'child-1', result })
    journal.record(3, { prompt: 'third' }, { kind: 'failed', childId: 'child-3', rendered: 'transport' })

    const loaded = WorkflowJournal.load(journalPath, runId, fingerprint)
    const replayed = loaded.replay(1, request)
    expect(replayed).toEqual({ kind: 'settled', childId: 'child-1', result })
    if (replayed?.kind === 'settled') replayed.result.output[0] = { type: 'text', text: 'mutated' }
    expect(loaded.replay(1, request)).toEqual({ kind: 'settled', childId: 'child-1', result })
    expect(loaded.replay(2, { prompt: 'second' })).toEqual({ kind: 'start-error', rendered: 'no route' })
    expect(loaded.replay(3, { prompt: 'third' })).toEqual({ kind: 'failed', childId: 'child-3', rendered: 'transport' })
    expect(loaded.replay(4, { prompt: 'live' })).toBeUndefined()
    expect(() => loaded.replay(1, { prompt: 'changed' })).toThrow(/replay divergence/)
    expect(() => { loaded.record(1, request, { kind: 'start-error', rendered: 'duplicate' }) }).toThrow(/already contains/)
  })

  it('repairs a torn final line but rejects malformed complete rows and divergent headers', () => {
    const torn = path()
    WorkflowJournal.create(torn, runId, fingerprint)
    writeFileSync(torn, '{"type":"call"', { flag: 'a' })
    const repaired = WorkflowJournal.load(torn, runId, fingerprint)
    expect(repaired.replay(1, request)).toBeUndefined()
    expect(readFileSync(torn, 'utf8').endsWith('\n')).toBe(true)

    const malformed = path()
    WorkflowJournal.create(malformed, runId, fingerprint)
    writeFileSync(malformed, 'not-json\n', { flag: 'a' })
    expect(() => WorkflowJournal.load(malformed, runId, fingerprint)).toThrow(/parse failed at line 2/)
    expect(() => WorkflowJournal.load(torn, WorkflowRunId('other'), fingerprint)).toThrow(/header diverges/)
    expect(() => WorkflowJournal.load(torn, runId, 'other-hash')).toThrow(/header diverges/)

    const completeTail = path()
    WorkflowJournal.create(completeTail, runId, fingerprint)
    writeFileSync(completeTail, readFileSync(completeTail, 'utf8').trimEnd())
    WorkflowJournal.load(completeTail, runId, fingerprint)
    expect(readFileSync(completeTail, 'utf8').endsWith('\n')).toBe(true)
  })

  it('rejects unsafe files, malformed records, duplicate sequences, and byte overflow', () => {
    const target = path()
    WorkflowJournal.create(target, runId, fingerprint)
    const link = path()
    symlinkSync(target, link)
    expect(() => WorkflowJournal.load(link, runId, fingerprint)).toThrow(/bounded regular file/)

    const malformed = path()
    writeFileSync(malformed, '{"type":"header"}\n')
    expect(() => WorkflowJournal.load(malformed, runId, fingerprint)).toThrow(/header is malformed/)

    const nonObjectHeader = path()
    writeFileSync(nonObjectHeader, 'null\n')
    expect(() => WorkflowJournal.load(nonObjectHeader, runId, fingerprint)).toThrow(/header must be an object/)

    const header = readFileSync(target, 'utf8')
    const nonObjectEntry = path()
    writeFileSync(nonObjectEntry, `${header}null\n`)
    expect(() => WorkflowJournal.load(nonObjectEntry, runId, fingerprint)).toThrow(/call entry must be an object/)
    const malformedEntry = path()
    writeFileSync(malformedEntry, `${header}{"type":"call"}\n`)
    expect(() => WorkflowJournal.load(malformedEntry, runId, fingerprint)).toThrow(/call entry is malformed/)
    const malformedOutcome = path()
    writeFileSync(malformedOutcome, `${header}${JSON.stringify({
      type: 'call', seq: 1, kind: 'agent', requestHash: 'hash', outcome: { kind: 'settled' },
    })}\n`)
    expect(() => WorkflowJournal.load(malformedOutcome, runId, fingerprint)).toThrow(/call outcome is malformed/)
    const unknownOutcome = path()
    writeFileSync(unknownOutcome, `${header}${JSON.stringify({
      type: 'call', seq: 1, kind: 'agent', requestHash: 'hash', outcome: { kind: 'later' },
    })}\n`)
    expect(() => WorkflowJournal.load(unknownOutcome, runId, fingerprint)).toThrow(/call outcome is malformed/)

    const duplicate = path()
    WorkflowJournal.create(duplicate, runId, fingerprint)
    const entry = JSON.stringify({
      type: 'call', seq: 1, kind: 'agent', requestHash: workflowRequestHash('agent', request),
      outcome: { kind: 'start-error', rendered: 'x' },
    })
    writeFileSync(duplicate, `${entry}\n${entry}\n`, { flag: 'a' })
    expect(() => WorkflowJournal.load(duplicate, runId, fingerprint)).toThrow(/repeats call sequence/)

    const full = WorkflowJournal.create(path(), runId, fingerprint) as unknown as { bytes: number; record: WorkflowJournal['record'] }
    full.bytes = MAX_WORKFLOW_JOURNAL_BYTES
    expect(() => { full.record(1, request, { kind: 'start-error', rendered: 'x' }) }).toThrow(/byte limit/)

    const invalidOutcome = WorkflowJournal.create(path(), runId, fingerprint)
    expect(() => { invalidOutcome.record(1, request, {
      kind: 'start-error', rendered: Symbol('bad'),
    } as never) }).toThrow(/outcome is not JSON data/)

    const appendFailurePath = path()
    const appendFailure = WorkflowJournal.create(appendFailurePath, runId, fingerprint)
    rmSync(appendFailurePath)
    mkdirSync(appendFailurePath)
    expect(() => { appendFailure.record(1, request, { kind: 'start-error', rendered: 'x' }) })
      .toThrow(/append failed/)

    const existing = path()
    WorkflowJournal.create(existing, runId, fingerprint)
    expect(() => WorkflowJournal.create(existing, runId, fingerprint)).toThrow(/create failed/)

    const empty = path()
    writeFileSync(empty, '')
    expect(() => WorkflowJournal.load(empty, runId, fingerprint)).toThrow(/journal is empty/)
    expect(() => WorkflowJournal.load(path(), runId, fingerprint)).toThrow(/load failed/)

    const oversized = path()
    writeFileSync(oversized, '')
    truncateSync(oversized, MAX_WORKFLOW_JOURNAL_BYTES + 1)
    expect(() => WorkflowJournal.load(oversized, runId, fingerprint)).toThrow(/bounded regular file/)
  })
})
