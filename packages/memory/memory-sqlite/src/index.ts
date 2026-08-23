/**
 * Local SQLite provider for the long-term-memory capability.
 *
 * @module @deepseek-ai/dsh-memory-sqlite
 */

import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import LongTermMemory, {
  MemoryExtractionJobId,
  MemoryExtractionQueue,
  MemoryId,
  MemoryTurnHandle,
  memoryContainsSecret,
} from '@deepseek-ai/dsh-memory'
import type {
  AbortMemoryTurnInput,
  CommitMemoryTurnInput,
  CompleteMemoryExtractionInput,
  ClaimMemoryExtractionInput,
  EnqueueMemoryExtractionInput,
  FailMemoryExtractionInput,
  ForgetMemoryInput,
  MemoryEntry,
  MemoryEvidence,
  MemoryExtractionJob,
  MemoryExtractionJobId as MemoryExtractionJobIdType,
  MemoryId as MemoryIdType,
  MemoryKind,
  MemoryScope,
  MemorySearchHit,
  MemoryStatus,
  MemoryTrust,
  MemoryTurnHandle as MemoryTurnHandleType,
  PrepareMemoryTurnInput,
  PreparedMemoryTurn,
  RememberMemoryInput,
  ReviseMemoryInput,
  SearchMemoryInput,
} from '@deepseek-ai/dsh-memory/types'
import { memoryContentHash, openMemoryDatabase, type JournalMode } from './schema.ts'
import {
  claimMemoryStoreOwnership,
  currentMemoryStoreOwner,
  refreshMemoryStoreOwner,
  releaseMemoryStoreOwnership,
  type MemoryStoreOwner,
} from './schema.ts'

export {
  MEMORY_SQLITE_APPLICATION_ID,
  MEMORY_SQLITE_SCHEMA_VERSION,
  type JournalMode,
} from './schema.ts'

const MEMORY_KINDS = ['preference', 'fact', 'constraint', 'decision', 'procedure', 'lesson'] as const
const MEMORY_STATUSES = ['candidate', 'active', 'disputed', 'superseded', 'tombstoned'] as const
const MEMORY_TRUST = ['user-stated', 'action-verified', 'agent-proposed', 'external'] as const
const MAX_SEARCH_LIMIT = 50
const DEFAULT_MAX_CONTENT_CHARS = 8_000
const DEFAULT_MAX_SUMMARY_CHARS = 500
const MAX_EVIDENCE_EXCERPT_CHARS = 4_096
const DEFAULT_OWNER_STALE_MS = 30_000

/** SQLite provider configuration. */
export interface Config {
  /** Canonical memory database path; `:memory:` is supported for tests. */
  path: string
  /** SQLite journal mode. Defaults to `wal`. */
  journalMode?: JournalMode
  /** Largest accepted search result cap. Defaults to 50. */
  maxSearchLimit?: number
  /** Largest accepted memory content in Unicode code points. Defaults to 8000. */
  maxContentChars?: number
  /** Largest accepted summary in Unicode code points. Defaults to 500. */
  maxSummaryChars?: number
  /** Age at which another process's ownership heartbeat is considered dead. Defaults to 30000. */
  ownerStaleMs?: number
}

interface ResolvedConfig {
  path: string
  journalMode: JournalMode
  maxSearchLimit: number
  maxContentChars: number
  maxSummaryChars: number
  ownerStaleMs: number
}

interface SearchRow {
  memory_id: string
  entry_json: string
  rank: number
}

interface TurnRow {
  handle: string
  workspace_id: string
  user_id: string
  agent_id: string
  session_id: string
  turn: number
  query: string
  candidates_json: string
  recalled_ids_json: string
  status: 'prepared' | 'committed' | 'aborted'
  reason: string | null
}

interface ExtractionJobRow {
  id: string
  payload_json: string
  status: MemoryExtractionJob['status']
  attempts: number
  max_attempts: number
  available_at: number
  lease_owner: string | null
  lease_until: number | null
  last_error: string | null
  result_json: string | null
  created_at: number
  updated_at: number
}

interface ExtractionQueueOperations {
  enqueue(input: EnqueueMemoryExtractionInput): Promise<MemoryExtractionJob>
  claim(input: ClaimMemoryExtractionInput): Promise<MemoryExtractionJob | undefined>
  complete(input: CompleteMemoryExtractionInput): Promise<MemoryExtractionJob>
  fail(input: FailMemoryExtractionInput): Promise<MemoryExtractionJob>
  read(id: MemoryExtractionJobIdType): Promise<MemoryExtractionJob | undefined>
}

class SqliteMemoryExtractionQueue extends MemoryExtractionQueue {
  constructor(ctx: Context, private readonly operations: ExtractionQueueOperations) {
    super(ctx)
  }

  override enqueue(input: EnqueueMemoryExtractionInput): Promise<MemoryExtractionJob> {
    return this.operations.enqueue(input)
  }

  override claim(input: ClaimMemoryExtractionInput): Promise<MemoryExtractionJob | undefined> {
    return this.operations.claim(input)
  }

  override complete(input: CompleteMemoryExtractionInput): Promise<MemoryExtractionJob> {
    return this.operations.complete(input)
  }

  override fail(input: FailMemoryExtractionInput): Promise<MemoryExtractionJob> {
    return this.operations.fail(input)
  }

  override read(id: MemoryExtractionJobIdType): Promise<MemoryExtractionJob | undefined> {
    return this.operations.read(id)
  }
}

/** Canonical local provider with append-only revisions and rebuildable FTS indexes. */
export class SqliteLongTermMemory extends LongTermMemory {
  static Config: z<Config> = z.object({
    path: z.string().required(),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    maxSearchLimit: z.number().step(1).min(1).max(MAX_SEARCH_LIMIT).default(MAX_SEARCH_LIMIT),
    maxContentChars: z.number().step(1).min(1).default(DEFAULT_MAX_CONTENT_CHARS),
    maxSummaryChars: z.number().step(1).min(1).default(DEFAULT_MAX_SUMMARY_CHARS),
    ownerStaleMs: z.number().step(1).min(1_000).default(DEFAULT_OWNER_STALE_MS),
  })

  /** Validated and defaulted canonical-store configuration. */
  readonly config: ResolvedConfig
  private db: DatabaseSync | undefined
  private closed = false
  private readonly owner: MemoryStoreOwner = currentMemoryStoreOwner()

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = resolveConfig(config)
    new SqliteMemoryExtractionQueue(ctx, {
      enqueue: input => this.enqueueExtraction(input),
      claim: input => this.claimExtraction(input),
      complete: input => this.completeExtraction(input),
      fail: input => this.failExtraction(input),
      read: id => this.readExtraction(id),
    })
    ctx.effect(() => async () => this.close(), 'memorySqlite.close')
  }

  protected async [Service.init](): Promise<void> {
    this.db = await openMemoryDatabase(this.config.path, this.config.journalMode)
    try {
      claimMemoryStoreOwnership(this.db, this.owner, this.config.ownerStaleMs, this.config.path)
    } catch (error: unknown) {
      this.db.close()
      this.db = undefined
      throw error
    }
  }

  override prepare(input: PrepareMemoryTurnInput, signal: AbortSignal): Promise<PreparedMemoryTurn> {
    assertScope(input.scope)
    assertPositiveSafeInteger('turn', input.turn)
    assertPositiveSafeInteger('candidateLimit', input.candidateLimit)
    const query = requireText('query', input.query)
    signal.throwIfAborted()
    const handle = MemoryTurnHandle(turnHandle(input))
    const existing = this.requireDb().prepare(
      'SELECT * FROM memory_turns WHERE handle = ?',
    ).get(handle) as TurnRow | undefined
    if (existing !== undefined) return Promise.resolve(restorePrepared(existing, input))
    const candidates = this.searchCurrent({
      scope: input.scope,
      query,
      limit: Math.min(input.candidateLimit, this.config.maxSearchLimit),
      statuses: ['active'],
    })
    const now = Date.now()
    this.requireDb().prepare(`
      INSERT INTO memory_turns (
        handle, workspace_id, user_id, agent_id, session_id, turn, query,
        candidates_json, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?)
    `).run(
      handle,
      input.scope.workspaceId,
      input.scope.userId,
      input.scope.agentId,
      input.sessionId,
      input.turn,
      query,
      JSON.stringify(candidates),
      now,
      now,
    )
    for (const candidate of candidates) {
      this.recordSignal(candidate.entry.id, 'candidate_hit', input.sessionId, input.turn)
    }
    return Promise.resolve({
      handle,
      scope: snapshotScope(input.scope),
      sessionId: input.sessionId,
      turn: input.turn,
      query,
      candidates,
    })
  }

  override commit(input: CommitMemoryTurnInput): Promise<void> {
    const db = this.requireDb()
    const row = requireTurn(db, input.prepared.handle)
    const recalled = uniqueIds(input.recalledMemoryIds)
    if (row.status === 'aborted') throw new Error(`memory turn ${row.handle} is already aborted`)
    if (row.status === 'committed') {
      if (row.recalled_ids_json !== JSON.stringify(recalled)) {
        throw new Error(`memory turn ${row.handle} was committed with different recalled memories`)
      }
      return Promise.resolve()
    }
    const candidateIds = new Set(input.prepared.candidates.map(candidate => candidate.entry.id))
    for (const id of recalled) {
      if (!candidateIds.has(id)) throw new Error(`memory turn ${row.handle} cannot commit unprepared memory ${id}`)
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(`
        UPDATE memory_turns
        SET status = 'committed', recalled_ids_json = ?, updated_at = ?
        WHERE handle = ? AND status = 'prepared'
      `).run(JSON.stringify(recalled), Date.now(), row.handle)
      for (const id of recalled) {
        db.prepare(`
          UPDATE memory_entries
          SET access_count = access_count + 1,
              entry_json = json_set(entry_json, '$.accessCount', access_count + 1)
          WHERE memory_id = ?
        `).run(id)
        this.recordSignal(id, 'injected', input.prepared.sessionId, input.prepared.turn)
      }
      this.refreshOwner(db)
      db.exec('COMMIT')
    } catch (error: unknown) {
      db.exec('ROLLBACK')
      throw error
    }
    return Promise.resolve()
  }

  override abort(input: AbortMemoryTurnInput): Promise<void> {
    const row = requireTurn(this.requireDb(), input.prepared.handle)
    if (row.status === 'committed') throw new Error(`memory turn ${row.handle} is already committed`)
    if (row.status === 'aborted') return Promise.resolve()
    this.requireDb().prepare(`
      UPDATE memory_turns SET status = 'aborted', reason = ?, updated_at = ?
      WHERE handle = ? AND status = 'prepared'
    `).run(requireText('reason', input.reason), Date.now(), row.handle)
    return Promise.resolve()
  }

  override remember(input: RememberMemoryInput, signal?: AbortSignal): Promise<MemoryEntry> {
    signal?.throwIfAborted()
    validateRemember(input, this.config)
    const existing = this.findExact(input.scope, input.kind, input.content, ['candidate', 'active', 'disputed'])
    if (existing !== undefined) {
      if (input.status === 'active' && existing.status !== 'active') {
        return this.revise({
          scope: input.scope,
          id: existing.id,
          status: 'active',
          trust: input.trust,
          confidence: Math.max(existing.confidence, input.confidence),
          importance: Math.max(existing.importance, input.importance),
          evidence: input.evidence,
        }, signal)
      }
      return Promise.resolve(existing)
    }
    const superseded = this.findExact(input.scope, input.kind, input.content, ['superseded', 'tombstoned'])
    const now = Date.now()
    const entry: MemoryEntry = {
      id: MemoryId(randomUUID()),
      revision: 1,
      scope: snapshotScope(input.scope),
      kind: input.kind,
      status: input.status,
      trust: input.trust,
      content: input.content.trim(),
      ...input.summary === undefined ? {} : { summary: input.summary.trim() },
      importance: input.importance,
      confidence: input.confidence,
      createdAt: now,
      updatedAt: now,
      ...input.validUntil === undefined ? {} : { validUntil: input.validUntil },
      ...superseded === undefined ? {} : { supersedes: superseded.id },
      evidence: snapshotEvidence(input.evidence),
      accessCount: 0,
      usefulAccessCount: 0,
    }
    if (superseded === undefined) {
      this.writeEntry(entry)
      return Promise.resolve(snapshotEntry(entry))
    }
    this.writeEntry(entry, {
      ...superseded,
      revision: superseded.revision + 1,
      status: 'superseded',
      supersededBy: entry.id,
      updatedAt: now,
    })
    return Promise.resolve(snapshotEntry(entry))
  }

  override revise(input: ReviseMemoryInput, signal?: AbortSignal): Promise<MemoryEntry> {
    signal?.throwIfAborted()
    assertScope(input.scope)
    validateEvidence(input.evidence)
    const current = this.requireEntry(input.scope, input.id)
    if (current.status === 'tombstoned') throw new Error(`memory ${input.id} is tombstoned`)
    const content = input.content?.trim() ?? current.content
    const trust = input.trust ?? current.trust
    const status = input.status ?? current.status
    const next: MemoryEntry = {
      ...current,
      revision: current.revision + 1,
      content: requireText('content', content),
      ...resolveOptionalText(current, input.summary),
      importance: input.importance ?? current.importance,
      confidence: input.confidence ?? current.confidence,
      trust,
      status,
      updatedAt: Date.now(),
      ...resolveValidUntil(current, input.validUntil),
      evidence: snapshotEvidence([...current.evidence, ...input.evidence]),
    }
    validateEntry(next, this.config)
    this.writeEntry(next)
    return Promise.resolve(snapshotEntry(next))
  }

  override forget(input: ForgetMemoryInput, signal?: AbortSignal): Promise<MemoryEntry> {
    signal?.throwIfAborted()
    assertScope(input.scope)
    requireText('reason', input.reason)
    validateEvidence(input.evidence)
    const current = this.requireEntry(input.scope, input.id)
    if (current.status === 'tombstoned') return Promise.resolve(current)
    const next: MemoryEntry = {
      ...current,
      revision: current.revision + 1,
      status: 'tombstoned',
      tombstoneReason: input.reason.trim(),
      updatedAt: Date.now(),
      evidence: snapshotEvidence([...current.evidence, ...input.evidence]),
    }
    this.writeEntry(next)
    return Promise.resolve(snapshotEntry(next))
  }

  override read(scope: MemoryScope, id: MemoryIdType, signal?: AbortSignal): Promise<MemoryEntry | undefined> {
    signal?.throwIfAborted()
    assertScope(scope)
    const row = this.requireDb().prepare(`
      SELECT entry_json FROM memory_entries
      WHERE memory_id = ? AND workspace_id = ? AND user_id = ? AND agent_id = ?
    `).get(id, scope.workspaceId, scope.userId, scope.agentId) as { entry_json: string } | undefined
    return Promise.resolve(row === undefined ? undefined : parseEntry(row.entry_json))
  }

  override search(input: SearchMemoryInput, signal?: AbortSignal): Promise<readonly MemorySearchHit[]> {
    signal?.throwIfAborted()
    assertScope(input.scope)
    const query = requireText('query', input.query)
    const limit = input.limit
    assertPositiveSafeInteger('limit', limit)
    if (limit > this.config.maxSearchLimit) {
      throw new Error(`memory search limit must not exceed ${this.config.maxSearchLimit}`)
    }
    assertKinds(input.kinds)
    assertStatuses(input.statuses)
    return Promise.resolve(this.searchCurrent({ ...input, query, limit }))
  }

  /** Close the canonical store after Cordis removes consumers. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    if (this.db !== undefined) {
      try {
        releaseMemoryStoreOwnership(this.db, this.owner)
      } catch {
        // Ownership release is best-effort; heartbeat staleness bounds any leftover claim.
      }
      this.db.close()
      this.db = undefined
    }
    return Promise.resolve()
  }

  private searchCurrent(input: SearchMemoryInput): MemorySearchHit[] {
    const statuses = input.statuses ?? ['active']
    const channels: Array<{ name: string; rows: SearchRow[] }> = []
    const unicodeQuery = unicodeFtsQuery(input.query)
    if (unicodeQuery !== '') {
      channels.push({ name: 'fts_unicode', rows: this.queryChannel('memory_fts_unicode', unicodeQuery, input) })
    }
    if (Array.from(input.query.trim()).length >= 3) {
      channels.push({ name: 'fts_trigram', rows: this.queryChannel('memory_fts_trigram', quotedFts(input.query.trim()), input) })
    }
    const scores = new Map<string, number>()
    const matchedBy = new Map<string, string[]>()
    const entries = new Map<string, MemoryEntry>()
    for (const channel of channels) {
      channel.rows.forEach((row, index) => {
        scores.set(row.memory_id, (scores.get(row.memory_id) ?? 0) + 1 / (60 + index + 1))
        matchedBy.set(row.memory_id, [...matchedBy.get(row.memory_id) ?? [], channel.name])
        entries.set(row.memory_id, parseEntry(row.entry_json))
      })
    }
    const max = Math.max(0, ...scores.values())
    const hits = [...scores.entries()]
      .map(([id, fused]): MemorySearchHit => {
        const entry = entries.get(id) as MemoryEntry
        const relevance = max === 0 ? 0 : fused / max
        return {
          entry,
          score: Math.min(1, relevance * 0.8 + entry.importance / 4 * 0.15 + trustWeight(entry.trust) * 0.05),
          matchedBy: matchedBy.get(id) ?? [],
        }
      })
      .filter(hit => statuses.includes(hit.entry.status))
      .sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt || a.entry.id.localeCompare(b.entry.id))
      .slice(0, input.limit)
    this.countUsefulAccesses(hits)
    return hits
  }

  private countUsefulAccesses(hits: readonly MemorySearchHit[]): void {
    if (hits.length === 0) return
    const db = this.requireDb()
    try {
      db.exec('BEGIN IMMEDIATE')
      const update = db.prepare(`
        UPDATE memory_entries
        SET useful_access_count = useful_access_count + 1,
            entry_json = json_set(entry_json, '$.usefulAccessCount', useful_access_count + 1)
        WHERE memory_id = ?
      `)
      for (const hit of hits) update.run(hit.entry.id)
      db.exec('COMMIT')
    } catch {
      // Search and recall stay available when access accounting cannot commit;
      // the read path fails open by contract.
      try {
        db.exec('ROLLBACK')
      } catch {
        // The connection itself failed; SQLite owns that diagnosis.
      }
    }
  }

  private queryChannel(table: 'memory_fts_unicode' | 'memory_fts_trigram', query: string, input: SearchMemoryInput): SearchRow[] {
    const where = [
      `${table} MATCH ?`,
      'e.workspace_id = ?',
      'e.user_id = ?',
      'e.agent_id = ?',
      '(e.valid_until IS NULL OR e.valid_until > ?)',
    ]
    const params: Array<string | number> = [
      query,
      input.scope.workspaceId,
      input.scope.userId,
      input.scope.agentId,
      Date.now(),
    ]
    addListFilter(where, params, 'e.kind', input.kinds)
    addListFilter(where, params, 'e.status', input.statuses ?? ['active'])
    params.push(Math.min(this.config.maxSearchLimit, Math.max(input.limit * 3, input.limit)))
    return this.requireDb().prepare(`
      SELECT e.memory_id, e.entry_json, bm25(${table}) AS rank
      FROM ${table}
      JOIN memory_entries e ON e.memory_id = ${table}.memory_id
      WHERE ${where.join(' AND ')}
      ORDER BY rank ASC, e.updated_at DESC, e.memory_id ASC
      LIMIT ?
    `).all(...params) as unknown as SearchRow[]
  }

  private requireEntry(scope: MemoryScope, id: MemoryIdType): MemoryEntry {
    const row = this.requireDb().prepare(`
      SELECT entry_json FROM memory_entries
      WHERE memory_id = ? AND workspace_id = ? AND user_id = ? AND agent_id = ?
    `).get(id, scope.workspaceId, scope.userId, scope.agentId) as { entry_json: string } | undefined
    if (row === undefined) throw new Error(`memory ${id} was not found in the requested scope`)
    return parseEntry(row.entry_json)
  }

  private writeEntry(...entries: MemoryEntry[]): void {
    for (const entry of entries) validateEntry(entry, this.config)
    const db = this.requireDb()
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const entry of entries) {
        const json = JSON.stringify(entry)
        db.prepare(`
          INSERT INTO memory_revisions (
            memory_id, revision, workspace_id, user_id, agent_id, entry_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          entry.id,
          entry.revision,
          entry.scope.workspaceId,
          entry.scope.userId,
          entry.scope.agentId,
          json,
          entry.updatedAt,
        )
        db.prepare(`
          INSERT INTO memory_entries (
            memory_id, revision, workspace_id, user_id, agent_id, kind, status, trust, content_hash,
            importance, confidence, valid_until, updated_at, access_count,
            useful_access_count, entry_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(memory_id) DO UPDATE SET
            revision = excluded.revision,
            workspace_id = excluded.workspace_id,
            user_id = excluded.user_id,
            agent_id = excluded.agent_id,
            kind = excluded.kind,
            status = excluded.status,
            trust = excluded.trust,
            content_hash = excluded.content_hash,
            importance = excluded.importance,
            confidence = excluded.confidence,
            valid_until = excluded.valid_until,
            updated_at = excluded.updated_at,
            access_count = excluded.access_count,
            useful_access_count = excluded.useful_access_count,
            entry_json = excluded.entry_json
        `).run(
          entry.id,
          entry.revision,
          entry.scope.workspaceId,
          entry.scope.userId,
          entry.scope.agentId,
          entry.kind,
          entry.status,
          entry.trust,
          memoryContentHash(entry.kind, entry.content),
          entry.importance,
          entry.confidence,
          entry.validUntil ?? null,
          entry.updatedAt,
          entry.accessCount,
          entry.usefulAccessCount,
          json,
        )
        for (const table of ['memory_fts_unicode', 'memory_fts_trigram'] as const) {
          db.prepare(`DELETE FROM ${table} WHERE memory_id = ?`).run(entry.id)
          if (entry.status !== 'tombstoned' && entry.status !== 'superseded') {
            db.prepare(`INSERT INTO ${table} (memory_id, content, summary) VALUES (?, ?, ?)`).run(
              entry.id,
              entry.content,
              entry.summary ?? '',
            )
          }
        }
      }
      this.refreshOwner(db)
      db.exec('COMMIT')
    } catch (error: unknown) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  private refreshOwner(db: DatabaseSync): void {
    refreshMemoryStoreOwner(db, this.owner, this.config.ownerStaleMs, this.config.path)
  }

  private recordSignal(
    id: MemoryIdType,
    signal: 'candidate_hit' | 'injected' | 'user_confirmed' | 'user_rejected',
    sessionId?: string,
    turn?: number,
  ): void {
    this.requireDb().prepare(`
      INSERT INTO memory_signals (id, memory_id, signal, session_id, turn, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), id, signal, sessionId ?? null, turn ?? null, Date.now())
  }

  private enqueueExtraction(input: EnqueueMemoryExtractionInput): Promise<MemoryExtractionJob> {
    validateExtractionInput(input)
    const payload = snapshotExtractionInput(input)
    const payloadJson = JSON.stringify(payload)
    const dedupeKey = extractionDedupeKey(payload)
    const id = MemoryExtractionJobId(`memory-extraction-${dedupeKey}`)
    const db = this.requireDb()
    db.exec('BEGIN IMMEDIATE')
    try {
      const existing = db.prepare(
        'SELECT * FROM memory_extraction_jobs WHERE dedupe_key = ?',
      ).get(dedupeKey) as ExtractionJobRow | undefined
      if (existing !== undefined) {
        if (existing.payload_json !== payloadJson || existing.max_attempts !== input.maxAttempts) {
          throw new Error(`memory extraction job ${existing.id} was enqueued with different input`)
        }
        db.exec('COMMIT')
        return Promise.resolve(parseExtractionJob(existing))
      }
      const now = Date.now()
      db.prepare(`
        INSERT INTO memory_extraction_jobs (
          id, dedupe_key, workspace_id, user_id, agent_id, session_id, turn,
          source_hash, payload_json, status, max_attempts, available_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).run(
        id,
        dedupeKey,
        input.scope.workspaceId,
        input.scope.userId,
        input.scope.agentId,
        input.sessionId,
        input.turn,
        input.sourceHash,
        payloadJson,
        input.maxAttempts,
        now,
        now,
        now,
      )
      this.refreshOwner(db)
      db.exec('COMMIT')
    } catch (error: unknown) {
      db.exec('ROLLBACK')
      throw error
    }
    return Promise.resolve(this.requireExtractionJob(id))
  }

  private claimExtraction(input: ClaimMemoryExtractionInput): Promise<MemoryExtractionJob | undefined> {
    const workerId = requireText('extraction workerId', input.workerId)
    assertPositiveSafeInteger('extraction leaseMs', input.leaseMs)
    const now = input.now ?? Date.now()
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('memory extraction now must be a non-negative safe integer')
    const db = this.requireDb()
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(`
        UPDATE memory_extraction_jobs
        SET status = 'failed', lease_owner = NULL, lease_until = NULL,
            last_error = 'worker lease expired after final attempt', updated_at = ?
        WHERE status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?
          AND attempts >= max_attempts
      `).run(now, now)
      const candidate = db.prepare(`
        SELECT id FROM memory_extraction_jobs
        WHERE attempts < max_attempts AND (
          (status = 'pending' AND available_at <= ?)
          OR (status = 'running' AND lease_until IS NOT NULL AND lease_until <= ?)
        )
        ORDER BY available_at ASC, created_at ASC, id ASC
        LIMIT 1
      `).get(now, now) as { id: string } | undefined
      if (candidate === undefined) {
        db.exec('COMMIT')
        return Promise.resolve(undefined)
      }
      db.prepare(`
        UPDATE memory_extraction_jobs
        SET status = 'running', attempts = attempts + 1,
            lease_owner = ?, lease_until = ?, updated_at = ?
        WHERE id = ?
      `).run(workerId, now + input.leaseMs, now, candidate.id)
      this.refreshOwner(db)
      const claimed = this.requireExtractionJob(MemoryExtractionJobId(candidate.id))
      db.exec('COMMIT')
      return Promise.resolve(claimed)
    } catch (error: unknown) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  private completeExtraction(input: CompleteMemoryExtractionInput): Promise<MemoryExtractionJob> {
    const workerId = requireText('extraction workerId', input.workerId)
    validateExtractionResult(input.result)
    const now = Date.now()
    const changed = this.requireDb().prepare(`
      UPDATE memory_extraction_jobs
      SET status = 'completed', result_json = ?, lease_owner = NULL,
          lease_until = NULL, last_error = NULL, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
        AND lease_until IS NOT NULL AND lease_until > ?
    `).run(JSON.stringify(input.result), now, input.jobId, workerId, now).changes
    if (changed !== 1) throw new Error(`memory extraction job ${input.jobId} is not leased by ${workerId}`)
    return Promise.resolve(this.requireExtractionJob(input.jobId))
  }

  private failExtraction(input: FailMemoryExtractionInput): Promise<MemoryExtractionJob> {
    const workerId = requireText('extraction workerId', input.workerId)
    const error = requireText('extraction error', input.error)
    if (Array.from(error).length > 2_000) throw new Error('memory extraction error must not exceed 2000 Unicode code points')
    if (!Number.isSafeInteger(input.retryAt) || input.retryAt < 0) {
      throw new Error('memory extraction retryAt must be a non-negative safe integer')
    }
    const row = this.requireExtractionJob(input.jobId)
    if (row.status !== 'running' || row.leaseOwner !== workerId
      || row.leaseUntil === undefined || row.leaseUntil <= Date.now()) {
      throw new Error(`memory extraction job ${input.jobId} is not leased by ${workerId}`)
    }
    const terminal = row.attempts >= row.maxAttempts
    const changed = this.requireDb().prepare(`
      UPDATE memory_extraction_jobs
      SET status = ?, available_at = ?, lease_owner = NULL, lease_until = NULL,
          last_error = ?, updated_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ?
    `).run(terminal ? 'failed' : 'pending', input.retryAt, error, Date.now(), input.jobId, workerId).changes
    if (changed !== 1) throw new Error(`memory extraction job ${input.jobId} changed before failure settlement`)
    return Promise.resolve(this.requireExtractionJob(input.jobId))
  }

  private readExtraction(id: MemoryExtractionJobIdType): Promise<MemoryExtractionJob | undefined> {
    const row = this.requireDb().prepare(
      'SELECT * FROM memory_extraction_jobs WHERE id = ?',
    ).get(id) as ExtractionJobRow | undefined
    return Promise.resolve(row === undefined ? undefined : parseExtractionJob(row))
  }

  private requireExtractionJob(id: MemoryExtractionJobIdType): MemoryExtractionJob {
    const row = this.requireDb().prepare(
      'SELECT * FROM memory_extraction_jobs WHERE id = ?',
    ).get(id) as ExtractionJobRow | undefined
    if (row === undefined) throw new Error(`memory extraction job ${id} was not found`)
    return parseExtractionJob(row)
  }

  private findExact(
    scope: MemoryScope,
    kind: MemoryKind,
    content: string,
    statuses: readonly MemoryStatus[],
  ): MemoryEntry | undefined {
    const row = this.requireDb().prepare(`
      SELECT entry_json FROM memory_entries
      WHERE workspace_id = ? AND user_id = ? AND agent_id = ?
        AND kind = ? AND content_hash = ?
        AND status IN (${statuses.map(() => '?').join(', ')})
      ORDER BY updated_at DESC, memory_id ASC
      LIMIT 1
    `).get(
      scope.workspaceId,
      scope.userId,
      scope.agentId,
      kind,
      memoryContentHash(kind, content),
      ...statuses,
    ) as { entry_json: string } | undefined
    return row === undefined ? undefined : parseEntry(row.entry_json)
  }

  private requireDb(): DatabaseSync {
    if (this.closed) throw new Error('memory SQLite provider is closed')
    if (this.db === undefined) throw new Error('memory SQLite provider is not ready')
    return this.db
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const path = requireText('path', config.path)
  const journalMode = config.journalMode ?? 'wal'
  const maxSearchLimit = config.maxSearchLimit ?? MAX_SEARCH_LIMIT
  const maxContentChars = config.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS
  const maxSummaryChars = config.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS
  const ownerStaleMs = config.ownerStaleMs ?? DEFAULT_OWNER_STALE_MS
  assertPositiveSafeInteger('maxSearchLimit', maxSearchLimit)
  assertPositiveSafeInteger('maxContentChars', maxContentChars)
  assertPositiveSafeInteger('maxSummaryChars', maxSummaryChars)
  assertPositiveSafeInteger('ownerStaleMs', ownerStaleMs)
  return { path, journalMode, maxSearchLimit, maxContentChars, maxSummaryChars, ownerStaleMs }
}

function validateRemember(input: RememberMemoryInput, limits: Pick<ResolvedConfig, 'maxContentChars' | 'maxSummaryChars'>): void {
  assertScope(input.scope)
  validateEntryFields(input, limits)
  validateEvidence(input.evidence)
  validateTrustEvidence(input.trust, input.evidence)
}

function validateEntry(entry: MemoryEntry, limits: Pick<ResolvedConfig, 'maxContentChars' | 'maxSummaryChars'>): void {
  assertScope(entry.scope)
  validateEntryFields(entry, limits)
  validateEvidence(entry.evidence)
  validateTrustEvidence(entry.trust, entry.evidence)
  assertPositiveSafeInteger('revision', entry.revision)
  if (!Number.isSafeInteger(entry.createdAt) || !Number.isSafeInteger(entry.updatedAt)) {
    throw new Error('memory timestamps must be safe integers')
  }
}

function validateEntryFields(input: {
  kind: MemoryKind
  status: MemoryStatus
  trust: MemoryTrust
  content: string
  summary?: string
  importance: number
  confidence: number
  validUntil?: number
}, limits: Pick<ResolvedConfig, 'maxContentChars' | 'maxSummaryChars'>): void {
  if (!(MEMORY_KINDS as readonly string[]).includes(input.kind)) throw new Error(`invalid memory kind ${input.kind}`)
  if (!(MEMORY_STATUSES as readonly string[]).includes(input.status)) throw new Error(`invalid memory status ${input.status}`)
  if (!(MEMORY_TRUST as readonly string[]).includes(input.trust)) throw new Error(`invalid memory trust ${input.trust}`)
  const content = requireText('content', input.content)
  if (Array.from(content).length > limits.maxContentChars) {
    throw new Error(`memory content must not exceed ${limits.maxContentChars} Unicode code points`)
  }
  if (input.summary !== undefined) {
    const summary = requireText('summary', input.summary)
    if (Array.from(summary).length > limits.maxSummaryChars) {
      throw new Error(`memory summary must not exceed ${limits.maxSummaryChars} Unicode code points`)
    }
    assertNoSecret(input.summary)
  }
  assertNoSecret(input.content)
  if (!Number.isSafeInteger(input.importance) || input.importance < 1 || input.importance > 4) {
    throw new Error('memory importance must be an integer from 1 through 4')
  }
  if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error('memory confidence must be between 0 and 1')
  }
  if (input.validUntil !== undefined && (!Number.isSafeInteger(input.validUntil) || input.validUntil <= Date.now())) {
    throw new Error('memory validUntil must be a future epoch-millisecond safe integer')
  }
  if (input.status === 'active' && input.trust !== 'user-stated' && input.trust !== 'action-verified') {
    throw new Error('active memory requires user-stated or action-verified trust')
  }
}

function validateEvidence(evidence: readonly MemoryEvidence[]): void {
  if (evidence.length === 0) throw new Error('memory writes require durable evidence')
  for (const item of evidence) {
    const unique = new Set(item.eventSeqs)
    if (item.eventSeqs.length === 0 || unique.size !== item.eventSeqs.length) {
      throw new Error('memory evidence eventSeqs must be non-empty and unique')
    }
    for (const seq of item.eventSeqs) {
      if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('memory evidence seqs must be non-negative safe integers')
    }
    if (item.excerpt !== undefined && Array.from(item.excerpt).length > MAX_EVIDENCE_EXCERPT_CHARS) {
      throw new Error(`memory evidence excerpt must not exceed ${MAX_EVIDENCE_EXCERPT_CHARS} Unicode code points`)
    }
  }
}

function validateTrustEvidence(trust: MemoryTrust, evidence: readonly MemoryEvidence[]): void {
  const required = {
    'user-stated': 'user-statement',
    'action-verified': 'successful-tool-result',
    'agent-proposed': 'agent-proposal',
    'external': 'external-observation',
  } as const
  if (!evidence.some(item => item.verification === required[trust])) {
    throw new Error(`memory trust ${trust} requires ${required[trust]} evidence`)
  }
}

function assertScope(scope: MemoryScope): void {
  for (const [name, value] of [
    ['workspaceId', scope.workspaceId],
    ['userId', scope.userId],
    ['agentId', scope.agentId],
  ] as const) requireText(`scope.${name}`, value)
}

function assertKinds(kinds: readonly MemoryKind[] | undefined): void {
  if (kinds === undefined) return
  if (kinds.length === 0 || kinds.some(kind => !(MEMORY_KINDS as readonly string[]).includes(kind))) {
    throw new Error('memory kinds filter must contain valid kinds')
  }
}

function assertStatuses(statuses: readonly MemoryStatus[] | undefined): void {
  if (statuses === undefined) return
  if (statuses.length === 0 || statuses.some(status => !(MEMORY_STATUSES as readonly string[]).includes(status))) {
    throw new Error('memory statuses filter must contain valid statuses')
  }
}

function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`memory ${name} must be a positive safe integer`)
}

function requireText(name: string, value: string): string {
  const normalized = value.trim()
  if (normalized === '') throw new Error(`memory ${name} must not be empty`)
  return normalized
}

function assertNoSecret(content: string): void {
  if (memoryContainsSecret(content)) {
    throw new Error('memory content appears to contain a secret and cannot be persisted')
  }
}

function snapshotScope(scope: MemoryScope): MemoryScope {
  return { workspaceId: scope.workspaceId, userId: scope.userId, agentId: scope.agentId }
}

function snapshotEvidence(evidence: readonly MemoryEvidence[]): MemoryEvidence[] {
  return structuredClone([...evidence])
}

function snapshotEntry(entry: MemoryEntry): MemoryEntry {
  return structuredClone(entry)
}

function parseEntry(value: string): MemoryEntry {
  return JSON.parse(value) as MemoryEntry
}

function validateExtractionInput(input: EnqueueMemoryExtractionInput): void {
  assertExtractionPromptVersion(input.promptVersion)
  assertScope(input.scope)
  assertPositiveSafeInteger('extraction turn', input.turn)
  assertPositiveSafeInteger('extraction maxAttempts', input.maxAttempts)
  requireSha256('extraction sourceHash', input.sourceHash)
  requireText('extraction route.provider', input.route.provider)
  requireText('extraction route.model', input.route.model)
  if (input.sources.length === 0 || input.sources.length > 64) {
    throw new Error('memory extraction sources must contain from 1 through 64 items')
  }
  for (const source of input.sources) {
    const text = requireText('extraction source text', source.text)
    assertNoSecret(text)
    validateEvidence([source.evidence])
    if (source.kind === 'user' && source.evidence.verification !== 'user-statement') {
      throw new Error('memory extraction user sources require user-statement evidence')
    }
    if (source.kind === 'tool-result'
      && source.evidence.verification !== 'successful-tool-result'
      && source.evidence.verification !== 'external-observation') {
      throw new Error('memory extraction tool-result sources require successful-tool-result or external-observation evidence')
    }
    if (source.kind === 'tool-result') requireText('extraction source toolName', source.toolName ?? '')
    if (source.kind === 'user' && source.toolName !== undefined) {
      throw new Error('memory extraction user sources cannot name a tool')
    }
  }
}

function validateExtractionResult(result: CompleteMemoryExtractionInput['result']): void {
  if (!Number.isSafeInteger(result.candidateCount) || result.candidateCount < 0) {
    throw new Error('memory extraction candidateCount must be a non-negative safe integer')
  }
  if (!Number.isSafeInteger(result.skippedCount) || result.skippedCount < 0) {
    throw new Error('memory extraction skippedCount must be a non-negative safe integer')
  }
  requireSha256('extraction outputHash', result.outputHash)
  if (new Set(result.memoryIds).size !== result.memoryIds.length) {
    throw new Error('memory extraction result memoryIds must be unique')
  }
}

function snapshotExtractionInput(input: EnqueueMemoryExtractionInput): EnqueueMemoryExtractionInput {
  return structuredClone({
    promptVersion: input.promptVersion,
    scope: snapshotScope(input.scope),
    sessionId: input.sessionId,
    turn: input.turn,
    sourceHash: input.sourceHash,
    route: input.route,
    sources: input.sources,
    maxAttempts: input.maxAttempts,
  })
}

function extractionDedupeKey(input: EnqueueMemoryExtractionInput): string {
  return createHash('sha256').update(JSON.stringify([
    input.scope.workspaceId,
    input.scope.userId,
    input.scope.agentId,
    input.sessionId,
    input.turn,
    input.sourceHash,
  ])).digest('hex')
}

function parseExtractionJob(row: ExtractionJobRow): MemoryExtractionJob {
  const input = JSON.parse(row.payload_json) as EnqueueMemoryExtractionInput
  validateExtractionInput(input)
  return {
    ...input,
    id: MemoryExtractionJobId(row.id),
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    ...row.lease_owner === null ? {} : { leaseOwner: row.lease_owner },
    ...row.lease_until === null ? {} : { leaseUntil: row.lease_until },
    ...row.last_error === null ? {} : { lastError: row.last_error },
    ...row.result_json === null ? {} : { result: JSON.parse(row.result_json) as CompleteMemoryExtractionInput['result'] },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function assertExtractionPromptVersion(value: number): void {
  if (value !== 1) throw new Error(`memory extraction promptVersion ${value} is unsupported`)
}

function requireSha256(name: string, value: string): string {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`memory ${name} must be a lowercase SHA-256 hex string`)
  return value
}

function turnHandle(input: PrepareMemoryTurnInput): string {
  return createHash('sha256').update(JSON.stringify([
    input.scope.workspaceId,
    input.scope.userId,
    input.scope.agentId,
    input.sessionId,
    input.turn,
  ])).digest('base64url')
}

function restorePrepared(row: TurnRow, input: PrepareMemoryTurnInput): PreparedMemoryTurn {
  if (
    row.workspace_id !== input.scope.workspaceId
    || row.user_id !== input.scope.userId
    || row.agent_id !== input.scope.agentId
    || row.session_id !== input.sessionId
    || row.turn !== input.turn
    || row.query !== input.query.trim()
  ) {
    throw new Error(`memory turn ${row.handle} was prepared with different input`)
  }
  if (row.status !== 'prepared') throw new Error(`memory turn ${row.handle} is already ${row.status}`)
  return {
    handle: MemoryTurnHandle(row.handle),
    scope: snapshotScope(input.scope),
    sessionId: input.sessionId,
    turn: input.turn,
    query: row.query,
    candidates: JSON.parse(row.candidates_json) as MemorySearchHit[],
  }
}

function requireTurn(db: DatabaseSync, handle: MemoryTurnHandleType): TurnRow {
  const row = db.prepare('SELECT * FROM memory_turns WHERE handle = ?').get(handle) as TurnRow | undefined
  if (row === undefined) throw new Error(`memory turn ${handle} was not found`)
  return row
}

function uniqueIds(ids: readonly MemoryIdType[]): MemoryIdType[] {
  return [...new Set(ids)]
}

function unicodeFtsQuery(query: string): string {
  return query.trim().split(/\s+/u).filter(Boolean).map(part => `${quotedFts(part)}*`).join(' OR ')
}

function quotedFts(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function addListFilter(
  where: string[],
  params: Array<string | number>,
  column: string,
  values: readonly string[] | undefined,
): void {
  if (values === undefined) return
  where.push(`${column} IN (${values.map(() => '?').join(', ')})`)
  params.push(...values)
}

function trustWeight(trust: MemoryTrust): number {
  switch (trust) {
    case 'user-stated': return 1
    case 'action-verified': return 1
    case 'agent-proposed': return 0.4
    case 'external': return 0.2
  }
}

function resolveOptionalText(
  current: MemoryEntry,
  value: string | null | undefined,
): Pick<MemoryEntry, 'summary'> {
  if (value === null) return {}
  if (value === undefined) return current.summary === undefined ? {} : { summary: current.summary }
  return { summary: requireText('summary', value) }
}

function resolveValidUntil(
  current: MemoryEntry,
  value: number | null | undefined,
): Pick<MemoryEntry, 'validUntil'> {
  if (value === null) return {}
  if (value === undefined) return current.validUntil === undefined ? {} : { validUntil: current.validUntil }
  return { validUntil: value }
}

export default SqliteLongTermMemory
