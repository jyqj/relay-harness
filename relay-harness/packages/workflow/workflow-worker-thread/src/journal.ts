/**
 * Bounded JSONL journal for deterministic workflow host-call replay.
 *
 * @module @relay-harness/rlh-workflow-worker-thread
 */

import { createHash } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { snapshotJsonValue } from '@relay-harness/rlh-session'
import type { JsonValue } from '@relay-harness/rlh-session'
import type { WorkflowRunId } from '@relay-harness/rlh-workflow'
import type { ChildResult, ChildStartRequest } from './types.ts'

/** On-disk journal format version. */
export const WORKFLOW_JOURNAL_VERSION = 1
/** Restore and append cap imported from the Grok workflow journal. */
export const MAX_WORKFLOW_JOURNAL_BYTES = 64 * 1024 * 1024

/** One replayable child-call terminal outcome. */
export type WorkflowJournalOutcome =
  | { readonly kind: 'settled'; readonly childId: string; readonly result: ChildResult }
  | { readonly kind: 'start-error'; readonly rendered: string }
  | { readonly kind: 'failed'; readonly childId: string; readonly rendered: string }

interface WorkflowJournalHeader {
  readonly type: 'header'
  readonly version: typeof WORKFLOW_JOURNAL_VERSION
  readonly runId: WorkflowRunId
  readonly requestHash: string
}

interface WorkflowJournalEntry {
  readonly type: 'call'
  readonly seq: number
  readonly kind: 'agent'
  readonly requestHash: string
  readonly outcome: WorkflowJournalOutcome
}

/** Typed journal load, append, capacity, and replay failure. */
export class WorkflowJournalError extends Error {
  /** Stable machine code for engine mapping and tests. */
  readonly code: 'JOURNAL_INVALID' | 'JOURNAL_DIVERGENCE' | 'JOURNAL_FULL' | 'JOURNAL_IO'

  constructor(
    message: string,
    code: WorkflowJournalError['code'],
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'WorkflowJournalError'
    this.code = code
  }
}

/** Canonicalize object keys recursively while preserving array order. */
function canonicalJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalJson)
  if (typeof value !== 'object' || value === null) return value
  const record = value as Record<string, JsonValue>
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalJson(child)]),
  )
}

/**
 * Stable 128-bit hex request fingerprint over a kind and canonical JSON.
 * @param kind - host-call or header namespace.
 * @param payload - losslessly JSON-serializable request data.
 * @returns 32 lowercase hexadecimal characters.
 */
export function workflowRequestHash(kind: string, payload: unknown): string {
  const snapshot = snapshotJsonValue(payload)
  if (snapshot === undefined) {
    throw new WorkflowJournalError('workflow journal request is not losslessly JSON-serializable', 'JOURNAL_INVALID')
  }
  return createHash('sha256')
    .update(kind)
    .update('\0')
    .update(JSON.stringify(canonicalJson(snapshot as JsonValue)))
    .digest('hex')
    .slice(0, 32)
}

/** Validate a parsed record as a journal header. */
function readHeader(value: unknown): WorkflowJournalHeader {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkflowJournalError('workflow journal header must be an object', 'JOURNAL_INVALID')
  }
  const header = value as Record<string, unknown>
  if (header.type !== 'header' || header.version !== WORKFLOW_JOURNAL_VERSION
    || typeof header.runId !== 'string' || typeof header.requestHash !== 'string') {
    throw new WorkflowJournalError('workflow journal header is malformed or unsupported', 'JOURNAL_INVALID')
  }
  return header as unknown as WorkflowJournalHeader
}

/** Validate a parsed record as one child-call entry. */
function readEntry(value: unknown): WorkflowJournalEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkflowJournalError('workflow journal call entry must be an object', 'JOURNAL_INVALID')
  }
  const entry = value as Record<string, unknown>
  if (entry.type !== 'call' || !Number.isSafeInteger(entry.seq) || (entry.seq as number) < 1
    || entry.kind !== 'agent' || typeof entry.requestHash !== 'string'
    || typeof entry.outcome !== 'object' || entry.outcome === null) {
    throw new WorkflowJournalError('workflow journal call entry is malformed', 'JOURNAL_INVALID')
  }
  const outcome = entry.outcome as Record<string, unknown>
  const valid = outcome.kind === 'start-error'
    ? typeof outcome.rendered === 'string'
    : outcome.kind === 'failed'
      ? typeof outcome.childId === 'string' && typeof outcome.rendered === 'string'
      : outcome.kind === 'settled'
        ? typeof outcome.childId === 'string' && typeof outcome.result === 'object' && outcome.result !== null
        : false
  if (!valid) throw new WorkflowJournalError('workflow journal call outcome is malformed', 'JOURNAL_INVALID')
  return entry as unknown as WorkflowJournalEntry
}

/** One bounded durable workflow journal. */
export class WorkflowJournal {
  private readonly entries = new Map<number, WorkflowJournalEntry>()
  private bytes: number

  private constructor(
    private readonly path: string,
    readonly runId: WorkflowRunId,
    readonly requestHash: string,
    bytes: number,
  ) {
    this.bytes = bytes
  }

  /**
   * Create a new journal exclusively and durably write its header.
   * @param path - absolute journal file path.
   * @param runId - workflow run identity stored in the header.
   * @param requestHash - complete workflow request fingerprint.
   * @returns the empty open journal projection.
   */
  static create(path: string, runId: WorkflowRunId, requestHash: string): WorkflowJournal {
    const header: WorkflowJournalHeader = {
      type: 'header',
      version: WORKFLOW_JOURNAL_VERSION,
      runId,
      requestHash,
    }
    const line = `${JSON.stringify(header)}\n`
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    let fd: number | undefined
    try {
      fd = openSync(path, 'wx', 0o600)
      writeSync(fd, line)
      fsyncSync(fd)
    } catch (error: unknown) {
      throw new WorkflowJournalError(`workflow journal create failed: ${String(error)}`, 'JOURNAL_IO', { cause: error })
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    return new WorkflowJournal(path, runId, requestHash, Buffer.byteLength(line))
  }

  /**
   * Load, validate, and repair only a torn final JSON line.
   * @param path - existing journal file path.
   * @param runId - expected workflow run identity.
   * @param requestHash - expected complete workflow request fingerprint.
   * @returns the validated indexed journal.
   */
  static load(path: string, runId: WorkflowRunId, requestHash: string): WorkflowJournal {
    try {
      const stat = lstatSync(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_WORKFLOW_JOURNAL_BYTES) {
        throw new WorkflowJournalError('workflow journal is not a bounded regular file', 'JOURNAL_INVALID')
      }
      const content = readFileSync(path)
      const newlineTerminated = content.length === 0 || content.at(-1) === 0x0a
      const rows = content.toString('utf8').split('\n')
      if (rows.at(-1) === '') rows.pop()
      if (!newlineTerminated && rows.length > 0) {
        const last = rows.at(-1) as string
        try {
          JSON.parse(last)
          writeFileSync(path, '\n', { flag: 'a' })
        } catch {
          const lastStart = content.lastIndexOf(0x0a) + 1
          truncateSync(path, lastStart)
          rows.pop()
        }
      }
      if (rows.length === 0) throw new WorkflowJournalError('workflow journal is empty', 'JOURNAL_INVALID')
      const header = readHeader(JSON.parse(rows[0] as string))
      if (header.runId !== runId || header.requestHash !== requestHash) {
        throw new WorkflowJournalError('workflow journal header diverges from the requested run', 'JOURNAL_DIVERGENCE')
      }
      const journal = new WorkflowJournal(path, runId, requestHash, lstatSync(path).size)
      for (const [index, row] of rows.slice(1).entries()) {
        let parsed: unknown
        try {
          parsed = JSON.parse(row)
        } catch (error: unknown) {
          throw new WorkflowJournalError(`workflow journal parse failed at line ${index + 2}`, 'JOURNAL_INVALID', { cause: error })
        }
        const entry = readEntry(parsed)
        if (journal.entries.has(entry.seq)) {
          throw new WorkflowJournalError(`workflow journal repeats call sequence ${entry.seq}`, 'JOURNAL_INVALID')
        }
        journal.entries.set(entry.seq, entry)
      }
      return journal
    } catch (error: unknown) {
      if (error instanceof WorkflowJournalError) throw error
      throw new WorkflowJournalError(`workflow journal load failed: ${String(error)}`, 'JOURNAL_IO', { cause: error })
    }
  }

  /**
   * Return a matching recorded outcome, undefined for the first live suffix call.
   * @param seq - deterministic one-based host-call sequence.
   * @param request - child request issued at that sequence.
   * @returns a detached recorded outcome, or undefined when unrecorded.
   */
  replay(seq: number, request: ChildStartRequest): WorkflowJournalOutcome | undefined {
    const entry = this.entries.get(seq)
    if (entry === undefined) return undefined
    const requestHash = workflowRequestHash('agent', request)
    if (entry.requestHash !== requestHash) {
      throw new WorkflowJournalError(
        `workflow replay divergence at call ${seq}: the script issued a different agent() request`,
        'JOURNAL_DIVERGENCE',
      )
    }
    return structuredClone(entry.outcome)
  }

  /**
   * Append one terminal call outcome after validating identity and size.
   * @param seq - deterministic one-based host-call sequence.
   * @param request - child request whose canonical hash is recorded.
   * @param outcome - detached terminal host outcome.
   */
  record(seq: number, request: ChildStartRequest, outcome: WorkflowJournalOutcome): void {
    if (this.entries.has(seq)) {
      throw new WorkflowJournalError(`workflow journal already contains call ${seq}`, 'JOURNAL_INVALID')
    }
    const entry: WorkflowJournalEntry = {
      type: 'call',
      seq,
      kind: 'agent',
      requestHash: workflowRequestHash('agent', request),
      outcome,
    }
    const snapshot = snapshotJsonValue(entry)
    if (snapshot === undefined) throw new WorkflowJournalError('workflow journal outcome is not JSON data', 'JOURNAL_INVALID')
    const line = `${JSON.stringify(snapshot)}\n`
    const bytes = Buffer.byteLength(line)
    if (this.bytes + bytes > MAX_WORKFLOW_JOURNAL_BYTES) {
      throw new WorkflowJournalError('workflow journal byte limit exceeded', 'JOURNAL_FULL')
    }
    let fd: number | undefined
    try {
      fd = openSync(this.path, 'a')
      writeSync(fd, line)
      fsyncSync(fd)
    } catch (error: unknown) {
      throw new WorkflowJournalError(`workflow journal append failed: ${String(error)}`, 'JOURNAL_IO', { cause: error })
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    this.bytes += bytes
    this.entries.set(seq, entry)
  }
}

/**
 * Whether a journal path exists.
 * @param path - journal path to test.
 * @returns true when any directory entry exists at the path.
 */
export function workflowJournalExists(path: string): boolean {
  return existsSync(path)
}
