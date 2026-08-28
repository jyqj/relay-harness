/**
 * Cross-build reuse of the resolver's {@link SymbolCatalog}, in the spirit of
 * the reference implementation's `resolver/catalog_cache.rs` reduced to
 * explicit API calls.
 *
 * The reference parks a whole built catalog on the database handle and lets
 * `take_validated` re-check the persisted seed aggregate token before every
 * build reuses it; a stale reuse is impossible because any out-of-band symbol
 * write moves the token. This package has no database access (the store lands
 * with a later knife), so the same single-writer idea is expressed as explicit
 * per-file slices: the caller tells the cache which file's rows enter
 * (`addFile`) and which file's rows left (`removeFile` / `invalidateFile`),
 * and a slice is stale only if the caller lies — no token plumbing is needed.
 * The resolve memo lives here because it is cache state: every slice mutation
 * invalidates it, exactly as the reference clears its resolve LRU in
 * `remove_files`.
 *
 * @module catalog-cache
 */

import type { SymbolRow } from '../types.ts'
import type { SymbolCatalog } from './catalog.ts'
import type { ResolveResult } from './steps-proof.ts'

/**
 * LRU memo for `resolveName` results keyed by the full query tuple. Ports the
 * reference's sharded resolve LRU (single-threaded here, so one map): misses
 * are cached too, and the hit counter exposes reuse for tests and metrics.
 */
export class ResolveMemo {
  /** Insertion-ordered entries; re-inserting a hit moves it to LRU position. */
  private readonly entries = new Map<string, ResolveMemoValue>()
  /** Number of get() calls served from the memo. */
  private hits = 0

  constructor(
    /**
     * Maximum entries before the oldest is evicted; mirrors the reference's
     * `CODECORTEX_RESOLVER_CACHE_SIZE` default of 8192.
     */
    readonly capacity: number = 8192,
  ) {}

  /**
   * Serve a memoized resolution outcome.
   *
   * @param key - Key built by {@link resolveMemoKey}.
   * @returns The winning result, `null` for a memoized miss, or `undefined`
   * when the key is cold.
   */
  get(key: string): ResolveMemoValue | undefined {
    const value = this.entries.get(key)
    if (value === undefined) return undefined
    this.hits += 1
    this.entries.delete(key)
    this.entries.set(key, value)
    return value
  }

  /**
   * Insert or replace an entry, evicting the oldest beyond capacity.
   *
   * @param key - Key built by {@link resolveMemoKey}.
   * @param value - Winning result, or `null` for a resolved miss.
   */
  put(key: string, value: ResolveMemoValue): void {
    this.entries.delete(key)
    // capacity >= 1, so a full map always has an oldest key to evict.
    if (this.entries.size >= this.capacity) {
      this.entries.delete(this.entries.keys().next().value as string)
    }
    this.entries.set(key, value)
  }

  /** Times {@link ResolveMemo.get} served a cached entry since the last clear. */
  get hitCount(): number {
    return this.hits
  }

  /** Drop every entry and reset the hit counter. */
  clear(): void {
    this.entries.clear()
    this.hits = 0
  }
}

/** Memo payload: the winning result, or `null` for a resolved miss. */
export type ResolveMemoValue = ResolveResult | null

/**
 * Build the memo key for one resolve query. The call-site line participates
 * only when the scope map is non-empty (the line influences resolution
 * exclusively through scope lookups), matching the reference's
 * `resolve_key_hash` guard.
 *
 * @param name - Trimmed callee/reference name.
 * @param file - Resolving file path.
 * @param scopedLine - Call-site line when scopes exist, else `null`.
 * @param container - Enclosing declaration name, else `null`.
 * @param argCount - Call-site argument count, else `null`.
 * @param receiver - Call-site receiver expression, else `null`.
 * @returns The memo key.
 */
export function resolveMemoKey(
  name: string,
  file: string,
  scopedLine: number | null,
  container: string | null,
  argCount: number | null,
  receiver: string | null,
): string {
  return `${name}\u0000${file}\u0000${scopedLine ?? ''}\u0000${container ?? ''}\u0000${argCount ?? ''}\u0000${receiver ?? ''}`
}

/**
 * Per-file slice cache over a {@link SymbolCatalog}: remembers which files'
 * symbol rows were registered, drives their removal, and clears the catalog's
 * resolve memo on every mutation so memoized results can never outlive the
 * entries they point at.
 */
export class CatalogSliceCache {
  /** Files whose symbol rows currently live in the catalog. */
  private readonly loaded = new Set<string>()

  /**
   * @param catalog - Catalog the slices feed into.
   * @param memo - The catalog's resolve memo, cleared on every mutation.
   */
  constructor(
    readonly catalog: SymbolCatalog,
    readonly memo: ResolveMemo,
  ) {}

  /**
   * Register one file's symbol rows as a slice, replacing any previous slice
   * of the same file first (the caller re-parses whole files, so rows are
   * always replaced wholesale, never merged).
   *
   * @param file - Workspace-relative file path the rows belong to.
   * @param rows - Symbol rows of the file.
   */
  addFile(file: string, rows: readonly SymbolRow[]): void {
    this.removeFile(file)
    this.loaded.add(file)
    this.catalog.addSymbols(rows)
    this.memo.clear()
  }

  /**
   * Remove one file's slice from the catalog.
   *
   * @param file - File whose rows should leave the catalog.
   */
  removeFile(file: string): void {
    if (!this.loaded.delete(file)) return
    this.catalog.removeFiles(new Set([file]))
  }

  /**
   * Drop one file's slice and its memoized resolutions without any catalog
   * bookkeeping assumptions — the invalidation counterpart of the reference's
   * `take_validated` miss, which discards rather than patches a stale slice.
   *
   * @param file - File whose cached state is no longer trustworthy.
   */
  invalidateFile(file: string): void {
    this.removeFile(file)
    this.memo.clear()
  }

  /**
   * Whether the cache currently holds a slice for the file.
   *
   * @param file - File to probe.
   * @returns True when a slice is loaded.
   */
  has(file: string): boolean {
    return this.loaded.has(file)
  }

  /** Files currently loaded as slices, in load order. */
  get files(): readonly string[] {
    return [...this.loaded]
  }
}
