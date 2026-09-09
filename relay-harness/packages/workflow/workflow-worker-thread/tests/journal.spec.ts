import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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
  it('uses the same Unicode request fingerprint across host locales', { timeout: 30_000 }, () => {
    const root = fileURLToPath(new URL('../../../../', import.meta.url))
    const module = new URL('../src/journal.ts', import.meta.url).href
    const code = `import { workflowRequestHash } from ${JSON.stringify(module)};
      process.stdout.write(workflowRequestHash('locale', { I: 1, i: 2, '\u0131': 3, '\u0130': 4 }));`
    const hashes = ['en_US.UTF-8', 'tr_TR.UTF-8'].map((locale) => {
      const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', code], {
        cwd: root,
        env: { PATH: process.env.PATH, TSX_TSCONFIG_PATH: join(root, 'tsconfig.host.json'), LANG: locale, LC_ALL: locale },
        encoding: 'utf8',
        timeout: 10_000,
      })
      expect(result.status, result.stderr).toBe(0)
      return result.stdout
    })
    expect(hashes[0]).toMatch(/^[a-f0-9]{32}$/)
    expect(hashes[1]).toBe(hashes[0])
  })

  it('durably reserves a call before dispatch and refuses to replay its unknown outcome', () => {
    const journalPath = path()
    const journal = WorkflowJournal.create(journalPath, runId, fingerprint)
    journal.begin(1, request)
    const recovered = WorkflowJournal.load(journalPath, runId, fingerprint)
    expect(() => recovered.replay(1, request)).toThrow(expect.objectContaining({
      code: 'JOURNAL_OUTCOME_UNKNOWN',
    }))
    expect(() => recovered.replay(1, { prompt: 'changed' })).toThrow(/divergence/)
    expect(() => { recovered.begin(1, request) }).toThrow(/already contains/)
    expect(() => { journal.record(1, { prompt: 'changed' }, { kind: 'start-error', rendered: 'bad' }) })
      .toThrow(expect.objectContaining({ code: 'JOURNAL_DIVERGENCE' }))
    journal.record(1, request, { kind: 'settled', childId: 'child-1', result })
    expect(WorkflowJournal.load(journalPath, runId, fingerprint).replay(1, request))
      .toEqual({ kind: 'settled', childId: 'child-1', result })
  })

  it('keeps an unresolved intent when a terminal outcome is torn during a crash', () => {
    const journalPath = path()
    const journal = WorkflowJournal.create(journalPath, runId, fingerprint)
    journal.begin(1, request)
    writeFileSync(journalPath, '{"type":"call"', { flag: 'a' })
    const recovered = WorkflowJournal.load(journalPath, runId, fingerprint)
    expect(() => recovered.replay(1, request)).toThrow(expect.objectContaining({
      code: 'JOURNAL_OUTCOME_UNKNOWN',
    }))
  })

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
    WorkflowJournal.create(duplicate, runId, fingerprint).begin(1, request)
    const entry = JSON.stringify({
      type: 'call', seq: 1, kind: 'agent', requestHash: workflowRequestHash('agent', request),
      outcome: { kind: 'start-error', rendered: 'x' },
    })
    writeFileSync(duplicate, `${entry}\n${entry}\n`, { flag: 'a' })
    expect(() => WorkflowJournal.load(duplicate, runId, fingerprint)).toThrow(/repeats call sequence/)

    const missingIntent = path()
    WorkflowJournal.create(missingIntent, runId, fingerprint)
    writeFileSync(missingIntent, `${entry}\n`, { flag: 'a' })
    expect(() => WorkflowJournal.load(missingIntent, runId, fingerprint)).toThrow(/lacks matching intent/)

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

describe('journal recovery validation before mutation', () => {
  it.each(['{"type":"call"', ' '])('does not repair a journal belonging to a divergent request (tail %s)', (tail) => {
    const journalPath = path()
    WorkflowJournal.create(journalPath, runId, fingerprint)
    writeFileSync(journalPath, tail, { flag: 'a' })
    const before = readFileSync(journalPath)
    expect(() => WorkflowJournal.load(journalPath, WorkflowRunId('wrong-run'), fingerprint)).toThrow()
    expect(readFileSync(journalPath)).toEqual(before)
  })

  it.each([[], {}, { stopReason: 'completed', output: null }, { stopReason: 'completed', output: [null] },
    { stopReason: 'completed', output: [{ type: 'text', text: 7 }] }, { stopReason: 1, output: [] },
  ])('rejects malformed durable child result %# before replay', (malformed) => {
    const journalPath = path()
    WorkflowJournal.create(journalPath, runId, fingerprint).begin(1, request)
    writeFileSync(journalPath, JSON.stringify({
      type: 'call', seq: 1, kind: 'agent', requestHash: workflowRequestHash('agent', request),
      outcome: { kind: 'settled', childId: 'child', result: malformed },
    }) + '\n', { flag: 'a' })
    expect(() => WorkflowJournal.load(journalPath, runId, fingerprint)).toThrow(expect.objectContaining({ code: 'JOURNAL_INVALID' }))
  })

  it('rejects a non-finite value parsed from durable JSON instead of returning it to the script', () => {
    const journalPath = path()
    WorkflowJournal.create(journalPath, runId, fingerprint).begin(1, request)
    const line = JSON.stringify({
      type: 'call', seq: 1, kind: 'agent', requestHash: workflowRequestHash('agent', request),
      outcome: { kind: 'settled', childId: 'child', result: { ...result, structured: 'NONFINITE' } },
    }).replace('"NONFINITE"', '1e999')
    writeFileSync(journalPath, `${line}\n`, { flag: 'a' })
    expect(() => WorkflowJournal.load(journalPath, runId, fingerprint)).toThrow(expect.objectContaining({ code: 'JOURNAL_INVALID' }))
  })

  it('refuses a missing earlier call instead of treating it as a live suffix', () => {
    const journalPath = path()
    const journal = WorkflowJournal.create(journalPath, runId, fingerprint)
    journal.begin(2, request)
    expect(() => journal.replay(1, request)).toThrow(expect.objectContaining({ code: 'JOURNAL_INVALID' }))
    expect(() => WorkflowJournal.load(journalPath, runId, fingerprint)).toThrow(expect.objectContaining({ code: 'JOURNAL_INVALID' }))
  })
})

it('refuses a newline repair that would exceed the complete journal byte bound', () => {
  const journalPath = path()
  WorkflowJournal.create(journalPath, runId, fingerprint)
  const header = readFileSync(journalPath, 'utf8').trimEnd()
  writeFileSync(journalPath, header + ' '.repeat(MAX_WORKFLOW_JOURNAL_BYTES - Buffer.byteLength(header)))
  expect(() => WorkflowJournal.load(journalPath, runId, fingerprint)).toThrow(expect.objectContaining({ code: 'JOURNAL_FULL' }))
  const retained = readFileSync(journalPath)
  expect(retained.length).toBe(MAX_WORKFLOW_JOURNAL_BYTES)
  expect(retained.at(-1)).toBe(0x20)
})
