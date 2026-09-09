/**
 * Workspace-aware local Code Index provider.
 *
 * The router is the process-wide `ctx.codeIndex` owner for multi-Workspace
 * hosts, but it never owns a process-default index. Every operation first
 * binds a canonical Session workspace, then leases an isolated local runtime
 * and SQLite generation for exactly that root. Idle/LRU eviction closes only
 * quiescent runtimes; a concurrent reopen waits for the old handle to close.
 *
 * @module @relay-harness/rlh-code-index-workspace-router
 */

import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Context } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import CodeIndex from '@relay-harness/rlh-code-index'
import type {
  CodeIndexManagementStatus,
  CodeIndexWorkspace,
  GraphExploreRequest,
  GraphExploreResult,
  HydrateChunksRequest,
  HydrateChunksResult,
  IndexStatusReport,
  RefreshOptions,
  RefreshSummary,
  SearchRequest,
  SearchResult,
} from '@relay-harness/rlh-code-index'
import {
  DEFAULT_DIRTY_PROPAGATION_MAX_FILES,
  DEFAULT_EMBEDDING_API_KEY_ENV,
  DEFAULT_EMBEDDING_BATCH_SIZE,
  DEFAULT_EMBEDDING_MAX_INPUTS_PER_REQUEST,
  DEFAULT_EMBEDDING_MAX_JOBS_PER_DRAIN,
  DEFAULT_EMBEDDING_MAX_PROMPT_TOKENS_PER_DRAIN,
  DEFAULT_EMBEDDING_TIMEOUT_MS,
  DEFAULT_EMBEDDING_VECTOR_MAX_CANDIDATES,
  DEFAULT_EMBEDDING_VECTOR_TOP_K,
  DEFAULT_EMBEDDING_VECTOR_WEIGHT,
  LocalCodeIndexRuntime,
  StaleInvalidator,
  TreeWatcher,
  defaultDatabasePath,
  resolveEmbeddingConfig,
  toolResultStaleHandler,
} from '@relay-harness/rlh-code-index-local'
import type { Config as SingleWorkspaceConfig, LocalEmbeddingRuntimeConfig } from '@relay-harness/rlh-code-index-local'
import type {} from '@relay-harness/rlh-session'

/** Default maximum simultaneously open workspace runtimes. */
export const DEFAULT_MAX_OPEN_WORKSPACES = 4
/** Default idle lifetime before an unused runtime is closed (five minutes). */
export const DEFAULT_IDLE_EVICT_MS = 300_000
/** Local runtime file-size default mirrored from the single-workspace adapter. */
export const DEFAULT_ROUTER_MAX_FILE_BYTES = 512_000
/** Tool-result invalidation debounce for each open workspace. */
export const DEFAULT_ROUTER_DEBOUNCE_MS = 500

/** Router configuration shared by every per-workspace local runtime. */
export interface Config extends Omit<SingleWorkspaceConfig, 'workspaceRoot' | 'databasePath'> {
  /** Directory containing workspace-hash SQLite files; omitted uses the normal RLH home. */
  readonly databaseDirectory?: string
  /** Maximum quiescent/open workspace runtimes retained in-process. Defaults to 4. */
  readonly maxOpenWorkspaces?: number
  /** Close an unused runtime after this many milliseconds. Defaults to 300000. */
  readonly idleEvictMs?: number
}

interface ResolvedConfig {
  readonly databaseDirectory?: string
  readonly maxOpenWorkspaces: number
  readonly idleEvictMs: number
  readonly journalMode: NonNullable<SingleWorkspaceConfig['journalMode']>
  readonly excludePatterns: readonly string[]
  readonly maxFileBytes: number
  readonly debounceMs: number
  readonly watcherEnabled: boolean
  readonly dirtyPropagationMaxFiles: number
  readonly embedding?: LocalEmbeddingRuntimeConfig
}

interface WorkspaceEntry {
  readonly root: string
  readonly databasePath: string
  readonly runtime: LocalCodeIndexRuntime
  readonly invalidator: StaleInvalidator
  readonly watcher: TreeWatcher
  active: number
  lastUsedAt: number
  closing: boolean
}

/** Workspace router plugin serving `ctx.codeIndex` for multi-Workspace hosts. */
export class CodeIndexWorkspaceRouter extends CodeIndex {
  static inject: string[] = []
  static Config: z<Config> = z.object({
    databaseDirectory: z.string(),
    maxOpenWorkspaces: z.number().step(1).min(1).default(DEFAULT_MAX_OPEN_WORKSPACES),
    idleEvictMs: z.number().step(1).min(1).default(DEFAULT_IDLE_EVICT_MS),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    exclude: z.array(z.string()).default([]),
    maxFileBytes: z.number().step(1).min(1).default(DEFAULT_ROUTER_MAX_FILE_BYTES),
    debounceMs: z.number().step(1).min(1).default(DEFAULT_ROUTER_DEBOUNCE_MS),
    watcherEnabled: z.boolean().default(false),
    dirtyPropagationMaxFiles: z.number().step(1).min(1).default(DEFAULT_DIRTY_PROPAGATION_MAX_FILES),
    embedding: z.object({
      apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_EMBEDDING_API_KEY_ENV),
      baseURL: z.string(),
      model: z.string(),
      dimensions: z.number().step(1).min(1),
      batchSize: z.number().step(1).min(1).default(DEFAULT_EMBEDDING_BATCH_SIZE),
      timeoutMs: z.number().step(1).min(1).default(DEFAULT_EMBEDDING_TIMEOUT_MS),
      maxInputsPerRequest: z.number().step(1).min(1).default(DEFAULT_EMBEDDING_MAX_INPUTS_PER_REQUEST),
      maxPromptTokensPerDrain: z.number().step(1).min(1).default(DEFAULT_EMBEDDING_MAX_PROMPT_TOKENS_PER_DRAIN),
      maxJobsPerDrain: z.number().step(1).min(1).default(DEFAULT_EMBEDDING_MAX_JOBS_PER_DRAIN),
      vectorWeight: z.number().min(0).default(DEFAULT_EMBEDDING_VECTOR_WEIGHT),
      vectorTopK: z.number().step(1).min(1).default(DEFAULT_EMBEDDING_VECTOR_TOP_K),
      vectorMaxCandidates: z.number().step(1).min(1).default(DEFAULT_EMBEDDING_VECTOR_MAX_CANDIDATES),
    }),
  })

  private readonly resolved: ResolvedConfig
  private readonly entries = new Map<string, WorkspaceEntry>()
  private readonly opening = new Map<string, Promise<WorkspaceEntry>>()
  private readonly closing = new Map<string, Promise<void>>()
  private evictionTimer: NodeJS.Timeout | undefined
  private evictionChain: Promise<void> = Promise.resolve()
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.resolved = resolveConfig(config)
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'tool/result' || session.header.cwd === undefined) return
      void this.scheduleSessionInvalidation(session.header.cwd)
    })
    ctx.effect(() => async () => { await this.disposeRouter() }, 'code-index-workspace-router.teardown')
  }

  /**
   * Bind a canonical Workspace without opening it until the first operation.
   * @param workspaceRoot - caller-selected absolute workspace root.
   * @returns an immutable workspace face routed to its isolated derived store.
   */
  override async forWorkspace(workspaceRoot: string): Promise<CodeIndexWorkspace> {
    const canonical = await canonicalWorkspaceRoot(workspaceRoot)
    return Object.freeze({
      workspaceRoot: canonical,
      status: () => this.run(canonical, runtime => runtime.status()),
      managementStatus: () => this.run(canonical, runtime => runtime.managementStatus()),
      reconcile: () => this.run(canonical, runtime => runtime.reconcile()),
      refresh: (options?: RefreshOptions) => this.run(canonical, runtime => runtime.refresh(options)),
      search: (request: SearchRequest, signal?: AbortSignal) => this.run(canonical, runtime => runtime.search(request, signal)),
      hydrateChunks: (request: HydrateChunksRequest, signal?: AbortSignal) => this.run(
        canonical,
        runtime => runtime.hydrateChunks(request, signal),
      ),
      exploreGraph: (request: GraphExploreRequest, signal?: AbortSignal) => this.run(
        canonical,
        runtime => runtime.exploreGraph(request, signal),
      ),
    })
  }

  /**
   * Reject process-wide status on a multi-Workspace provider.
   * @returns a rejected promise requiring a workspace-bound face.
   */
  override status(): Promise<IndexStatusReport> { return Promise.reject(workspaceRequired()) }
  /**
   * Reject process-wide management status on a multi-Workspace provider.
   * @returns a rejected promise requiring a workspace-bound face.
   */
  override managementStatus(): Promise<CodeIndexManagementStatus> { return Promise.reject(workspaceRequired()) }
  /**
   * Reject process-wide reconciliation on a multi-Workspace provider.
   * @returns a rejected promise requiring a workspace-bound face.
   */
  override reconcile(): Promise<CodeIndexManagementStatus> { return Promise.reject(workspaceRequired()) }
  /**
   * Reject process-wide refresh on a multi-Workspace provider.
   * @param _options - unused because a workspace is required before refresh.
   * @returns a rejected promise requiring a workspace-bound face.
   */
  override refresh(_options?: RefreshOptions): Promise<RefreshSummary> { return Promise.reject(workspaceRequired()) }
  /**
   * Reject process-wide search on a multi-Workspace provider.
   * @param _request - unused because a workspace is required before search.
   * @param _signal - unused caller cancellation.
   * @returns a rejected promise requiring a workspace-bound face.
   */
  override search(_request: SearchRequest, _signal?: AbortSignal): Promise<SearchResult> { return Promise.reject(workspaceRequired()) }
  /**
   * Reject process-wide hydration on a multi-Workspace provider.
   * @param _request - unused because a workspace is required before hydration.
   * @param _signal - unused caller cancellation.
   * @returns a rejected promise requiring a workspace-bound face.
   */
  override hydrateChunks(
    _request: HydrateChunksRequest,
    _signal?: AbortSignal,
  ): Promise<HydrateChunksResult> { return Promise.reject(workspaceRequired()) }
  /**
   * Reject process-wide graph exploration on a multi-Workspace provider.
   * @param _request - unused because a workspace is required before graph exploration.
   * @param _signal - unused caller cancellation.
   * @returns a rejected promise requiring a workspace-bound face.
   */
  override exploreGraph(
    _request: GraphExploreRequest,
    _signal?: AbortSignal,
  ): Promise<GraphExploreResult> { return Promise.reject(workspaceRequired()) }

  /** Current canonical roots with open runtime handles, ordered by identity.
   * @returns sorted open canonical workspace roots.
   */
  openWorkspaceRoots(): readonly string[] { return [...this.entries.keys()].sort() }

  /**
   * Deterministically run the idle/LRU collector; exposed for lifecycle tests
   * and operator shutdown hooks, not as a model-facing action.
   */
  async evictIdleNow(): Promise<void> { await this.queueEviction(true) }

  /** Resolve the dedicated derived database path for a canonical workspace.
   * @param workspaceRoot - canonical workspace root.
   * @returns isolated derived database path.
   */
  databasePathFor(workspaceRoot: string): string {
    return databasePathFor(this.resolved.databaseDirectory, workspaceRoot)
  }

  /** Check current shutdown state across acquisition awaits. */
  private assertNotDisposed(): void {
    if (this.disposed) throw new Error('code-index-workspace-router is disposed')
  }

  private async run<T>(root: string, operation: (runtime: LocalCodeIndexRuntime) => T | Promise<T>): Promise<T> {
    this.assertNotDisposed()
    let entry: WorkspaceEntry
    do {
      entry = await this.acquire(root)
      this.assertNotDisposed()
      // Eviction may win the await continuation after acquire found a live entry.
      // Reserve only an entry still published by this router, without another await.
    } while (entry.closing || this.entries.get(root) !== entry)
    entry.active += 1
    entry.lastUsedAt = Date.now()
    try {
      return await operation(entry.runtime)
    } finally {
      entry.active -= 1
      entry.lastUsedAt = Date.now()
      void this.queueEviction(false)
    }
  }

  private async acquire(root: string): Promise<WorkspaceEntry> {
    const closing = this.closing.get(root)
    if (closing !== undefined) await closing
    const current = this.entries.get(root)
    if (current !== undefined && !current.closing) return current
    const pending = this.opening.get(root)
    if (pending !== undefined) return pending
    const opening = this.openEntry(root).finally(() => { this.opening.delete(root) })
    this.opening.set(root, opening)
    return opening
  }

  private async openEntry(root: string): Promise<WorkspaceEntry> {
    const runtime = new LocalCodeIndexRuntime({
      workspaceRoot: root,
      databasePath: this.databasePathFor(root),
      journalMode: this.resolved.journalMode,
      excludePatterns: this.resolved.excludePatterns,
      maxFileBytes: this.resolved.maxFileBytes,
      dirtyPropagationMaxFiles: this.resolved.dirtyPropagationMaxFiles,
      ...(this.resolved.embedding === undefined ? {} : { embedding: this.resolved.embedding }),
    })
    const entry = {} as WorkspaceEntry
    const invalidator = new StaleInvalidator(this.resolved.debounceMs, (paths) => {
      void this.runExisting(entry, current => current.runtime.refresh({ reason: 'stale', ...(paths === undefined ? {} : { paths }) }))
    })
    const watcher = new TreeWatcher(root, (paths) => {
      invalidator.schedule(paths?.some(path => path.split('/').at(-1) === '.gitignore') === true ? undefined : paths)
    }, () => { runtime.setWatcherDegraded(true) })
    Object.assign(entry, {
      root,
      databasePath: this.databasePathFor(root),
      runtime,
      invalidator,
      watcher,
      active: 0,
      lastUsedAt: Date.now(),
      closing: false,
    })
    try {
      await runtime.ensureOpen()
      if (this.resolved.watcherEnabled) {
        const state = await watcher.start()
        runtime.setWatcherDegraded(state === 'degraded')
      }
      if (this.disposed) throw new Error('code-index-workspace-router is disposed')
      this.entries.set(root, entry)
      this.scheduleEvictionTimer()
      return entry
    } catch (error) {
      invalidator.dispose()
      watcher.dispose()
      await runtime.embedDrainIdle().catch(() => undefined)
      await runtime.dispose()
      throw error
    }
  }

  private async runExisting(entry: WorkspaceEntry, operation: (entry: WorkspaceEntry) => Promise<unknown>): Promise<void> {
    if (entry.closing || this.disposed || this.entries.get(entry.root) !== entry) return
    entry.active += 1
    entry.lastUsedAt = Date.now()
    try {
      await operation(entry)
    } catch (error) {
      this.ctx.logger.warn('code-index-workspace-router: background refresh failed', {
        workspaceRoot: entry.root,
        reason: error instanceof Error ? error.message : String(error),
      })
    } finally {
      entry.active -= 1
      entry.lastUsedAt = Date.now()
      void this.queueEviction(false)
    }
  }

  private async scheduleSessionInvalidation(workspaceRoot: string): Promise<void> {
    let canonical: string
    try { canonical = await canonicalWorkspaceRoot(workspaceRoot) } catch { return }
    const entry = this.entries.get(canonical)
    if (entry !== undefined && !entry.closing) toolResultStaleHandler(entry.invalidator)({ type: 'tool/result' })
  }

  private queueEviction(forceIdle: boolean): Promise<void> {
    this.evictionChain = this.evictionChain.then(() => this.collect(forceIdle), () => this.collect(forceIdle))
    // Timer and operation-finally callers do not await collection. Observe their
    // failures while preserving the rejecting promise for explicit callers.
    void this.evictionChain.catch(() => { this.ctx.logger.warn('code-index-workspace-router: eviction failed') })
    return this.evictionChain
  }

  private async collect(forceIdle: boolean): Promise<void> {
    if (this.disposed) return
    const now = Date.now()
    const candidates = [...this.entries.values()]
      .filter(entry => entry.active === 0 && !entry.closing)
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.root.localeCompare(b.root))
    const selected = new Set<WorkspaceEntry>()
    for (const entry of candidates) {
      if (forceIdle || now - entry.lastUsedAt >= this.resolved.idleEvictMs) selected.add(entry)
    }
    let retained = this.entries.size - selected.size
    for (const entry of candidates) {
      if (retained <= this.resolved.maxOpenWorkspaces) break
      if (selected.has(entry)) continue
      selected.add(entry)
      retained -= 1
    }
    for (const entry of selected) await this.closeEntry(entry)
    this.scheduleEvictionTimer()
  }

  private async closeEntry(entry: WorkspaceEntry): Promise<void> {
    if (entry.active !== 0 || entry.closing || this.entries.get(entry.root) !== entry) return
    entry.closing = true
    this.entries.delete(entry.root)
    entry.invalidator.dispose()
    entry.watcher.dispose()
    const closing = (async () => {
      await entry.runtime.embedDrainIdle().catch(() => undefined)
      await entry.runtime.dispose()
    })().finally(() => { this.closing.delete(entry.root) })
    this.closing.set(entry.root, closing)
    await closing
  }

  private scheduleEvictionTimer(): void {
    if (this.evictionTimer !== undefined) clearTimeout(this.evictionTimer)
    if (this.disposed || this.entries.size === 0) { this.evictionTimer = undefined; return }
    const idle = [...this.entries.values()].filter(entry => entry.active === 0 && !entry.closing)
    if (idle.length === 0) { this.evictionTimer = undefined; return }
    const delay = Math.max(1, Math.min(...idle.map(entry => entry.lastUsedAt + this.resolved.idleEvictMs - Date.now())))
    this.evictionTimer = setTimeout(() => { this.evictionTimer = undefined; void this.queueEviction(false) }, delay)
    this.evictionTimer.unref()
  }

  /** The owning Cordis effect invokes this private disposer once per instance. */
  private async disposeRouter(): Promise<void> {
    this.disposed = true
    if (this.evictionTimer !== undefined) clearTimeout(this.evictionTimer)
    this.evictionTimer = undefined
    await Promise.allSettled(this.opening.values())
    const entries = [...this.entries.values()]
    const settled = await Promise.allSettled(entries.map(async (entry) => {
      while (entry.active > 0) await new Promise(resolve => setTimeout(resolve, 1))
      await this.closeEntryForDispose(entry)
    }))
    const closing = await Promise.allSettled(this.closing.values())
    const failures = [...settled, ...closing].flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
    if (failures.length > 0) throw new AggregateError(failures, 'code-index-workspace-router shutdown failed')
  }

  private async closeEntryForDispose(entry: WorkspaceEntry): Promise<void> {
    if (entry.closing) return
    entry.closing = true
    this.entries.delete(entry.root)
    entry.invalidator.dispose()
    entry.watcher.dispose()
    await entry.runtime.embedDrainIdle().catch(() => undefined)
    await entry.runtime.dispose()
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const maxOpenWorkspaces = config.maxOpenWorkspaces ?? DEFAULT_MAX_OPEN_WORKSPACES
  const idleEvictMs = config.idleEvictMs ?? DEFAULT_IDLE_EVICT_MS
  const maxFileBytes = config.maxFileBytes ?? DEFAULT_ROUTER_MAX_FILE_BYTES
  const debounceMs = config.debounceMs ?? DEFAULT_ROUTER_DEBOUNCE_MS
  const dirtyPropagationMaxFiles = config.dirtyPropagationMaxFiles ?? DEFAULT_DIRTY_PROPAGATION_MAX_FILES
  for (const [name, value] of [['maxOpenWorkspaces', maxOpenWorkspaces], ['idleEvictMs', idleEvictMs], ['maxFileBytes', maxFileBytes], ['debounceMs', debounceMs], ['dirtyPropagationMaxFiles', dirtyPropagationMaxFiles]] as const) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`code-index-workspace-router: ${name} must be a positive safe integer (got ${String(value)})`)
  }
  const excludes = config.exclude ?? []
  if (excludes.some(value => value.trim() === '')) throw new Error('code-index-workspace-router: exclude entries must be non-empty')
  const databaseDirectory = config.databaseDirectory?.trim()
  if (databaseDirectory === '') throw new Error('code-index-workspace-router: databaseDirectory must not be blank')
  const embedding = resolveEmbeddingConfig(config.embedding)
  return {
    ...(databaseDirectory === undefined ? {} : { databaseDirectory: resolve(databaseDirectory) }),
    maxOpenWorkspaces,
    idleEvictMs,
    journalMode: config.journalMode ?? 'wal',
    excludePatterns: [...excludes],
    maxFileBytes,
    debounceMs,
    watcherEnabled: config.watcherEnabled ?? false,
    dirtyPropagationMaxFiles,
    ...(embedding === undefined ? {} : { embedding }),
  }
}

/** Canonical existing directory identity used as the router key.
 * @param workspaceRoot - caller-supplied existing workspace directory.
 * @returns canonical existing directory path.
 */
export async function canonicalWorkspaceRoot(workspaceRoot: string): Promise<string> {
  if (workspaceRoot.trim() === '') throw new Error('code-index workspace root must not be blank')
  const canonical = await realpath(workspaceRoot)
  if (!(await stat(canonical)).isDirectory()) throw new Error(`code-index workspace root is not a directory: ${workspaceRoot}`)
  return canonical
}

/** Dedicated database path for one canonical workspace.
 * @param databaseDirectory - optional configured index directory.
 * @param canonicalRoot - canonical workspace identity.
 * @returns workspace-isolated SQLite database path.
 */
export function databasePathFor(databaseDirectory: string | undefined, canonicalRoot: string): string {
  if (databaseDirectory === undefined) return defaultDatabasePath(canonicalRoot)
  const digest = createHash('sha256').update(canonicalRoot).digest('hex').slice(0, 24)
  return join(resolve(databaseDirectory), `code-index-${digest}.sqlite3`)
}

function workspaceRequired(): Error {
  return new Error('code-index-workspace-router: bind an explicit Session workspace with codeIndex.forWorkspace(cwd)')
}

export default CodeIndexWorkspaceRouter
