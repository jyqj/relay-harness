/**
 * Incremental snapshot diff between the previous indexed generation and a
 * fresh workspace scan.
 *
 * The fast path is mtime+size equality — three stored columns, no content
 * reads. Paths that differ (or are new) are candidates only: their current
 * content hash is re-read and compared against the previous hash before
 * "Changed" is final, which suppresses both touch-with-same-content edits and
 * filesystems whose mtime granularity jitters. Paths present before and
 * unreadable now count as removed.
 *
 * @module @relay-harness/rlh-code-index-local/diff
 */

import type { ScanEntry } from './scanner.ts'

/** The slice of one `files` row the diff consults. */
export interface IndexedSnapshotRow {
  /** `files.mtime` at last index time. */
  readonly mtimeMs: number
  /** `files.size` at last index time. */
  readonly size: number
  /** Truncated content hash of the last indexed revision. */
  readonly contentHash: string
}

/** One completed fast-path classification. */
export interface SnapshotPlan {
  /** Paths whose stored mtime+size still match disk exactly. */
  readonly unchangedCount: number
  /** Paths needing a content re-read before Changed/Unchanged is decided. */
  readonly suspiciousPaths: readonly string[]
  /** Previously indexed paths that vanished from this scan. */
  readonly removedPaths: readonly string[]
}

/**
 * Classify a scan against the previous generation using stored columns only —
 * no file content is read here.
 * @param prev - path-keyed rows from the last committed generation.
 * @param next - freshly scanned entries keyed by relative path.
 * @returns unchanged totals plus candidate and removal path sets.
 */
export function planSnapshotDiff(
  prev: ReadonlyMap<string, IndexedSnapshotRow>,
  next: ReadonlyMap<string, ScanEntry>,
): SnapshotPlan {
  let unchangedCount = 0
  const suspiciousPaths: string[] = []
  for (const [path, entry] of next) {
    const row = prev.get(path)
    if (row === undefined || row.mtimeMs !== entry.mtimeMs || row.size !== entry.size) {
      suspiciousPaths.push(path)
      continue
    }
    unchangedCount++
  }
  const removedPaths = [...prev.keys()].filter(path => !next.has(path))
  return { unchangedCount, suspiciousPaths, removedPaths }
}

/**
 * Resolve suspicious paths into the final Changed set by hashing current
 * content. The provided reader returns the new truncated hash, or `null`
 * when the file cannot be read anymore (deleted between scan and read).
 * @param prev - previous generation rows supplying the reference hashes.
 * @param suspiciousPaths - candidate paths from {@link planSnapshotDiff}.
 * @param resolveCurrentHash - per-path content hash reader.
 * @returns truly changed paths plus those confirmed untouched by hash.
 */
export async function confirmChangedByHash(
  prev: ReadonlyMap<string, IndexedSnapshotRow>,
  suspiciousPaths: readonly string[],
  resolveCurrentHash: (relPath: string) => Promise<string | null>,
): Promise<{ changedPaths: string[]; hashUnchangedCount: number }> {
  const changedPaths: string[] = []
  let hashUnchangedCount = 0
  for (const path of suspiciousPaths) {
    const currentHash = await resolveCurrentHash(path)
    const row = prev.get(path)
    if (currentHash !== null && row?.contentHash === currentHash) {
      hashUnchangedCount++
      continue
    }
    changedPaths.push(path)
  }
  return { changedPaths, hashUnchangedCount }
}
