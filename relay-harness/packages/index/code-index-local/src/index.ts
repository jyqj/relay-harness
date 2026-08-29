/**
 * Local filesystem Service Provider for the code-index capability.
 *
 * Assembles the layers behind `ctx.codeIndex` for one workspace: scanner
 * (`walkWorkspace` over include/exclude/gitignore stacks), incremental diff
 * (mtime+size fast path with hash confirmation), the parser-tier and generic
 * chunkers behind the five-stage pass (parse → resolve → write → dirty
 * propagation), the SQLite storage + hybrid retrieval stack, and — when
 * configured — the embedding tier whose queue drain and memoized query
 * embeddings feed the vector lane. The store path defaults under the Relay
 * Harness home with a per-workspace filename suffix; refresh concurrency
 * folds through the runtime's single in-flight pass.
 *
 * The tool-result invalidator and the optional recursive watcher both route
 * into the same folded pass; neither owns correctness — every search lazily
 * guarantees a fresh-enough medium, and the touch-driven invalidator covers
 * deployments where the watcher degraded.
 *
 * @module @relay-harness/rlh-code-index-local
 */

import { createHash } from 'node:crypto'
import { realpathSync, statSync } from 'node:fs'
import { Context, Service } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import CodeIndex from '@relay-harness/rlh-code-index'
import { bindCodeIndexWorkspace } from '@relay-harness/rlh-code-index'
import type {
  CodeIndexWorkspace,
  GraphExploreRequest,
  GraphExploreResult,
  CodeIndexManagementStatus,
  HydrateChunksRequest,
  HydrateChunksResult,
  IndexStatusReport,
  RefreshOptions,
  RefreshSummary,
  SearchRequest,
  SearchResult,
} from '@relay-harness/rlh-code-index'
import type { JournalMode } from '@relay-harness/rlh-code-index-sqlite'
import type {} from '@relay-harness/rlh-session'
import { resolveRlhHome } from '@relay-harness/rlh-home-paths'
import { DEFAULT_STALE_DEBOUNCE_MS, StaleInvalidator, toolResultStaleHandler } from './invalidate.ts'
import { TreeWatcher } from './watcher.ts'
import { LocalCodeIndexRuntime } from './provider.ts'
import type { LocalEmbeddingRuntimeConfig } from './provider.ts'

export { CODE_INDEX_METADATA_LAST_REFRESH } from './indexer.ts'
export {
  buildExclusionStack,
  composeFileUpsert,
  composeGenericUpsert,
  composeParsedUpsert,
  loadIndexedSnapshot,
  runRefreshPass,
  DEFAULT_PARSE_CONCURRENCY,
} from './indexer.ts'
export type { RefreshPassInputs, RefreshPassIo, RefreshPassOutcome } from './indexer.ts'
export { DEFAULT_HARD_EXCLUDES, DEFAULT_INCLUDE_PATTERNS, DEFAULT_SCAN_IO_CONCURRENCY, collectWorkspaceEntries, walkWorkspace } from './scanner.ts'
export type { ScanEntry, WorkspaceScan } from './scanner.ts'
export { exclusionFilterFromPatterns, inclusionMatcherFromPatterns, parseGitignoreRules, loadWorkspaceGitIgnore } from './gitignore.ts'
export type { PathExclusionFilter } from './gitignore.ts'
export { contentHash, contentHashFile, CONTENT_HASH_HEX_LENGTH } from './hash.ts'
export {
  clampTopKToTierCap,
  createQueryVectorCache,
  embedQueryVector,
  isLaneFailureReadError,
  mapSearchRequest,
  LocalCodeIndexRuntime,
  QUERY_VECTOR_CACHE_CAPACITY,
} from './provider.ts'
export type { LocalEmbeddingRuntimeConfig, LocalIndexRuntimeConfig, QueryVectorCache } from './provider.ts'
export {
  edgeConfidenceOf,
  exploreGraphAnswer,
  IMPACT_DECLARED,
  RELATIONS_DECLARED,
  SYMBOL_NOT_FOUND_PREFIX,
  TESTS_DECLARED,
  TRUNCATED_MAX_NODES,
  TRUNCATED_RESULT_LIMIT,
} from './explore.ts'
export type { ExploreGraphInput } from './explore.ts'
export { CYCLES_DECLARED, cycleSeverity, cyclesAnswer, DEFAULT_MAX_CYCLES, tarjanScc } from './cycles.ts'
export {
  DEAD_CODE_DECLARED,
  DEAD_CODE_REASON,
  DEAD_CODE_SCAN_FACTOR,
  DEAD_CODE_SCAN_MAX,
  deadCodeAnswer,
  deadCodeScanLimit,
  DEFAULT_MAX_DEAD_CODE,
} from './dead-code.ts'
export { planSnapshotDiff, confirmChangedByHash } from './diff.ts'
export { DEFAULT_HASH_CONCURRENCY } from './diff.ts'
export type { IndexedSnapshotRow, SnapshotPlan } from './diff.ts'
export { mapConcurrentOrdered } from './parallel.ts'
export {
  CHUNK_LINE_BUDGET,
  GENERIC_PARSER_CONFIDENCE,
  GENERIC_PARSER_TIER,
  decodeUtf8Strict,
  deriveLanguage,
  isTestFile,
  prepareFileDocument,
} from './chunker.ts'
export type { PreparedChunk, PreparedFileDocument } from './chunker.ts'
export { assertRetrievalThresholds, evaluateRetrieval, percentile95 } from './eval.ts'
export type {
  RetrievalEvalCase,
  RetrievalEvalCaseResult,
  RetrievalEvalReport,
  RetrievalEvalThresholds,
  RetrievalThresholdReport,
} from './eval.ts'
export { DEFAULT_STALE_DEBOUNCE_MS, StaleInvalidator, toolResultStaleHandler } from './invalidate.ts'
export { WATCHER_EVENT_DEBOUNCE_MS, TreeWatcher } from './watcher.ts'
export type { TreeWatcherState } from './watcher.ts'
export {
  DEFAULT_EMBED_DRAIN_LEASE_MS,
  DEFAULT_EMBED_DRAIN_RETRY_MS,
  EmbeddingClient,
  EmbedError,
  drainEmbedJobs,
  EMBED_ABORTED,
  EMBED_DIMENSION_MISMATCH,
  EMBED_INVALID_CREDENTIAL,
  EMBED_PROVIDER_ERROR,
  EMBED_RESPONSE_INVALID,
  EMBED_TIMEOUT,
} from './embed/index.ts'
export type {
  DrainEmbedJobsOptions,
  DrainEmbedJobsResult,
  DrainStopReason,
  EmbeddingClientOptions,
  EmbedResult,
} from './embed/index.ts'

/** Debounce default collapsing tool-result bursts into one stale pass. */
export const DEFAULT_DEBOUNCE_MS = DEFAULT_STALE_DEBOUNCE_MS

/** Default byte ceiling before a file records its row without chunks. */
export const DEFAULT_MAX_FILE_BYTES = 512_000

/** Default global dirty-propagation promotion budget per incremental pass. */
export const DEFAULT_DIRTY_PROPAGATION_MAX_FILES = 200

/** Default credential-ref: the environment variable carrying the embedding bearer key. */
export const DEFAULT_EMBEDDING_API_KEY_ENV = 'EMBEDDING_API_KEY'

/** Default texts packed into one embedding wire request. */
export const DEFAULT_EMBEDDING_BATCH_SIZE = 32

/** Default per-wire-request deadline for embedding calls (ms). */
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 30_000

/** Default hard per-request input cap for embedding calls. */
export const DEFAULT_EMBEDDING_MAX_INPUTS_PER_REQUEST = 16

/** Default scheduled prompt-token spend per drain. */
export const DEFAULT_EMBEDDING_MAX_PROMPT_TOKENS_PER_DRAIN = 200_000

/** Default jobs claimed per drain. */
export const DEFAULT_EMBEDDING_MAX_JOBS_PER_DRAIN = 256

/** Default vector lane RRF weight. */
export const DEFAULT_EMBEDDING_VECTOR_WEIGHT = 0.9

/** Default vector lane candidate cap. */
export const DEFAULT_EMBEDDING_VECTOR_TOP_K = 12

/** Default vector lane candidate-pool ceiling. */
export const DEFAULT_EMBEDDING_VECTOR_MAX_CANDIDATES = 2_000

/** Embedding tier configuration. Omitting `baseURL` or `model` removes the whole tier. */
export interface EmbeddingConfig {
  /** Credential-ref: environment variable naming the bearer key. Defaults to `EMBEDDING_API_KEY`. */
  apiKeyEnv?: string
  /** OpenAI-compatible embeddings endpoint base. */
  baseURL?: string
  /** Embedding model identity sent with every request. */
  model?: string
  /** Requested vector dimensionality; omit to lock onto the first reply. */
  dimensions?: number
  /** Texts packed into one wire request in the common case. Defaults to 32. */
  batchSize?: number
  /** Per-wire-request deadline in ms. Defaults to 30000. */
  timeoutMs?: number
  /** Hard per-request input cap. Defaults to 16. */
  maxInputsPerRequest?: number
  /** Scheduled prompt-token spend per drain. Defaults to 200000. */
  maxPromptTokensPerDrain?: number
  /** Jobs claimed per drain. Defaults to 256. */
  maxJobsPerDrain?: number
  /** Vector lane RRF weight (`0` mutes the lane). Defaults to 0.9. */
  vectorWeight?: number
  /** Vector lane candidate cap. Defaults to 12. */
  vectorTopK?: number
  /** Vector lane candidate-pool ceiling. Defaults to 2000. */
  vectorMaxCandidates?: number
}

/**
 * Derive the default store path for one workspace: `<rlhHome>/index/` plus a
 * filename keyed by the workspace real path's first twelve SHA-256 hex
 * characters, so two checkouts never overwrite each other's derived index.
 * @param workspaceRealPath - canonical absolute workspace path.
 * @param rlhHome - resolved Relay Harness home to place `index/` under.
 * @returns the defaulted dedicated database file path.
 */
export function defaultDatabasePath(workspaceRealPath: string, rlhHome: string = resolveRlhHome()): string {
  const digest = createHash('sha256').update(workspaceRealPath).digest('hex').slice(0, 12)
  return `${rlhHome}/index/code-index-${digest}.sqlite3`
}

interface ResolvedConfig {
  workspaceRoot: string
  databasePath: string
  journalMode: JournalMode
  excludePatterns: readonly string[]
  maxFileBytes: number
  debounceMs: number
  watcherEnabled: boolean
  dirtyPropagationMaxFiles: number
  embedding: LocalEmbeddingRuntimeConfig | undefined
}

/** Local provider configuration. */
export interface Config {
  /** Workspace root to scan; defaults to the process working directory. */
  workspaceRoot?: string
  /**
   * Dedicated SQLite file (or `:memory:`); defaults to
   * `<rlhHome>/index/code-index-<workspace-hash>.sqlite3`.
   */
  databasePath?: string
  /** SQLite journal mode. Defaults to `wal`. */
  journalMode?: JournalMode
  /** Extra `.gitignore`-syntax excludes stacked over hard excludes. */
  exclude?: string[]
  /** Byte ceiling before files record rows without chunks. Defaults to 512000. */
  maxFileBytes?: number
  /** Tool-result invalidation debounce in ms. Defaults to 500. */
  debounceMs?: number
  /** Opt-in recursive filesystem watcher. Defaults to false. */
  watcherEnabled?: boolean
  /**
   * Global budget on files promoted per incremental pass by dirty
   * propagation (export-surface change closure). Defaults to 200.
   */
  dirtyPropagationMaxFiles?: number
  /**
   * Embedding tier; omitting `baseURL` or `model` (or the whole section)
   * removes the vector lane, the drain, and vector status reporting.
   */
  embedding?: EmbeddingConfig
}

/**
 * Resolve the embedding tier configuration. Missing `baseURL` or `model` is
 * the documented off switch (the tier disappears as a whole); everything else
 * validates fail-loud so a broken knob fails at load, never mid-drain.
 * @param config - plugin-facing embedding section, or `undefined`.
 * @returns the fully resolved runtime configuration, or `undefined` when the tier is off.
 */
export function resolveEmbeddingConfig(config: EmbeddingConfig | undefined): LocalEmbeddingRuntimeConfig | undefined {
  if (config === undefined) return undefined
  const baseURL = config.baseURL?.trim() ?? ''
  const model = config.model?.trim() ?? ''
  if (baseURL === '' || model === '') return undefined
  const apiKeyEnv = config.apiKeyEnv ?? DEFAULT_EMBEDDING_API_KEY_ENV
  assertNonEmptyString('embedding.apiKeyEnv', apiKeyEnv)
  const dimensions = config.dimensions
  if (dimensions !== undefined && (!Number.isSafeInteger(dimensions) || dimensions < 1)) {
    throw new Error(`code-index-local: embedding dimensions ${String(dimensions)} is not a positive safe integer`)
  }
  const batchSize = config.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE
  const timeoutMs = config.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS
  const maxInputsPerRequest = config.maxInputsPerRequest ?? DEFAULT_EMBEDDING_MAX_INPUTS_PER_REQUEST
  const maxPromptTokensPerDrain = config.maxPromptTokensPerDrain ?? DEFAULT_EMBEDDING_MAX_PROMPT_TOKENS_PER_DRAIN
  const maxJobsPerDrain = config.maxJobsPerDrain ?? DEFAULT_EMBEDDING_MAX_JOBS_PER_DRAIN
  const vectorTopK = config.vectorTopK ?? DEFAULT_EMBEDDING_VECTOR_TOP_K
  const vectorMaxCandidates = config.vectorMaxCandidates ?? DEFAULT_EMBEDDING_VECTOR_MAX_CANDIDATES
  for (const [name, value] of [
    ['batchSize', batchSize],
    ['timeoutMs', timeoutMs],
    ['maxInputsPerRequest', maxInputsPerRequest],
    ['maxPromptTokensPerDrain', maxPromptTokensPerDrain],
    ['maxJobsPerDrain', maxJobsPerDrain],
    ['vectorTopK', vectorTopK],
    ['vectorMaxCandidates', vectorMaxCandidates],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`code-index-local: embedding ${name} ${String(value)} is not a positive safe integer`)
    }
  }
  const vectorWeight = config.vectorWeight ?? DEFAULT_EMBEDDING_VECTOR_WEIGHT
  if (!Number.isFinite(vectorWeight) || vectorWeight < 0) {
    throw new Error(`code-index-local: embedding vectorWeight ${String(vectorWeight)} is not a non-negative finite number`)
  }
  return {
    apiKeyEnv,
    baseURL,
    model,
    ...(dimensions === undefined ? {} : { dimensions }),
    batchSize,
    timeoutMs,
    maxInputsPerRequest,
    maxPromptTokensPerDrain,
    maxJobsPerDrain,
    vectorWeight,
    vectorTopK,
    vectorMaxCandidates,
  }
}

function resolveConfig(config: Config): ResolvedConfig {
  const workspaceRootRealPath = resolveWorkspaceRoot(config.workspaceRoot)
  const databasePath = config.databasePath ?? defaultDatabasePath(workspaceRootRealPath)
  assertNonEmptyString('databasePath', databasePath)
  // Numeric knobs were already fail-loud-validated by `validateSchemaConfig`.
  const exclude = config.exclude ?? []
  if (exclude.some(pattern => pattern.trim() === '')) {
    throw new Error('code-index-local: exclude entries must be non-empty pattern lines')
  }
  return {
    workspaceRoot: workspaceRootRealPath,
    databasePath,
    journalMode: config.journalMode ?? 'wal',
    excludePatterns: [...exclude],
    maxFileBytes: config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    debounceMs: config.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    watcherEnabled: config.watcherEnabled ?? false,
    dirtyPropagationMaxFiles: config.dirtyPropagationMaxFiles ?? DEFAULT_DIRTY_PROPAGATION_MAX_FILES,
    embedding: resolveEmbeddingConfig(config.embedding),
  }
}

/** Resolve and verify the scan root exists as a directory at load time. */
function resolveWorkspaceRoot(configured: string | undefined): string {
  const root = configured ?? process.cwd()
  try {
    const real = realpathSync(root)
    if (!statSync(real).isDirectory()) throw new Error('not a directory')
    return real
  } catch (error) {
    throw new Error(`code-index-local: workspaceRoot ${root} must be an existing directory (${(error as Error).message})`)
  }
}

function assertNonEmptyString(name: string, value: string): void {
  if (value.trim() === '') throw new Error(`code-index-local: ${name} must not be empty`)
}

/** Validate schemastery-provided numeric knobs against the second-layer rules. */
function validateSchemaConfig(maxFileBytes: number, debounceMs: number, dirtyPropagationMaxFiles: number): void {
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new Error(`code-index-local: validated maxFileBytes ${String(maxFileBytes)} is not a positive safe integer`)
  }
  if (!Number.isSafeInteger(debounceMs) || debounceMs < 1) {
    throw new Error(`code-index-local: validated debounceMs ${String(debounceMs)} is not a positive safe integer`)
  }
  if (!Number.isSafeInteger(dirtyPropagationMaxFiles) || dirtyPropagationMaxFiles < 1) {
    throw new Error(`code-index-local: validated dirtyPropagationMaxFiles ${String(dirtyPropagationMaxFiles)} is not a positive safe integer`)
  }
}

/**
 * Local provider plugin serving `ctx.codeIndex`.
 *
 * Load order places this after any store dependency; it declares no injected
 * services of its own — the sqlite retrieval face and search engine are plain
 * imports, and registrations (invalidation effect, optional watcher) scope to
 * this plugin fiber.
 */
export class CodeIndexLocal extends CodeIndex {
  static inject: string[] = []

  static Config: z<Config> = z.object({
    workspaceRoot: z.string(),
    databasePath: z.string(),
    journalMode: z.union(['wal', 'delete', 'truncate', 'persist'] as const).default('wal'),
    exclude: z.array(z.string()).default([]),
    maxFileBytes: z.number().step(1).min(1).default(DEFAULT_MAX_FILE_BYTES),
    debounceMs: z.number().step(1).min(1).default(DEFAULT_DEBOUNCE_MS),
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

  private readonly runtime: LocalCodeIndexRuntime
  private readonly resolved: ResolvedConfig
  private readonly invalidator: StaleInvalidator
  private readonly watcher: TreeWatcher

  constructor(ctx: Context, config: Config) {
    super(ctx)
    validateSchemaConfig(
      config.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      config.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      config.dirtyPropagationMaxFiles ?? DEFAULT_DIRTY_PROPAGATION_MAX_FILES,
    )
    this.resolved = resolveConfig(config)
    this.runtime = new LocalCodeIndexRuntime({
      workspaceRoot: this.resolved.workspaceRoot,
      databasePath: this.resolved.databasePath,
      journalMode: this.resolved.journalMode,
      excludePatterns: this.resolved.excludePatterns,
      maxFileBytes: this.resolved.maxFileBytes,
      dirtyPropagationMaxFiles: this.resolved.dirtyPropagationMaxFiles,
      ...(this.resolved.embedding === undefined ? {} : { embedding: this.resolved.embedding }),
    })
    // The rejection sink below runs only when a detached pass fails after the
    // triggering caller is gone; suites pin the fold itself at runtime level,
    // while the timer-dispatched closure escapes per-function coverage slots.
    /* v8 ignore next */
    this.invalidator = new StaleInvalidator(this.resolved.debounceMs, (paths) => {
      this.runtime.refresh({ reason: 'stale', ...(paths === undefined ? {} : { paths }) }).catch((error: unknown) => {
        ctx.logger.warn(`code-index-local: stale refresh failed: ${String(error)}`)
      })
    })
    this.watcher = new TreeWatcher(this.resolved.workspaceRoot, (paths) => {
      // Ignore-rule edits can affect arbitrary descendants, so they widen to
      // the authoritative full-tree diff instead of pretending to be local.
      this.invalidator.schedule(paths?.some(path => path.split('/').at(-1) === '.gitignore') === true ? undefined : paths)
    })
    const scheduleOnToolResult = toolResultStaleHandler(this.invalidator)
    ctx.on('session/event', (_session, event) => {
      scheduleOnToolResult(event)
    })
    ctx.effect(() => async () => {
      this.invalidator.dispose()
      this.watcher.dispose()
      await this.runtime.dispose()
    }, 'code-index-local.teardown')
  }

  protected async [Service.init](): Promise<void> {
    await this.runtime.ensureOpen()
    if (!this.resolved.watcherEnabled) return
    const state = await this.watcher.start()
    this.runtime.setWatcherDegraded(state === 'degraded')
  }

  /**
   * Bind the explicit single-workspace adapter, rejecting a Session whose
   * canonical cwd does not equal this provider's configured root. This keeps
   * headless deployments useful without letting a mismatched caller receive
   * another checkout's results.
   * @param workspaceRoot - caller-selected absolute workspace root.
   * @returns this provider behind a root-verified immutable face.
   */
  override forWorkspace(workspaceRoot: string): Promise<CodeIndexWorkspace> {
    const canonical = resolveWorkspaceRoot(workspaceRoot)
    if (canonical !== this.resolved.workspaceRoot) {
      throw new Error(
        `code-index-local: requested workspace ${canonical} does not match configured root ${this.resolved.workspaceRoot}`,
      )
    }
    return Promise.resolve(bindCodeIndexWorkspace(canonical, this))
  }

  override async status(): Promise<IndexStatusReport> {
    await this.runtime.ensureOpen()
    return this.runtime.status()
  }

  override async managementStatus(): Promise<CodeIndexManagementStatus> {
    await this.runtime.ensureOpen()
    return this.runtime.managementStatus()
  }

  override reconcile(): Promise<CodeIndexManagementStatus> {
    return this.runtime.reconcile()
  }

  override refresh(options?: RefreshOptions): Promise<RefreshSummary> {
    return this.runtime.refresh(options)
  }

  override async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult> {
    return this.runtime.search(request, signal)
  }

  override hydrateChunks(request: HydrateChunksRequest, signal?: AbortSignal): Promise<HydrateChunksResult> {
    return this.runtime.hydrateChunks(request, signal)
  }

  override async exploreGraph(request: GraphExploreRequest, signal?: AbortSignal): Promise<GraphExploreResult> {
    return this.runtime.exploreGraph(request, signal)
  }

  /**
   * Deterministic flush hook for tests: cancels any pending scheduled stale
   * pass and starts (or folds into) the refresh immediately. Deliberately
   * outside the abstract seam so production callers keep the debounced path.
   * @param options - forwarded to the folded pass when none is running.
   * @returns the summary of the flushed (or in-flight) refresh pass.
   */
  refreshInternal(options?: RefreshOptions): Promise<RefreshSummary> {
    this.invalidator.flushNow()
    return this.runtime.refresh(options)
  }

  /**
   * Deterministic flush hook for tests: resolves when no embedding drain is
   * in flight. Deliberately outside the abstract seam so production callers
   * keep the detached drain.
   */
  embedDrainIdle(): Promise<void> {
    return this.runtime.embedDrainIdle()
  }
}

export default CodeIndexLocal
