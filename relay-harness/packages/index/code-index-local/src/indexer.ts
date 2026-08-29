/**
 * One indexed-generation pass: scan the tree, diff against the committed
 * generation, re-read genuinely changed files, and commit the delta —
 * optionally through the five-stage pipeline (parse → resolve → write with
 * test-edge maintenance → dirty propagation) when the runtime supplies a
 * resolver and the store's graph facet.
 *
 * Concurrency never lives here — the runtime folds concurrent refresh calls
 * before a pass starts, so every function in this module is straight-line
 * async over an idle store. The pass is also where `files.metadata` gains its
 * `last_refresh` ledger row, kept alongside the epoch clocks so a restarted
 * process can still report when the derived medium last caught up.
 *
 * @module @relay-harness/rlh-code-index-local/indexer
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { EpochPair } from '@relay-harness/rlh-code-index'
import type { ParseOutcome } from '@relay-harness/rlh-code-index-parser'
import { chunkWithSymbols, parseFile } from '@relay-harness/rlh-code-index-parser'
import type { LanguageName } from '@relay-harness/rlh-code-index-parser'
import type { GraphReadFacet } from '@relay-harness/rlh-code-index-search'
import type { FileUpsert, JournalMode } from '@relay-harness/rlh-code-index-sqlite'
import { openCodeIndexDatabase, readEpochs, writeFilesDelta } from '@relay-harness/rlh-code-index-sqlite'
import {
  DEFAULT_DIRTY_MAX_FILES,
  applyTestEdgeRebuild,
  callEdgeRowFromParse,
  catalogRowFromParse,
  computeExportFingerprint,
  decideTestEdgeRebuild,
  graphRowsForOutcome,
  runDirtyPropagation,
} from '@relay-harness/rlh-code-index-graph'
import type { DirtyPropagationReport, StoredCallEdgeRow, SymbolResolver } from '@relay-harness/rlh-code-index-graph'
import type { PathExclusionFilter } from './gitignore.ts'
import { exclusionFilterFromPatterns } from './gitignore.ts'
import { contentHash, contentHashFile } from './hash.ts'
import type { IndexedSnapshotRow } from './diff.ts'
import { confirmChangedByHash, planSnapshotDiff } from './diff.ts'
import {
  GENERIC_PARSER_CONFIDENCE,
  GENERIC_PARSER_TIER,
  decodeUtf8Strict,
  prepareTextDocument,
} from './chunker.ts'
import type { ScanEntry } from './scanner.ts'
import { DEFAULT_HARD_EXCLUDES, collectWorkspaceEntries } from './scanner.ts'
import { mapConcurrentOrdered } from './parallel.ts'

/** Maximum concurrent file read/parse operations in one refresh pass. */
export const DEFAULT_PARSE_CONCURRENCY = 4

/** Metadata ledger key carrying the last committed {@link PersistedRefreshRecord}. */
export const CODE_INDEX_METADATA_LAST_REFRESH = 'last_refresh'

/** Everything one pass needs from its owning runtime. */
export interface RefreshPassInputs {
  /** Admitted store handle receiving the delta; no transaction may be open. */
  readonly db: DatabaseSync
  /** Absolute workspace root to scan. */
  readonly workspaceRoot: string
  /** Include globs deciding candidate files. */
  readonly includePatterns: readonly string[]
  /** Complete exclusion stack (hard ∪ config ∪ parsed `.gitignore`). */
  readonly exclusionFilters: readonly PathExclusionFilter[]
  /** Byte ceiling beyond which files record rows without chunks. */
  readonly maxFileBytes: number
  /** Committed generation the diff fast-path reads; empty forces full writes. */
  readonly previousGeneration: ReadonlyMap<string, IndexedSnapshotRow>
  /** Normalized workspace-relative files or directory prefixes; omitted scans the full tree. */
  readonly paths?: readonly string[]
  /**
   * Store graph facet enabling the pipeline stages' read-backs (pre-write
   * export fingerprints, test-edge decisions, dirty propagation). Supplied
   * together with {@link RefreshPassInputs.resolver} by the runtime; both
   * absent runs the legacy generic-only pass.
   */
  readonly graph?: GraphReadFacet
  /**
   * Resolver over the live symbol catalog enabling the parse and resolve
   * stages. Supplied together with {@link RefreshPassInputs.graph}; both
   * absent runs the legacy generic-only pass.
   */
  readonly resolver?: SymbolResolver
  /** Global dirty-propagation promotion budget; defaults to {@link DEFAULT_DIRTY_MAX_FILES}. */
  readonly dirtyMaxFiles?: number
}

/** What one pass observed, before runtime-side bookkeeping wraps it. */
export interface RefreshPassOutcome {
  /** True when scan/diff found no storage or dirty work and opened no write transaction. */
  readonly skipped: boolean
  /** Files delete-then-reinserted with fresh chunks. */
  readonly changedFiles: number
  /** Paths dropped because they disappeared (or became unreadable mid-pass). */
  readonly removedFiles: number
  /** Fast-path and hash-equal survivors left untouched this pass. */
  readonly unchangedFiles: number
  /** Chunk rows written across all upserted files. */
  readonly chunksWritten: number
  /** Undecodable payloads encountered among accepted candidates. */
  readonly binarySkipped: number
  /** Workspace-relative paths this pass upserted. */
  readonly changedPaths: readonly string[]
  /** Workspace-relative paths this pass removed. */
  readonly removedPaths: readonly string[]
  /** Symbol rows written across all upserted files. */
  readonly symbolsWritten: number
  /** Dirty-propagation phase result; `null` when the pass ran without a resolver. */
  readonly dirty: DirtyPropagationReport | null
}

/**
 * Build the static exclusion stack. `.gitignore` documents are deliberately
 * discovered by the scanner on every pass, including nested documents, so an
 * ignore-rule edit does not require restarting the provider.
 * @param workspaceRoot - retained for call-site compatibility.
 * @param excludePatterns - caller-configured extra pattern lines.
 * @returns every layer as an ordered filter list ready for the walker.
 */
export function buildExclusionStack(
  workspaceRoot: string,
  excludePatterns: readonly string[],
): Promise<readonly PathExclusionFilter[]> {
  const filters: PathExclusionFilter[] = [hardExclusionFilter]
  if (excludePatterns.length > 0) {
    filters.push(exclusionFilterFromPatterns(excludePatterns))
  }
  void workspaceRoot
  return Promise.resolve(filters)
}

const hardExclusionFilter: PathExclusionFilter = exclusionFilterFromPatterns(DEFAULT_HARD_EXCLUDES)

/**
 * Read the committed generation's fast-path columns into a diff-ready snapshot.
 * @param db - admitted store handle.
 * @returns path-keyed rows mirroring the committed `files` inventory.
 */
export function loadIndexedSnapshot(db: DatabaseSync): ReadonlyMap<string, IndexedSnapshotRow> {
  const rows = db.prepare(
    'SELECT file_path, mtime, size, content_hash FROM files',
  ).all() as Array<{ file_path: string; mtime: number; size: number; content_hash: string }>
  const snapshot = new Map<string, IndexedSnapshotRow>()
  for (const row of rows) {
    snapshot.set(row.file_path, { mtimeMs: row.mtime, size: row.size, contentHash: row.content_hash })
  }
  return snapshot
}

/**
 * Compose one storage-ready upsert from raw bytes.
 * @param filePath - workspace-relative POSIX path.
 * @param mtimeMs - scan-time modification stamp forwarded to the row.
 * @param size - scan-time byte size forwarded to the row.
 * @param bytes - full decoded-candidate contents.
 * @param maxFileBytes - ceiling above which chunks are dropped from the row.
 * @returns the upsert, or `null` when the payload is not valid UTF-8 and the
 *   file must be skipped entirely.
 */
export function composeFileUpsert(
  filePath: string,
  mtimeMs: number,
  size: number,
  bytes: Uint8Array,
  maxFileBytes: number,
): FileUpsert | null {
  const text = decodeUtf8Strict(bytes)
  if (text === null) return null
  return composeGenericUpsert(filePath, mtimeMs, size, text, bytes.byteLength, maxFileBytes)
}

/**
 * Compose the generic-tier upsert over already-decoded text; the byte length
 * travels separately because the byte ceiling (not the character count)
 * marks oversized rows.
 * @param filePath - workspace-relative POSIX path.
 * @param mtimeMs - scan-time modification stamp forwarded to the row.
 * @param size - scan-time byte size forwarded to the row.
 * @param text - decoded file contents.
 * @param byteLength - the payload's UTF-8 byte length.
 * @param maxFileBytes - ceiling above which chunks are dropped from the row.
 * @returns the generic-tier upsert.
 */
export function composeGenericUpsert(
  filePath: string,
  mtimeMs: number,
  size: number,
  text: string,
  byteLength: number,
  maxFileBytes: number,
): FileUpsert {
  const document = prepareTextDocument(filePath, text, byteLength, { maxFileBytes })
  return {
    filePath,
    language: document.language,
    contentHash: contentHashText(text),
    mtime: mtimeMs,
    size,
    summary: document.summary,
    contentExcerpt: document.contentExcerpt,
    parserTier: GENERIC_PARSER_TIER,
    parserConfidence: GENERIC_PARSER_CONFIDENCE,
    isTestFile: document.isTestFile,
    chunks: document.chunks.map(chunk => ({
      chunkId: `chunk:${filePath}:${chunk.chunkIndex}`,
      chunkIndex: chunk.chunkIndex,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      breadcrumb: '',
      symbolName: null,
      symbolKind: null,
      text: chunk.text,
      tokenEstimate: chunk.tokenEstimate,
    })),
  }
}

/**
 * Compose the parser-tier upsert for a file whose parse succeeded: chunks
 * follow the parser's symbol-aware strategy, and summary/excerpt/test flag
 * come straight from the outcome instead of filename heuristics.
 * @param filePath - workspace-relative POSIX path.
 * @param mtimeMs - scan-time modification stamp forwarded to the row.
 * @param size - scan-time byte size forwarded to the row.
 * @param outcome - the file's parse outcome.
 * @param text - the same decoded text the outcome was parsed from.
 * @returns the parser-tier upsert.
 */
export function composeParsedUpsert(
  filePath: string,
  mtimeMs: number,
  size: number,
  outcome: ParseOutcome,
  text: string,
): FileUpsert {
  const chunks = chunkWithSymbols({
    filePath,
    content: text,
    // The outcome's language is the parser's own classification, whose names
    // are exactly the chunker's `LanguageName` vocabulary.
    language: outcome.language as LanguageName,
    parserTier: outcome.parserTier,
    parserConfidence: outcome.parserConfidence,
    symbols: outcome.symbols,
  })
  return {
    filePath,
    language: outcome.language,
    contentHash: contentHashText(text),
    mtime: mtimeMs,
    size,
    summary: outcome.summary,
    contentExcerpt: outcome.contentExcerpt,
    parserTier: outcome.parserTier,
    parserConfidence: outcome.parserConfidence,
    isTestFile: outcome.isTestFile,
    chunks: chunks.map(chunk => ({
      chunkId: chunk.chunkId,
      chunkIndex: chunk.chunkIndex,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      breadcrumb: chunk.breadcrumb,
      symbolName: chunk.symbolName,
      symbolKind: chunk.symbolKind,
      text: chunk.text,
      tokenEstimate: chunk.tokenEstimate,
    })),
  }
}

/** Content hash over text, matching {@link composeFileUpsert}'s byte hashing. */
function contentHashText(text: string): string {
  return contentHash(new TextEncoder().encode(text))
}

/** File reads a pass performs; injectable so tests can pin mid-pass races. */
export interface RefreshPassIo {
  /** Current truncated content hash of one workspace-relative path. */
  readonly readHash: (relPath: string) => Promise<string | null>
  /** Full bytes of one workspace-relative path. */
  readonly readBytes: (relPath: string) => Promise<Uint8Array>
}

function defaultPassIo(workspaceRoot: string): RefreshPassIo {
  return {
    // The null fallback serves the deleted-between-scan-and-read race, which
    // real filesystems cannot present deterministically; the injected-io
    // suites pin every downstream outcome it can reach.
    /* v8 ignore next */
    readHash: relPath => contentHashFile(join(workspaceRoot, relPath)).catch(() => null),
    readBytes: async relPath => new Uint8Array(await readFile(join(workspaceRoot, relPath))),
  }
}

/**
 * Execute one pass end to end. Ordering matters: the scan is authoritative
 * even while files keep changing underneath it, and any candidate that dies
 * between scan and re-read lands in the removal half of the same delta.
 *
 * With a resolver and graph facet supplied, the pass runs the five stages:
 * the scan/diff/read above, per-file parsing with generic fallback, one
 * resolve pass over the fresh rows, a single delta commit (fresh export
 * fingerprints included) followed by the test-edge rebuild decision, and the
 * dirty-propagation phase whose promotions re-resolve in place. Each stage's
 * writes land in its own epoch-bumped transaction, so `epochsAfter` on the
 * summary advances by the number of commits the pass made.
 * @param inputs - everything one pass needs from its owning runtime.
 * @param io - injectable file readers; defaults to real filesystem reads.
 * @returns what the committed delta changed, including binary skips.
 * @throws when walking, hashing an existing file, parsing unexpectedly, or
 *   committing fails loudly; partial failures abort the delta and leave the
 *   prior generation intact.
 */
export async function runRefreshPass(
  inputs: RefreshPassInputs,
  io: RefreshPassIo = defaultPassIo(inputs.workspaceRoot),
): Promise<RefreshPassOutcome> {
  const scan = await collectWorkspaceEntries(
    inputs.workspaceRoot,
    inputs.includePatterns,
    inputs.exclusionFilters,
    inputs.paths === undefined ? {} : { paths: inputs.paths },
  )
  const nextByPath = new Map<string, ScanEntry>(scan.entries.map(entry => [entry.path, entry]))
  const previousGeneration = inputs.paths === undefined
    ? inputs.previousGeneration
    : new Map([...inputs.previousGeneration].filter(([path]) =>
      inputs.paths?.some(scope => path === scope || path.startsWith(`${scope}/`)) === true))
  const plan = planSnapshotDiff(previousGeneration, nextByPath)

  // A null hash here means the file turned unreadable after the scan; it stays
  // in `changedPaths` and falls out to removals during the byte re-read below.
  const confirmed = await confirmChangedByHash(
    previousGeneration,
    plan.suspiciousPaths,
    io.readHash,
  )

  const pipeline = inputs.resolver !== undefined && inputs.graph !== undefined
  // A full build (empty committed generation) parses and resolves every file
  // in the same pass, so there is no stale resolution for dirty propagation
  // to repair; like the reference, only incremental passes carry a dirty
  // phase.
  const incremental = inputs.previousGeneration.size > 0
  const upserts: FileUpsert[] = []
  const parsedOutcomes = new Map<string, ParseOutcome>()
  let binarySkipped = 0
  const vanishedAfterScan: string[] = []
  const processed = await mapConcurrentOrdered(confirmed.changedPaths, DEFAULT_PARSE_CONCURRENCY, async (relPath) => {
    let bytes: Uint8Array
    try {
      bytes = await io.readBytes(relPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      return { kind: 'vanished' as const, relPath }
    }
    const entry = nextByPath.get(relPath) as ScanEntry
    if (!pipeline) {
      const upsert = composeFileUpsert(relPath, entry.mtimeMs, entry.size, bytes, inputs.maxFileBytes)
      return upsert === null
        ? { kind: 'binary' as const, relPath }
        : { kind: 'upsert' as const, relPath, upsert }
    }
    const text = decodeUtf8Strict(bytes)
    if (text === null) return { kind: 'binary' as const, relPath }
    // Unsupported or oversized files return `null` and fall through to the
    // generic tier, exactly like the legacy pass.
    const outcome = await parseFile(relPath, text, {
      projectRoot: inputs.workspaceRoot,
      maxFileBytes: inputs.maxFileBytes,
    })
    if (outcome === null) {
      return {
        kind: 'upsert' as const,
        relPath,
        upsert: composeGenericUpsert(relPath, entry.mtimeMs, entry.size, text, bytes.byteLength, inputs.maxFileBytes),
      }
    }
    return { kind: 'upsert' as const, relPath, outcome, upsert: composeParsedUpsert(relPath, entry.mtimeMs, entry.size, outcome, text) }
  })
  for (const item of processed) {
    if (item.kind === 'vanished') vanishedAfterScan.push(item.relPath)
    else if (item.kind === 'binary') binarySkipped++
    else {
      upserts.push(item.upsert)
      if (item.outcome !== undefined) parsedOutcomes.set(item.relPath, item.outcome)
    }
  }

  const removals = [...plan.removedPaths, ...vanishedAfterScan]
  const changedPaths = upserts.map(upsert => upsert.filePath)

  // Resolve stage: fresh rows go through the resolver pre-write, after
  // evicting this batch's stale catalog entries so lazy loads see the new
  // symbol rows (a reparsed file's old exports must not answer this pass).
  const resolvedEdges = resolveFreshEdges(inputs, parsedOutcomes, removals)

  // Export fingerprints must be captured BEFORE the delta commit replaces
  // them; the dirty stage reads the post-write values back and compares.
  const graph = inputs.graph
  const previousFingerprints = graph === undefined
    ? undefined
    : new Map<string, string | null>(
      graph.exportFingerprints(changedPaths).map(row => [row.filePath, row.fingerprint]),
    )

  const graphDelta = graph === undefined || parsedOutcomes.size === 0
    ? undefined
    : {
      byFile: new Map([...parsedOutcomes].map(([filePath, outcome]) => [filePath, {
        ...graphRowsForOutcome(outcome, resolvedEdges?.get(filePath)),
        exportFingerprint: computeExportFingerprint(outcome.symbols),
      }])),
    }

  const hasDelta = removals.length > 0 || upserts.length > 0
  const delta = hasDelta
    ? writeFilesDelta(
      inputs.db,
      graphDelta === undefined ? { removals, upserts } : { removals, upserts, graph: graphDelta },
    )
    : {
      removedFiles: 0,
      upsertedFiles: 0,
      chunksWritten: 0,
      symbolsWritten: 0,
      edgesWritten: 0,
      testEdgesWritten: 0,
      literalsWritten: 0,
    }

  let dirty: DirtyPropagationReport | null = null
  if (pipeline && incremental && hasDelta) {
    const batchPaths = [...changedPaths, ...removals]
    applyTestEdgeRebuild(
      inputs.db,
      decideTestEdgeRebuild({ hadRemovalsOrRenames: removals.length > 0, changedPaths: batchPaths }),
      batchPaths,
    )
    dirty = runDirtyPropagation({
      db: inputs.db,
      resolver: inputs.resolver,
      removedPaths: removals,
      reparsedFiles: changedPaths,
      previousFingerprints: previousFingerprints as ReadonlyMap<string, string | null>,
      config: { enabled: true, maxFiles: inputs.dirtyMaxFiles ?? DEFAULT_DIRTY_MAX_FILES },
    })
  }

  return {
    skipped: !hasDelta,
    changedFiles: delta.upsertedFiles,
    removedFiles: delta.removedFiles,
    unchangedFiles: plan.unchangedCount + confirmed.hashUnchangedCount,
    chunksWritten: delta.chunksWritten,
    binarySkipped,
    changedPaths,
    removedPaths: removals,
    symbolsWritten: delta.symbolsWritten,
    dirty,
  }
}

/**
 * Run the resolve stage over the fresh parse outcomes: the batch's stale
 * catalog entries are evicted first, then one resolve pass binds the fresh
 * call edges. Returns the resolved rows grouped per file for the write stage.
 */
function resolveFreshEdges(
  inputs: RefreshPassInputs,
  parsedOutcomes: ReadonlyMap<string, ParseOutcome>,
  removals: readonly string[],
): ReadonlyMap<string, StoredCallEdgeRow[]> | undefined {
  const resolver = inputs.resolver
  if (resolver === undefined) return undefined
  // Eviction runs even for an all-removals batch: a removed file's symbols
  // must leave the catalog, or a dirty re-resolution would rebind against
  // the stale entries the store no longer holds.
  resolver.catalog.removeFiles(new Set([...parsedOutcomes.keys(), ...removals]))
  if (parsedOutcomes.size === 0) return undefined
  const outcomes = [...parsedOutcomes.values()]
  // This build's fresh symbols join the catalog before resolving: on a full
  // build the store does not hold them yet, and cross-file targets inside the
  // batch must answer from the parse output, not the pre-write store.
  resolver.catalog.addSymbols(outcomes.flatMap(outcome => outcome.symbols.map(catalogRowFromParse)))
  const resolved = resolver.resolveEdges({
    callEdges: outcomes.flatMap(outcome => outcome.callEdges.map(callEdgeRowFromParse)),
    symbolRefs: [],
    imports: outcomes.flatMap(outcome => outcome.imports),
  })
  const byFile = new Map<string, StoredCallEdgeRow[]>()
  for (const row of resolved.callEdges) {
    const rows = byFile.get(row.filePath)
    if (rows === undefined) byFile.set(row.filePath, [row])
    else rows.push(row)
  }
  return byFile
}

/** Open the derived store and expose the couple of ledger reads passes need. */
export interface OpenedStore {
  readonly db: DatabaseSync
  readonly epochsAtOpen: EpochPair
}

/**
 * Open-or-create the store behind one database path.
 * @param databasePath - dedicated SQLite file or `:memory:`.
 * @param journalMode - validated journal pragma.
 * @returns the admitted handle with its ledger clocks read at open.
 */
export function openStore(databasePath: string, journalMode: JournalMode): Promise<OpenedStore> {
  return openCodeIndexDatabase(databasePath, journalMode).then(db => ({
    db,
    epochsAtOpen: readEpochs(db),
  }))
}

/** Wall-clock defaults; injection exists solely for deterministic tests. */
export interface PersistOptions {
  readonly now?: () => string
}

/**
 * Stamp the metadata ledger with the just-committed generation.
 * @param db - admitted store handle with the transaction already closed.
 * @param record - refresh summary shaped for durable persistence.
 */
export function persistLastRefresh(db: DatabaseSync, record: Record<string, unknown>): void {
  db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)').run(
    CODE_INDEX_METADATA_LAST_REFRESH,
    JSON.stringify(record),
  )
}

/**
 * Recover the last persisted refresh record from a previous process.
 * @param db - admitted store handle.
 * @param revive - caller-owned shape validator over the parsed JSON value.
 * @returns the record, or `undefined` when absent or unreadable — a damaged
 *   side ledger only suppresses cross-restart reporting, never indexing, so it
 *   is reported as absent rather than failing a usable derived medium.
 */
export function loadPersistedLastRefresh<T>(db: DatabaseSync, revive: (raw: unknown) => T | undefined): T | undefined {
  const row = db.prepare('SELECT value FROM metadata WHERE key = ?').get(CODE_INDEX_METADATA_LAST_REFRESH) as
    | { value: string }
    | undefined
  if (row === undefined) return undefined
  let revived: T | undefined
  try {
    revived = revive(JSON.parse(row.value))
  } catch {
    revived = undefined
  }
  return revived
}
