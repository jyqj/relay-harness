/**
 * Local SQLite provider for the long-term-memory capability.
 *
 * @module @deepseek-ai/dsh-memory-sqlite
 */

import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import LongTermMemory, { MemoryId, MemoryTurnHandle } from '@deepseek-ai/dsh-memory'
import type {
  AbortMemoryTurnInput,
  CommitMemoryTurnInput,
  ForgetMemoryInput,
  MemoryEntry,
  MemoryEvidence,
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
import { openMemoryDatabase, type JournalMode } from './schema.ts'

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
}

interface ResolvedConfig {
  path: string
  journalMode: JournalMode
  maxSearchLimit: number
  maxContentChars: number
  maxSummaryChars: number
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

/** Canonical local provider with append-only revisions and rebuildable FTS indexes. */
export class SqliteLongTermMemory extends LongTermMemory {
  static Config: z<Config> = z.object({
    path: z.string().required(),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    maxSearchLimit: z.number().step(1).min(1).max(MAX_SEARCH_LIMIT).default(MAX_SEARCH_LIMIT),
    maxContentChars: z.number().step(1).min(1).default(DEFAULT_MAX_CONTENT_CHARS),
    maxSummaryChars: z.number().step(1).min(1).default(DEFAULT_MAX_SUMMARY_CHARS),
  })

  /** Validated and defaulted canonical-store configuration. */
  readonly config: ResolvedConfig
  private db: DatabaseSync | undefined
  private closed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = resolveConfig(config)
    ctx.effect(() => async () => this.close(), 'memorySqlite.close')
  }

  protected async [Service.init](): Promise<void> {
    this.db = await openMemoryDatabase(this.config.path, this.config.journalMode)
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
      evidence: snapshotEvidence(input.evidence),
      accessCount: 0,
      usefulAccessCount: 0,
    }
    this.writeEntry(entry)
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
    this.db?.close()
    this.db = undefined
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
    return [...scores.entries()]
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

  private writeEntry(entry: MemoryEntry): void {
    validateEntry(entry, this.config)
    const db = this.requireDb()
    const json = JSON.stringify(entry)
    db.exec('BEGIN IMMEDIATE')
    try {
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
          memory_id, revision, workspace_id, user_id, agent_id, kind, status, trust,
          importance, confidence, valid_until, updated_at, access_count,
          useful_access_count, entry_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(memory_id) DO UPDATE SET
          revision = excluded.revision,
          workspace_id = excluded.workspace_id,
          user_id = excluded.user_id,
          agent_id = excluded.agent_id,
          kind = excluded.kind,
          status = excluded.status,
          trust = excluded.trust,
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
      db.exec('COMMIT')
    } catch (error: unknown) {
      db.exec('ROLLBACK')
      throw error
    }
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
  assertPositiveSafeInteger('maxSearchLimit', maxSearchLimit)
  assertPositiveSafeInteger('maxContentChars', maxContentChars)
  assertPositiveSafeInteger('maxSummaryChars', maxSummaryChars)
  return { path, journalMode, maxSearchLimit, maxContentChars, maxSummaryChars }
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
  const patterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/u,
    /\b(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{16,}\b/u,
    /\b(?:api[_ -]?key|access[_ -]?token|password|secret)\s*[:=]\s*[^\s]{8,}/iu,
  ]
  if (patterns.some(pattern => pattern.test(content))) {
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
