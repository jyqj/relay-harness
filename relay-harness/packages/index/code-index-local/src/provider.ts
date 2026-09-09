/**
 * Provider assembly: one admitted SQLite store, the tier-sized chunk-text
 * cache, the retrieval port, and the search engine bound together behind a
 * single lifecycle owner implementing `ctx.codeIndex` for local workspaces.
 * Searches run the graph-context path over the composed graph defaults; with
 * an empty graph the enrichment resolves nothing and the answer equals the
 * plain pipeline, so no availability probe is needed. Epochs ride into every
 * answer straight from the store ledger at answer time, so consumers can key
 * caches on the pair without extra coordination.
 *
 * With an embedding tier configured, this class also owns the vector data
 * path: every committed refresh enqueues its changed chunk rows and starts
 * one folded queue drain, and every search embeds its query text (memoized)
 * into the engine request so the vector lane can re-score the candidate pool.
 *
 * This class is also the fold point for refresh concurrency: concurrent
 * `refresh` / lazy-search callers share the single in-flight pass and receive
 * its committed summary, never speculative ones.
 *
 * @module @relay-harness/rlh-code-index-local/provider
 */

import { lstat, realpath, rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import {
  repoSizeTierFromFileCount,
  repoSizeTierGraphEnrichLimits,
  repoSizeTierSearchTopK,
  repoSizeTierTokenBudget,
} from '@relay-harness/rlh-code-index'
import type {
  BuildExplain,
  CodeIndexGenerationStatus,
  CodeIndexManagementStatus,
  GraphExploreRequest,
  GraphExploreResult,
  HydratedChunk,
  HydrateChunksRequest,
  HydrateChunksResult,
  IndexStatusReport,
  RepoSizeTier,
  RefreshOptions,
  RefreshReason,
  RefreshSummary,
  SearchRequest,
  SearchResult,
} from '@relay-harness/rlh-code-index'
import { createRetrievalPort, readEpochs } from '@relay-harness/rlh-code-index-sqlite'
import type { JournalMode } from '@relay-harness/rlh-code-index-sqlite'
import {
  ChunkTextCache,
  chunkRevisionsMissingGeneration,
  chunkTextCacheCapacityForTier,
  enqueueEmbedJobs,
  ensureEmbeddingGeneration,
  pendingEmbedCount,
  readVectorCoverage,
  resetFailedEmbedJobsForGeneration,
} from '@relay-harness/rlh-code-index-sqlite'
import { augmentedQueryText, createSearchEngine } from '@relay-harness/rlh-code-index-search'
import { createVectorLane } from '@relay-harness/rlh-code-index-search'
import type { EngineSearchRequest, RetrievalPort } from '@relay-harness/rlh-code-index-search'
import {
  DEFAULT_DIRTY_MAX_FILES,
  SymbolCatalog,
  catalogRowFromStored,
  createGraphResultCache,
  createSymbolResolver,
  defaultPreselectLayersWithGraphNeighbor,
  defaultRetrievalLanesWithGraph,
  searchWithGraphContext,
} from '@relay-harness/rlh-code-index-graph'
import type { SymbolResolver } from '@relay-harness/rlh-code-index-graph'
import { exploreGraphAnswer } from './explore.ts'
import type { ExploreGraphInput } from './explore.ts'
import { contentHash, contentHashFile } from './hash.ts'
import { EmbeddingClient } from './embed/client.ts'
import { EmbedError, EMBED_PROVIDER_ERROR, EMBED_RESPONSE_INVALID } from './embed/errors.ts'
import { drainEmbedJobs } from './embed/worker.ts'
import type { EmbedderLike } from './embed/worker.ts'
import type { DrainEmbedJobsResult } from './embed/worker.ts'
import { resolveEmbeddingGeneration } from './embed/generation.ts'
import { DEFAULT_INCLUDE_PATTERNS } from './scanner.ts'
import {
  buildExclusionStack,
  loadIndexedSnapshot,
  loadPersistedLastRefresh,
  openStore,
  persistLastRefresh,
  runRefreshPass,
} from './indexer.ts'

/** Resolved embedding-tier knobs; the runtime config carries them only when an endpoint is configured. */
export interface LocalEmbeddingRuntimeConfig {
  /** Environment variable naming the bearer credential for the endpoint. */
  readonly apiKeyEnv: string
  /** Endpoint base, treated as a prefix by the client. */
  readonly baseURL: string
  /** Embedding model identity sent with every request and stamped on jobs and vectors. */
  readonly model: string
  /** Requested vector dimensionality; omit to lock onto the first reply. */
  readonly dimensions?: number
  /** Texts packed into one wire request in the common case. */
  readonly batchSize: number
  /** Per-wire-request deadline in milliseconds. */
  readonly timeoutMs: number
  /** Hard per-request input cap. */
  readonly maxInputsPerRequest: number
  /** Upper bound on scheduled prompt-token spend per drain. */
  readonly maxPromptTokensPerDrain: number
  /** Upper bound on jobs claimed per drain. */
  readonly maxJobsPerDrain: number
  /** Vector lane RRF weight override. */
  readonly vectorWeight: number
  /** Vector lane candidate cap override. */
  readonly vectorTopK: number
  /** Vector lane candidate-pool ceiling override. */
  readonly vectorMaxCandidates: number
}

/** Resolved knobs consumed by every provider operation. */
export interface LocalIndexRuntimeConfig {
  /** Absolute workspace root to scan. */
  readonly workspaceRoot: string
  /** Dedicated store path or `:memory:`. */
  readonly databasePath: string
  /** Validated journal pragma forwarded to the opener. */
  readonly journalMode: JournalMode
  /** Explicit config exclusion pattern lines (`.gitignore` syntax). */
  readonly excludePatterns: readonly string[]
  /** Byte ceiling beyond which files record rows without chunks. */
  readonly maxFileBytes: number
  /** Global dirty-propagation promotion budget; defaults to {@link DEFAULT_DIRTY_MAX_FILES}. */
  readonly dirtyPropagationMaxFiles?: number
  /**
   * File-count classifier override for deterministic lifecycle tests. Product
   * composition omits it and always uses the reference tier thresholds.
   */
  readonly tierForFileCount?: (fileCount: number) => RepoSizeTier
  /**
   * Embedding tier configuration; `undefined` (or an endpoint missing its
   * `baseURL` / `model` anchor) removes the whole tier: no vector lane, no
   * drain, no vector status.
   */
  readonly embedding?: LocalEmbeddingRuntimeConfig
}

/**
 * Map the seam request onto the engine request: scope and recency lists pass
 * through unchanged so SQL-side scope filters see them verbatim.
 * @param request - model-shaped seam request.
 * @returns the engine request projection with its required query.
 */
export function mapSearchRequest(request: SearchRequest): { query: string } & Partial<EngineSearchRequest> {
  return {
    query: request.query,
    ...(request.pathPrefix !== undefined ? { pathPrefix: request.pathPrefix } : {}),
    ...(request.paths !== undefined ? { paths: [...request.paths] } : {}),
    ...(request.recentPaths !== undefined ? { recentPaths: [...request.recentPaths] } : {}),
    ...(request.boostFilePaths !== undefined ? { boostFilePaths: [...request.boostFilePaths] } : {}),
    ...(request.conversationQueries !== undefined ? { conversationQueries: [...request.conversationQueries] } : {}),
    ...(request.pinnedFilePaths !== undefined ? { pinnedFilePaths: [...request.pinnedFilePaths] } : {}),
    ...(request.overlayFilePaths !== undefined ? { overlayFilePaths: [...request.overlayFilePaths] } : {}),
  }
}

/**
 * Canonicalize a public refresh scope into unique workspace-relative POSIX
 * paths. A root path intentionally widens to a full scan; an escape is a
 * caller error rather than a reason to scan or remove unrelated rows.
 * @param workspaceRoot - absolute workspace boundary used for containment.
 * @param paths - public file/directory scope, or omitted for the full tree.
 * @returns normalized unique paths, `[]` for no files, or `undefined` for a full pass.
 */
export function normalizeRefreshPaths(
  workspaceRoot: string,
  paths: readonly string[] | undefined,
): readonly string[] | undefined {
  if (paths === undefined) return undefined
  const root = resolve(workspaceRoot)
  const normalized = new Set<string>()
  for (const path of paths) {
    const absolute = resolve(root, path)
    const within = relative(root, absolute)
    if (within.startsWith('..') || isAbsolute(within)) {
      throw new Error(`code-index refresh path escapes the workspace: ${path}`)
    }
    if (within.length === 0) return undefined
    normalized.add(within.split(sep).join('/'))
  }
  return [...normalized].sort()
}

/**
 * Merge refreshes that arrived after the active pass began scanning.
 * @param requests - queued trigger options in arrival order.
 * @returns one widened follow-up request, or `undefined` without queued work.
 */
export function mergeRefreshOptions(requests: readonly RefreshOptions[]): RefreshOptions | undefined {
  if (requests.length === 0) return undefined
  const reason: RefreshReason = requests.some(request => request.reason === 'stale')
    ? 'stale'
    : requests.some(request => request.reason === 'manual' || request.reason === undefined) ? 'manual' : 'lazy'
  const forceRebuild = requests.some(request => request.forceRebuild === true)
  if (forceRebuild || requests.some(request => request.paths === undefined)) {
    return { reason, ...(forceRebuild ? { forceRebuild: true } : {}) }
  }
  return { reason, paths: [...new Set(requests.flatMap(request => request.paths ?? []))].sort() }
}

/**
 * Clamp a requested hit count against one repository-size tier's cap. The
 * engine re-normalizes downstream; keeping the cap application here makes the
 * provider's mapping contract explicit and keeps an oversized model request
 * from even sizing lane budgets above the tier limit.
 * @param requested - model-requested top-K or `undefined`.
 * @param tier - repository-size tier resolved from the current file count.
 * @returns the clamped count, or `undefined` when no explicit request existed.
 */
export function clampTopKToTierCap(requested: number | undefined, tier: Parameters<typeof repoSizeTierSearchTopK>[0]): number | undefined {
  if (requested === undefined) return undefined
  return Math.min(Math.max(1, Math.trunc(requested)), repoSizeTierSearchTopK(tier))
}

/** Bounded memo capacity for query-text embeddings (most recent first served). */
export const QUERY_VECTOR_CACHE_CAPACITY = 32

/** Keyed memo of query-text → embedding lookups: `model:dimensions:text-hash`. */
export interface QueryVectorCache {
  /** @param key - memo key; @returns the cached vector, or `undefined` on miss. */
  get(key: string): Float32Array | undefined
  /** @param key - memo key. @param vector - embedding to store, evicting the oldest entry once full. */
  set(key: string, vector: Float32Array): void
  /** Current entry count. */
  readonly size: number
}

/**
 * Create the query-embedding memo. One search embeds its query text in
 * isolation; repeated queries (pagination, rephrasing around a stable core)
 * re-hit the endpoint without the memo. Keys hash the text
 * (`contentHash`) prefixed by the model and dimensionality, so a model or
 * dimension change can never serve a stale vector.
 * @param capacity - maximum entries; the oldest inserted entry evicts first.
 * @returns the memo.
 */
export function createQueryVectorCache(capacity: number = QUERY_VECTOR_CACHE_CAPACITY): QueryVectorCache {
  const entries = new Map<string, Float32Array>()
  return {
    get(key: string): Float32Array | undefined {
      const value = entries.get(key)
      if (value === undefined) return undefined
      entries.delete(key)
      entries.set(key, value)
      return value
    },
    set(key: string, vector: Float32Array): void {
      if (!entries.has(key) && entries.size >= capacity) {
        // Full and holding a new key: the oldest inserted entry evicts.
        entries.delete(entries.keys().next().value as string)
      }
      entries.delete(key)
      entries.set(key, vector)
    },
    get size(): number {
      return entries.size
    },
  }
}

/** Shape of a whole-lane abort as the engine records it (`<laneId> lane failed (...)`). */
const LANE_FAILED_READ_ERROR = /^\S+ lane failed \(/u

/**
 * Whether one engine read error names a whole-lane abort. Only these make the
 * runtime's degradation sticky: a lane failing means the store-side data that
 * lane reads is unusable for the moment, so status stays honest until a clean
 * operation proves otherwise. Per-read degradations — an unreachable query
 * embedder, a detail-fetch hiccup — are transient and must not pin
 * `status().degraded` after one bad operation.
 * @param message - one entry of `SearchResult.readErrors`.
 * @returns `true` when the message has the lane-failure shape.
 */
export function isLaneFailureReadError(message: string): boolean {
  return LANE_FAILED_READ_ERROR.test(message)
}

/**
 * Lease owner stamped onto every claim this runtime's drain makes: unique per
 * process and per runtime instance, so two workers (or two runtimes in one
 * process) never share a lease identity and a stale owner's late settlement is
 * refused instead of clobbering the live claimant's row.
 */
const EMBED_DRAIN_OWNER = `code-index-local-embed:${process.pid}:${randomBytes(3).toString('hex')}`

/**
 * Embed one query text through the memo: a cache hit skips the endpoint
 * entirely, a miss embeds the single text and memoizes it. The memo key
 * prefixes the model and dimensionality to the text hash, so a configuration
 * change can never serve a stale vector under a hot query. Exported beside
 * the drain for the same reason the drain is: the caller composes it with its
 * embedder, and tests inject one.
 * @param client - the endpoint client (any {@link EmbedderLike}).
 * @param text - the query text to embed.
 * @param cache - the memo created by {@link createQueryVectorCache}.
 * @param identity - model and dimensionality prefixing the memo key.
 * @param signal - caller cancellation fused into the request's deadline.
 * @returns the query vector for the vector lane.
 * @throws {EmbedError} when the endpoint fails or returns no vector for the
 *   query — the caller degrades this answer instead of fabricating a
 *   vectorless contribution.
 */
export async function embedQueryVector(
  client: EmbedderLike,
  text: string,
  cache: QueryVectorCache,
  identity: { readonly model: string; readonly dimensions?: number },
  signal?: AbortSignal,
): Promise<Float32Array> {
  const key = `${identity.model}:${identity.dimensions ?? 'auto'}:${contentHash(text)}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const { vectors } = await client.embed([text], signal)
  const [vector] = vectors
  if (vector === undefined) {
    throw new EmbedError('the embedding endpoint returned no vector for the query', EMBED_RESPONSE_INVALID)
  }
  cache.set(key, vector)
  return vector
}

/** Durable shape stored under the `last_refresh` metadata key. */
interface PersistedRefreshRecord {
  readonly reason: RefreshReason
  readonly changedFiles: number
  readonly removedFiles: number
  readonly chunksWritten: number
  readonly durationMs: number
  readonly epochsAfter: { indexEpoch: number; evidenceEpoch: number; embeddingEpoch?: number }
  readonly explain?: BuildExplain
}

function reviveBuildExplain(raw: unknown): BuildExplain | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const value = raw as Partial<BuildExplain>
  if ((value.scope !== 'full' && value.scope !== 'scoped')
    || (value.pass !== 'ran' && value.pass !== 'skipped')
    || typeof value.requestedPaths !== 'number'
    || typeof value.degraded !== 'boolean'
    || !Array.isArray(value.degradationReasons)
    || !value.degradationReasons.every(reason => typeof reason === 'string')) return undefined
  return value as BuildExplain
}

/**
 * Rebuild a seam {@link RefreshSummary} from persisted JSON.
 * @param raw - parsed JSON payload recovered from the metadata ledger.
 * @returns the summary, or `undefined` when any field is missing or mistyped —
 *   a damaged side ledger only suppresses cross-restart reporting, never indexing.
 */
export function revivePersistedRecord(raw: unknown): RefreshSummary | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const candidate = raw as Partial<PersistedRefreshRecord>
  const epochsAfter = candidate.epochsAfter
  const explain = candidate.explain === undefined ? undefined : reviveBuildExplain(candidate.explain)
  if (
    typeof candidate.reason !== 'string'
    || typeof candidate.changedFiles !== 'number'
    || typeof candidate.removedFiles !== 'number'
    || typeof candidate.chunksWritten !== 'number'
    || typeof candidate.durationMs !== 'number'
    || epochsAfter === undefined
    || typeof epochsAfter.indexEpoch !== 'number'
    || typeof epochsAfter.evidenceEpoch !== 'number'
    || !isRefreshReason(candidate.reason)
  ) return undefined
  return {
    reason: candidate.reason,
    changedFiles: candidate.changedFiles,
    removedFiles: candidate.removedFiles,
    chunksWritten: candidate.chunksWritten,
    durationMs: candidate.durationMs,
    epochsAfter: {
      indexEpoch: epochsAfter.indexEpoch,
      evidenceEpoch: epochsAfter.evidenceEpoch,
      ...(typeof epochsAfter.embeddingEpoch === 'number' ? { embeddingEpoch: epochsAfter.embeddingEpoch } : {}),
    },
    ...(explain === undefined ? {} : { explain }),
  }
}

const REFRESH_REASONS: readonly RefreshReason[] = ['manual', 'stale', 'lazy']

/** Type-guard narrowing a persisted reason string back onto the seam union. */
function isRefreshReason(value: unknown): value is RefreshReason {
  return REFRESH_REASONS.includes(value as RefreshReason)
}

type BoundSearch = (request: EngineSearchRequest) => SearchResult

type SourceVerification =
  | { readonly state: 'verified' }
  | { readonly state: 'stale'; readonly reason: 'source-revision-changed' }
  | { readonly state: 'unavailable'; readonly reason: 'source-path-invalid' | 'source-unavailable' }

type EmbeddingBuildExplain = NonNullable<BuildExplain['embedding']>

/**
 * Owns every mutable piece of the local code-index capability: the store
 * handle, cache/port/engine assembly, the last-refresh report, degradation
 * tracking, and the single in-flight refresh controller.
 */
export class LocalCodeIndexRuntime {
  private db: DatabaseSync | undefined
  private port: RetrievalPort | undefined
  private engineSearch: BoundSearch | undefined
  private exclusions: Awaited<ReturnType<typeof buildExclusionStack>> = []
  private closed = false
  private lastRefresh: RefreshSummary | undefined
  private generationCommitted = false
  private operationDegraded = false
  private watcherDegradedFlag = false
  private currentTier: RepoSizeTier | undefined = undefined
  private inFlight: Promise<RefreshSummary> | undefined
  private inFlightPassStarted = false
  private queuedRefreshes: RefreshOptions[] = []
  private resolver: SymbolResolver | undefined
  private embedderSlot: { readonly client: EmbeddingClient } | { readonly failure: EmbedError } | undefined
  private readonly queryVectorCache: QueryVectorCache = createQueryVectorCache()
  private drainInFlight: Promise<void> | undefined
  private drainAbort: AbortController | undefined
  /** A reconcile committed while the worker was active; guarantees one post-drain queue observation. */
  private drainRescheduleRequested = false
  private lastEmbedError: string | undefined

  constructor(private readonly config: LocalIndexRuntimeConfig) {}

  /**
   * Open-or-create the derived store, load the exclusion stack, and bind the
   * retrieval stack sized by whatever the store already holds.
   */
  async ensureOpen(): Promise<void> {
    if (this.closed) throw new Error('code-index-local runtime is disposed')
    if (this.db !== undefined) return
    const store = await openStore(this.config.databasePath, this.config.journalMode)
    this.db = store.db
    this.exclusions = await buildExclusionStack(this.config.workspaceRoot, this.config.excludePatterns)
    // A probe answers the very first tier question; the bound stack is built
    // once here with that capacity instead of shipping a placeholder cache.
    const probeCount = createRetrievalPort(store.db).countFiles()
    this.currentTier = this.tierForFileCount(probeCount)
    const persisted = loadPersistedLastRefresh(store.db, revivePersistedRecord)
    if (persisted !== undefined) this.lastRefresh = persisted
    this.bindResolutionStack()
    this.bindRetrievalStack()
    if (this.config.embedding !== undefined && probeCount > 0) this.reconcileEmbeddings(this.config.embedding)
  }

  /**
   * Bind the resolver over a long-lived catalog. The catalog intentionally
   * outlives single passes: passes evict the batch's paths (removals plus
   * rewrites) before resolving, and the lazy loader re-reads only files the
   * catalog does not already hold — so unchanged third-party files load once
   * for the runtime's lifetime.
   */
  private bindResolutionStack(): void {
    const catalog = new SymbolCatalog()
    this.resolver = createSymbolResolver({
      catalog,
      loadSymbolsForFiles: (files) => {
        this.loadCatalogFiles(catalog, files)
      },
    })
  }

  /**
   * Bound alongside the store handle: {@link bindResolutionStack} always runs
   * before the handle becomes visible to callers, so a live db implies a live
   * resolver. The pairing is a construction invariant, not a runtime branch.
   */
  private requireResolver(): SymbolResolver {
    this.requireDb()
    return this.resolver as SymbolResolver
  }

  /** Lazy-load hook: register the committed symbol rows of files the catalog lacks. */
  private loadCatalogFiles(catalog: SymbolCatalog, files: readonly string[]): void {
    const missing = files.filter(file => !catalog.byFile.has(file))
    if (missing.length === 0) return
    const rows = this.requirePort().graph.symbolsByFilePaths(missing)
    if (rows.length > 0) catalog.addSymbols(rows.map(catalogRowFromStored))
  }

  /**
   * Bind cache capacity plus port plus engine to the resolved current tier.
   * The engine assembles the composed graph defaults (graph lane in its
   * reserved position, vector lane appended when an embedding tier is
   * configured, graph neighbor layer after fallback), and every search runs
   * the graph-context path — with an empty graph it degenerates to the plain
   * result, so no availability probe is needed. The graph result cache is
   * bound to this stack: a tier resize rebuilds the engine, so the cache must
   * be dropped with it (its key covers epochs/request vector fingerprint/
   * limits/ranking, not engine config).
   */
  private bindRetrievalStack(): void {
    const db = this.db as DatabaseSync
    const tier = this.currentTier as RepoSizeTier
    const port = createRetrievalPort(db, { cache: new ChunkTextCache(chunkTextCacheCapacityForTier(tier)) })
    this.port = port
    const embedding = this.config.embedding
    const generation = embedding === undefined ? undefined : resolveEmbeddingGeneration(embedding)
    const engine = createSearchEngine({
      port,
      lanes: defaultRetrievalLanesWithGraph(
        generation === undefined ? undefined : createVectorLane({ generationId: generation.generationId }),
      ),
      layers: defaultPreselectLayersWithGraphNeighbor(),
      ...(embedding === undefined ? {} : {
        cfg: {
          vectorWeight: embedding.vectorWeight,
          vectorTopK: embedding.vectorTopK,
          vectorMaxCandidates: embedding.vectorMaxCandidates,
        },
      }),
      resolveEpochs: () => readEpochs(db),
    })
    const graphCache = createGraphResultCache()
    this.engineSearch = (request: EngineSearchRequest) => searchWithGraphContext({
      engine,
      port,
      request,
      epochs: readEpochs(db),
      limits: repoSizeTierGraphEnrichLimits(tier),
      tokenBudget: repoSizeTierTokenBudget(tier),
      cache: graphCache,
    }).result
  }

  private requireDb(): DatabaseSync {
    if (this.closed) throw new Error('code-index-local runtime is disposed')
    if (this.db === undefined) throw new Error('code-index-local runtime has no open store')
    return this.db
  }

  /**
   * Bound alongside the store handle: {@link bindRetrievalStack} always runs
   * before the handle becomes visible to callers, so a live db implies a live
   * port. The pairing is a construction invariant, not a runtime branch.
   */
  private requirePort(): RetrievalPort {
    this.requireDb()
    return this.port as RetrievalPort
  }

  /** Resolve one stored relative path without allowing a derived row to escape the workspace. */
  private sourcePath(filePath: string): string | undefined {
    const absolute = resolve(this.config.workspaceRoot, filePath)
    const within = relative(this.config.workspaceRoot, absolute)
    if (within.length === 0 || within.startsWith('..') || isAbsolute(within)) return undefined
    return absolute
  }

  /** Re-hash one current backing file and compare it with the indexed revision. */
  private async verifySourceRevision(
    filePath: string,
    expectedHash: string,
    signal?: AbortSignal,
  ): Promise<SourceVerification> {
    const absolute = this.sourcePath(filePath)
    if (absolute === undefined) return { state: 'unavailable', reason: 'source-path-invalid' }
    try {
      signal?.throwIfAborted()
      const [canonicalRoot, canonicalSource] = await Promise.all([
        realpath(this.config.workspaceRoot),
        realpath(absolute),
      ])
      const canonicalWithin = relative(canonicalRoot, canonicalSource)
      if (canonicalWithin.length === 0 || canonicalWithin.startsWith('..') || isAbsolute(canonicalWithin)) {
        return { state: 'unavailable', reason: 'source-path-invalid' }
      }
      const before = await lstat(canonicalSource)
      if (!before.isFile()) return { state: 'unavailable', reason: 'source-unavailable' }
      const observedHash = await contentHashFile(canonicalSource)
      signal?.throwIfAborted()
      const after = await lstat(canonicalSource)
      if (!after.isFile()) return { state: 'unavailable', reason: 'source-unavailable' }
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || observedHash !== expectedHash) {
        return { state: 'stale', reason: 'source-revision-changed' }
      }
      return { state: 'verified' }
    } catch (_error) {
      signal?.throwIfAborted()
      return { state: 'unavailable', reason: 'source-unavailable' }
    }
  }

  /**
   * File count through the port — the same number that resolves every tier.
   * @returns the current committed file count.
   */
  indexedFileCount(): number {
    return this.requirePort().countFiles()
  }

  /**
   * Report index health without side effects.
   * @returns the model-facing health snapshot for the derived medium.
   */
  status(): IndexStatusReport {
    const epochs = readEpochs(this.requireDb())
    const fileCount = this.indexedFileCount()
    return {
      indexedFileCount: fileCount,
      tier: this.requireTier(),
      epochs,
      ...(this.lastRefresh === undefined ? {} : { lastRefresh: this.lastRefresh }),
      degraded: this.operationDegraded || this.watcherDegradedFlag,
    }
  }

  /** Build operator health without mutation.
   * @returns bounded file/chunk/generation/job health.
   */
  managementStatus(): CodeIndexManagementStatus {
    const db = this.requireDb()
    const base = this.status()
    const chunkCount = (db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number }).n
    const generations = db.prepare(`
      SELECT g.generation_id AS generationId, g.provider_id AS providerId,
        g.endpoint_identity AS endpointIdentity, g.model,
        g.dimension_mode AS dimensionMode, g.configured_dimensions AS configuredDimensions,
        (SELECT COUNT(*) FROM chunks_vec v WHERE v.generation_id = g.generation_id) AS vectorizedChunks,
        (SELECT COUNT(*) FROM code_embed_jobs j WHERE j.generation_id = g.generation_id AND j.status = 'pending') AS pendingJobs,
        (SELECT COUNT(*) FROM code_embed_jobs j WHERE j.generation_id = g.generation_id AND j.status = 'running') AS runningJobs,
        (SELECT COUNT(*) FROM code_embed_jobs j WHERE j.generation_id = g.generation_id AND j.status = 'failed') AS failedJobs,
        (SELECT last_error FROM code_embed_jobs j WHERE j.generation_id = g.generation_id
          AND last_error IS NOT NULL ORDER BY updated_at DESC LIMIT 1) AS lastError
      FROM embedding_generations g ORDER BY g.created_at DESC, g.generation_id ASC
    `).all() as unknown as Array<Omit<CodeIndexGenerationStatus, 'lastError'> & { lastError: string | null }>
    return {
      ...base,
      chunkCount,
      generations: generations.map(row => ({
        ...row,
        ...(row.lastError === null ? { lastError: undefined } : { lastError: row.lastError.slice(0, 2_000) }),
      })).map(({ lastError, ...row }) => lastError === undefined ? row : { ...row, lastError }),
      ...(this.lastEmbedError === undefined ? {} : { lastError: this.lastEmbedError.slice(0, 2_000) }),
    }
  }

  /** Reconcile generation coverage and drain bounded work.
   * @returns settled management status.
   */
  async reconcile(): Promise<CodeIndexManagementStatus> {
    await this.ensureOpen()
    if (this.config.embedding !== undefined) this.reconcileEmbeddings(this.config.embedding)
    await this.embedDrainIdle()
    return this.managementStatus()
  }

  /**
   * Recorded by the owning plugin when the optional watcher fails at startup or during use.
   * @param degraded - whether watcher events can no longer arrive.
   */
  setWatcherDegraded(degraded: boolean): void {
    this.watcherDegradedFlag = degraded
  }

  /**
   * Run one refresh pass, folding concurrent callers into the in-flight one.
   * @param options - trigger reason and/or forced rebuild.
   * @returns what changed and the epoch pair observed after the commit.
   */
  refresh(options?: RefreshOptions): Promise<RefreshSummary> {
    if (this.inFlight !== undefined) {
      if (this.inFlightPassStarted) this.queuedRefreshes.push(options ?? {})
      return this.inFlight
    }
    const reason: RefreshReason = options?.reason ?? 'manual'
    const pass = this.runPass(reason, options)
      .then(({ summary, changedPaths }) => {
        this.generationCommitted = true
        this.resizeToCurrentTier()
        const embedding = this.catchUpEmbeddings(changedPaths)
        const completedSummary: RefreshSummary = {
          ...summary,
          explain: {
            ...summary.explain as BuildExplain,
            embedding,
            degraded: summary.explain?.degraded === true || this.lastEmbedError !== undefined,
            degradationReasons: this.lastEmbedError === undefined
              ? summary.explain?.degradationReasons ?? []
              : [...new Set([...(summary.explain?.degradationReasons ?? []), 'embedding-unavailable'])],
          },
        }
        this.lastRefresh = completedSummary
        persistLastRefresh(this.requireDb(), {
          ...completedSummary,
        })
        return completedSummary
      })
      .finally(() => {
        this.inFlight = undefined
        this.inFlightPassStarted = false
        const queued = mergeRefreshOptions(this.queuedRefreshes)
        this.queuedRefreshes = []
        if (queued !== undefined && !this.closed) {
          void this.refresh(queued).catch(() => {
            this.operationDegraded = true
          })
        }
      })
    this.inFlight = pass
    return pass
  }

  /** Rebuild the port when a commit moved the repository across tiers. */
  private resizeToCurrentTier(): void {
    const nextTier = this.tierForFileCount(this.requirePort().countFiles())
    if (this.currentTier === nextTier) return
    this.currentTier = nextTier
    this.bindRetrievalStack()
  }

  /** Resolve the configured test seam or the unchanged production classifier. */
  private tierForFileCount(fileCount: number): RepoSizeTier {
    return this.config.tierForFileCount?.(fileCount) ?? repoSizeTierFromFileCount(fileCount)
  }

  /** Return the tier whose cache and retrieval stack are currently bound. */
  private requireTier(): RepoSizeTier {
    if (this.currentTier === undefined) throw new Error('code-index-local retrieval tier is not bound')
    return this.currentTier
  }

  /**
   * Construct the endpoint's client on first use, memoizing the outcome. A
   * refused credential is deterministic, so its diagnosis memoizes too: every
   * later operation degrades with the same message instead of re-reading the
   * environment.
   * @param embedding - the resolved embedding configuration.
   * @returns the usable client, or the deterministic construction failure.
   */
  private resolveEmbedder(embedding: LocalEmbeddingRuntimeConfig):
    { readonly client: EmbeddingClient } | { readonly failure: EmbedError } {
    if (this.embedderSlot !== undefined) return this.embedderSlot
    try {
      this.embedderSlot = {
        client: new EmbeddingClient({
          baseURL: embedding.baseURL,
          apiKey: process.env[embedding.apiKeyEnv] ?? '',
          model: embedding.model,
          ...(embedding.dimensions === undefined ? {} : { dimensions: embedding.dimensions }),
          batchSize: embedding.batchSize,
          timeoutMs: embedding.timeoutMs,
          maxInputsPerRequest: embedding.maxInputsPerRequest,
        }),
      }
    } catch (error) {
      // EmbeddingClient refuses unusable credentials with EmbedError only; the
      // fallback keeps the memo total should a future failure escape that
      // contract.
      /* v8 ignore next 3 */
      this.embedderSlot = {
        failure: error instanceof EmbedError ? error : new EmbedError(String(error), EMBED_PROVIDER_ERROR),
      }
    }
    return this.embedderSlot
  }

  /**
   * Commit-side embedding catch-up: enqueue the just-committed batch's chunk
   * rows (chunk ids joined with their files' content hashes) and start one
   * drain, folding into the in-flight one. Never throws into the refresh
   * caller — the pass is already committed, and the next pass re-enqueues
   * idempotently.
   * @param changedPaths - workspace-relative paths this pass upserted.
   */
  private catchUpEmbeddings(changedPaths: readonly string[]): EmbeddingBuildExplain | null {
    const embedding = this.config.embedding
    if (embedding === undefined) return null
    void changedPaths
    return this.reconcileEmbeddings(embedding)
  }

  /** Reconcile the current chunk set against one complete embedding generation. */
  private reconcileEmbeddings(embedding: LocalEmbeddingRuntimeConfig): EmbeddingBuildExplain {
    const generation = resolveEmbeddingGeneration(embedding)
    let missingChunks = 0
    let jobsEnqueued = 0
    let jobsDeduplicated = 0
    let jobsReset = 0
    try {
      const db = this.requireDb()
      ensureEmbeddingGeneration(db, generation)
      jobsReset = resetFailedEmbedJobsForGeneration(db, generation.generationId)
      const targets = chunkRevisionsMissingGeneration(db, generation.generationId)
      missingChunks = targets.length
      if (targets.length > 0) {
        const queued = enqueueEmbedJobs(
          db,
          targets.map(target => ({
            chunkId: target.chunkId,
            generationId: generation.generationId,
            model: embedding.model,
            contentHash: target.contentHash,
          })),
        )
        jobsEnqueued = queued.enqueued
        jobsDeduplicated = queued.duplicates
      }
    } catch (error) {
      // A storage failure between reading the batch's chunk rows and
      // enqueueing them cannot be provoked in-process (same synchronous
      // handle); recording it and still draining keeps the committed refresh
      // intact, and the next pass re-enqueues idempotently.
      /* v8 ignore next */
      this.lastEmbedError = String(error)
      this.applyDrainFailure('embedding-reconcile-failed')
    }
    this.scheduleEmbedDrain(embedding, missingChunks > 0 || jobsReset > 0)
    return {
      generationId: generation.generationId,
      missingChunks,
      jobsEnqueued,
      jobsDeduplicated,
      jobsReset,
      batchesClaimed: 0,
      batchesWritten: 0,
      jobsCompleted: 0,
      jobsFailed: 0,
    }
  }

  /**
   * Fold catch-up into one worker without losing an enqueue that races the
   * worker's final empty claim. A busy worker normally observes new rows in
   * its loop; the reschedule bit supplies the missing post-drain observation
   * when commit lands after that last claim but before `finally` clears the
   * single-flight promise.
   */
  private scheduleEmbedDrain(embedding: LocalEmbeddingRuntimeConfig, queueMayHaveChanged: boolean): void {
    if (this.drainInFlight !== undefined) {
      if (queueMayHaveChanged) this.drainRescheduleRequested = true
      return
    }
    this.drainInFlight = this.runEmbedDrain(embedding).finally(() => {
      this.drainInFlight = undefined
      const rerun = this.drainRescheduleRequested
      this.drainRescheduleRequested = false
      if (rerun && !this.closed && this.db !== undefined) this.scheduleEmbedDrain(embedding, false)
    })
  }

  /**
   * Drain the embedding queue to the configured budgets. Failures are
   * recorded for {@link vectorStatus}, never thrown: the drain runs detached
   * from the refresh that scheduled it.
   * @param embedding - the resolved embedding configuration.
   */
  private async runEmbedDrain(embedding: LocalEmbeddingRuntimeConfig): Promise<void> {
    const controller = new AbortController()
    this.drainAbort = controller
    try {
      const slot = this.resolveEmbedder(embedding)
      if ('failure' in slot) throw slot.failure
      const result = await drainEmbedJobs({
        db: this.requireDb(),
        client: slot.client,
        owner: EMBED_DRAIN_OWNER,
        generationId: resolveEmbeddingGeneration(embedding).generationId,
        batchSize: Math.min(embedding.batchSize, embedding.maxInputsPerRequest),
        maxJobs: embedding.maxJobsPerDrain,
        maxPromptTokens: embedding.maxPromptTokensPerDrain,
        signal: controller.signal,
      })
      this.lastEmbedError = undefined
      this.applyDrainExplain(result)
    } catch (error) {
      // Background drain: nothing above it can retry. Deterministic failures
      // re-throw from every drain, so each pass re-records the diagnosis;
      // transient ones settle through the queue's attempt budget.
      this.lastEmbedError = String(error)
      this.applyDrainFailure('embedding-drain-failed')
    } finally {
      // Single-flight scheduling guarantees no newer drain replaced ours.
      this.drainAbort = undefined
    }
  }

  private applyDrainExplain(result: DrainEmbedJobsResult): void {
    const summary = this.lastRefresh
    const explain = summary?.explain
    const embedding = explain?.embedding
    if (summary === undefined || explain === undefined || embedding === null || embedding === undefined) return
    this.lastRefresh = {
      ...summary,
      epochsAfter: readEpochs(this.requireDb()),
      explain: {
        ...explain,
        degraded: explain.degraded || result.jobsFailed > 0,
        degradationReasons: result.jobsFailed > 0
          ? [...new Set([...explain.degradationReasons, 'embedding-jobs-failed'])]
          : explain.degradationReasons,
        embedding: {
          ...embedding,
          batchesClaimed: result.batchesClaimed,
          batchesWritten: result.batchesWritten,
          jobsCompleted: result.jobsCompleted,
          jobsFailed: result.jobsFailed,
        },
      },
    }
    persistLastRefresh(this.requireDb(), { ...this.lastRefresh })
  }

  private applyDrainFailure(reason: string): void {
    const summary = this.lastRefresh
    if (summary?.explain === undefined) return
    this.lastRefresh = {
      ...summary,
      explain: {
        ...summary.explain,
        degraded: true,
        degradationReasons: [...new Set([...summary.explain.degradationReasons, reason])],
      },
    }
  }

  /**
   * Resolve when no embedding drain is in flight. Deterministic flush hook
   * for tests and graceful callers; the refresh path never awaits it.
   */
  async embedDrainIdle(): Promise<void> {
    // A completion may schedule the lost-wakeup follow-up in its `finally`;
    // loop over the current identity until no generation remains.
    while (this.drainInFlight !== undefined) await this.drainInFlight
  }

  /**
   * Internal vector-tier projection (the seam status report stays
   * untouched): coverage of the configured model, backlog depth, and the
   * last drain failure, if any.
   * @returns the projection, or `undefined` without an embedding tier.
   */
  vectorStatus(): {
    generationId: string
    model: string
    pendingJobs: number
    vectorizedChunks: number
    totalChunks: number
    lastDrainError?: string
  } | undefined {
    const embedding = this.config.embedding
    if (embedding === undefined) return undefined
    const db = this.requireDb()
    const generation = resolveEmbeddingGeneration(embedding)
    const coverage = readVectorCoverage(db, generation.generationId)
    const status = {
      generationId: generation.generationId,
      model: embedding.model,
      pendingJobs: pendingEmbedCount(db, generation.generationId),
      vectorizedChunks: coverage.vectorizedChunks,
      totalChunks: coverage.totalChunks,
    }
    return this.lastEmbedError === undefined ? status : { ...status, lastDrainError: this.lastEmbedError }
  }

  /** Execute exactly one scan-diff-commit cycle; caller holds exclusivity. */
  private async runPass(reason: RefreshReason, options?: RefreshOptions): Promise<{
    summary: RefreshSummary
    changedPaths: readonly string[]
  }> {
    await this.ensureOpen()
    const startedAt = Date.now()
    const forceRebuild = options?.forceRebuild === true
    if (forceRebuild) {
      await this.resetStore()
      await this.ensureOpen()
    }
    const db = this.requireDb()
    const previousGeneration = forceRebuild ? new Map() : loadIndexedSnapshot(db)
    const paths = normalizeRefreshPaths(this.config.workspaceRoot, options?.paths)
    this.inFlightPassStarted = true
    const outcome = await runRefreshPass({
      db,
      workspaceRoot: this.config.workspaceRoot,
      includePatterns: DEFAULT_INCLUDE_PATTERNS,
      exclusionFilters: this.exclusions,
      maxFileBytes: this.config.maxFileBytes,
      previousGeneration,
      ...(paths === undefined ? {} : { paths }),
      graph: this.requirePort().graph,
      resolver: this.requireResolver(),
      dirtyMaxFiles: this.config.dirtyPropagationMaxFiles ?? DEFAULT_DIRTY_MAX_FILES,
    })
    return {
      summary: {
        reason,
        changedFiles: outcome.changedFiles,
        removedFiles: outcome.removedFiles,
        chunksWritten: outcome.chunksWritten,
        durationMs: Date.now() - startedAt,
        epochsAfter: readEpochs(db),
        explain: {
          scope: paths === undefined ? 'full' : 'scoped',
          requestedPaths: paths?.length ?? 0,
          pass: outcome.skipped ? 'skipped' : 'ran',
          degraded: outcome.dirty?.partial === true || outcome.dirty?.budgetExceeded === true,
          degradationReasons: [
            ...(outcome.dirty?.partial === true ? ['dirty-partial'] : []),
            ...(outcome.dirty?.budgetExceeded === true ? ['dirty-budget-exceeded'] : []),
          ],
          dirty: outcome.dirty === null ? null : {
            status: outcome.dirty.status,
            marked: outcome.dirty.marked,
            roundsRun: outcome.dirty.roundsRun,
            partial: outcome.dirty.partial,
            budgetExceeded: outcome.dirty.budgetExceeded,
          },
          embedding: null,
        },
      },
      changedPaths: outcome.changedPaths,
    }
  }

  /**
   * Drop every derived byte and reopen: the rebuild route for
   * `forceRebuild`, which deletes the database file rather than migrating.
   * Any folding callers stay parked on the shared promise meanwhile.
   */
  private async resetStore(): Promise<void> {
    const previous = this.db
    this.drainAbort?.abort()
    this.drainRescheduleRequested = false
    this.db = undefined
    this.port = undefined
    this.engineSearch = undefined
    this.resolver = undefined
    this.generationCommitted = false
    previous?.close()
    if (this.config.databasePath !== ':memory:') {
      for (const suffix of ['', '-wal', '-shm']) {
        await rm(`${this.config.databasePath}${suffix}`, { force: true })
      }
    }
  }

  /**
   * Batch-resolve full chunk bodies and re-hash each distinct backing file.
   * Bodies from missing rows, unreadable files, or watcher-lagged revisions
   * never enter `chunks`; callers receive a stable rejection instead.
   * @param request - ordered chunk identities to resolve.
   * @param signal - cancellation checked around every filesystem read.
   * @returns source-verified chunks and explicit stale/unavailable rejects.
   */
  async hydrateChunks(request: HydrateChunksRequest, signal?: AbortSignal): Promise<HydrateChunksResult> {
    signal?.throwIfAborted()
    await this.ensureOpen()
    if (!this.generationCommitted || this.requirePort().countFiles() === 0) {
      await this.refresh({ reason: 'lazy' })
    }
    const chunkIds = [...new Set(request.chunkIds)]
    const rows = this.requirePort().chunkRowsByIds(chunkIds)
    signal?.throwIfAborted()
    const byId = new Map(rows.map(row => [row.chunkId, row]))
    const verificationByFile = new Map<string, SourceVerification>()
    const chunks: HydratedChunk[] = []
    const rejected: HydrateChunksResult['rejected'][number][] = []
    for (const chunkId of chunkIds) {
      const row = byId.get(chunkId)
      if (row === undefined) {
        rejected.push({ chunkId, state: 'unavailable', reason: 'not-indexed' })
        continue
      }
      let verification = verificationByFile.get(row.filePath)
      if (verification === undefined) {
        verification = await this.verifySourceRevision(row.filePath, row.contentHash, signal)
        verificationByFile.set(row.filePath, verification)
      }
      if (verification.state !== 'verified') {
        rejected.push({ chunkId, state: verification.state, reason: verification.reason })
        continue
      }
      chunks.push({
        chunkId: row.chunkId,
        filePath: row.filePath,
        language: row.languageName,
        contentHash: row.contentHash,
        startLine: row.startLine,
        endLine: row.endLine,
        text: row.text,
        parserTier: row.parserTier,
        parserConfidence: row.parserConfidence,
        verification: 'source-verified',
      })
    }
    return { chunks, rejected, epochs: readEpochs(this.requireDb()) }
  }

  /**
   * Ranked retrieval with a lazy first-index guarantee: a query against an
   * empty or never-built medium spends one full pass building it first, so
   * models never meet `CODE_INDEX_NOT_INDEXED` through the normal path. With
   * an embedding tier configured, the query text is embedded (memoized) and
   * rides the engine request into the vector lane; an embedding failure
   * degrades THIS answer — no fabricated vector contribution — without
   * pinning the sticky status flag.
   * @param request - seam request; explicit `topK` is capped by the tier.
   * @param signal - cancellation checked up front and honored per step.
   * @returns the deterministic ranked answer with its epoch pairing.
   */
  async search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult> {
    signal?.throwIfAborted()
    await this.ensureOpen()
    if (!this.generationCommitted || this.requirePort().countFiles() === 0) {
      await this.refresh({ reason: 'lazy' })
    }
    const tier = this.requireTier()
    const clampedTopK = clampTopKToTierCap(request.topK, tier)
    const embedding = this.config.embedding
    let queryVector: Float32Array | undefined
    let queryEmbedFailure: string | undefined
    if (embedding !== undefined) {
      const slot = this.resolveEmbedder(embedding)
      if ('failure' in slot) {
        queryEmbedFailure = slot.failure.message
      } else {
        try {
          queryVector = await embedQueryVector(
            slot.client,
            augmentedQueryText(request),
            this.queryVectorCache,
            embedding,
            signal,
          )
        } catch (error) {
          queryEmbedFailure = String(error)
        }
      }
    }
    const boundedRequest: EngineSearchRequest = {
      ...mapSearchRequest(request),
      ...(clampedTopK === undefined ? {} : { topK: clampedTopK }),
      ...(queryVector === undefined ? {} : { queryVector }),
    }
    const answer = (this.engineSearch as BoundSearch)(boundedRequest)
    // The sticky lane-failure check runs on every answer, including the
    // query-embedding early return below: a lane failure must pin the status
    // flag even when this particular answer also lost its query embedding.
    if (answer.readErrors.some(isLaneFailureReadError)) this.operationDegraded = true
    if (queryEmbedFailure !== undefined) {
      return {
        ...answer,
        degraded: true,
        readErrors: [...answer.readErrors, `query embedding failed (${queryEmbedFailure})`],
      }
    }
    return answer
  }

  /**
   * Answer one structured graph question over the committed graph tables, with
   * the same lazy first-index guarantee as search: an empty or never-built
   * medium spends one full pass building it first. Reads go straight through
   * the graph read facet (see {@link module:explore} and its `cycles` /
   * `dead_code` sibling modules for the per-op assembly contracts); the store
   * has no failure-recovery path here, so a storage failure propagates to the
   * caller instead of degrading.
   * @param request - the `relations` / `impact` / `tests` / `cycles` / `dead_code` question.
   * @param signal - cancellation checked up front.
   * @returns the complete answer under the epoch pair it was read at.
   */
  async exploreGraph(request: GraphExploreRequest, signal?: AbortSignal): Promise<GraphExploreResult> {
    signal?.throwIfAborted()
    await this.ensureOpen()
    if (!this.generationCommitted || this.requirePort().countFiles() === 0) {
      await this.refresh({ reason: 'lazy' })
    }
    const tier = this.requireTier()
    const input: ExploreGraphInput = {
      request,
      facet: this.requirePort().graph,
      limits: repoSizeTierGraphEnrichLimits(tier),
      tier,
      epochs: readEpochs(this.requireDb()),
    }
    return exploreGraphAnswer(input)
  }

  /**
   * Close the store handle and refuse further work. The owning plugin's
   * disposer invokes this after unregistering its service contribution. An
   * in-flight embedding drain is aborted first (its claim lease expires and
   * hands the job back to a later drain), so the queue never fights a closed
   * handle.
   */
  dispose(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    this.queuedRefreshes = []
    this.drainAbort?.abort()
    this.drainRescheduleRequested = false
    const db = this.db
    this.db = undefined
    this.port = undefined
    this.engineSearch = undefined
    this.resolver = undefined
    db?.close()
    return Promise.resolve()
  }
}
