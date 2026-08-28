/**
 * Workspace scanner: single-threaded breadth-first enumeration of candidate
 * files behind `ctx.codeIndex`.
 *
 * Exclusion is the union of three independent layers — any hit prunes the
 * path before it costs a stat or a descent: built-in hard excludes and
 * include globs (ported verbatim from the reference implementation's
 * `IndexingConfig` defaults, `crates/cc-model/src/config.rs::default_ignore_patterns`
 * / `default_include_patterns`), the parsed root `.gitignore`, and explicit
 * config excludes. Directories are pruned on the way in; symlinks are never
 * followed for traversal, and directory symlinks are counted through the
 * walk statistics.
 *
 * @module @relay-harness/rlh-code-index-local/scanner
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { compareStrings } from '@relay-harness/rlh-code-index-search'
import type { PathExclusionFilter } from './gitignore.ts'
import { inclusionMatcherFromPatterns } from './gitignore.ts'

/** Built-in hard excludes, transcribed from `default_ignore_patterns()`. */
export const DEFAULT_HARD_EXCLUDES: readonly string[] = [
  '**/.git/**',
  '**/.hg/**',
  '**/.svn/**',
  '**/.venv/**',
  '**/venv/**',
  '**/__pycache__/**',
  '**/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.idea/**',
  '**/.vscode/**',
  '**/.codecortex/**',
  '**/target/**',
]

/** Include globs deciding which files enter the index, from `default_include_patterns()`. */
export const DEFAULT_INCLUDE_PATTERNS: readonly string[] = [
  '**/*.py',
  '**/*.js',
  '**/*.jsx',
  '**/*.ts',
  '**/*.tsx',
  '**/*.vue',
  '**/*.svelte',
  '**/*.java',
  '**/*.go',
  '**/*.rs',
  '**/*.md',
  '**/*.cs',
  '**/*.php',
  '**/*.rb',
  '**/*.swift',
  '**/*.kt',
  '**/*.kts',
  '**/*.dart',
  '**/*.scala',
  '**/*.sc',
  '**/*.lua',
  '**/*.sql',
  '**/*.yaml',
  '**/*.yml',
  '**/*.toml',
  '**/Dockerfile',
  '**/Dockerfile.*',
]

/** One walked file with exactly what the incremental diff needs. */
export interface ScanEntry {
  /** Workspace-relative POSIX path. */
  readonly path: string
  /** Last-modified time in milliseconds; part of the diff fast path. */
  readonly mtimeMs: number
  /** Size in bytes; part of the diff fast path. */
  readonly size: number
}

/** Aggregate outcome of one complete workspace scan. */
export interface WorkspaceScan {
  /** Every accepted file, in deterministic breadth-first order. */
  readonly entries: readonly ScanEntry[]
  /** Directory symlinks encountered and skipped without traversal. */
  readonly directorySymlinksSkipped: number
}

/** Observable walk events, injectable so callers can track pruning outcomes. */
export interface WalkEvents {
  /** Fires once per skipped directory symlink. */
  readonly onDirectorySymlink?: () => void
}

/** Queue entry pairing absolute and relative spellings of one pending directory. */
interface PendingDirectory {
  readonly absolute: string
  readonly relative: string
}

/**
 * Classify a symlink target without ever traversing into it.
 * @returns whether the link resolves to a directory; broken links are `false`.
 */
async function symlinkPointsAtDirectory(absolutePath: string): Promise<boolean> {
  try {
    return (await stat(absolutePath)).isDirectory()
  } catch {
    // A broken link cannot be classified or indexed; treating it as a plain
    // file link is the safe verdict because nothing reachable exists either way.
    return false
  }
}

/**
 * Walk the workspace breadth-first, yielding accepted files in per-directory
 * batches. The root itself is always entered; every other directory passes
 * the exclusion union before descending. Order inside a directory follows
 * sorted names, keeping whole scans reproducible across runs.
 *
 * Yields one accepted-file batch whenever a directory contributes files;
 * empty directories surface no batch at all.
 * @param root - absolute workspace root to enumerate.
 * @param include - include globs a file must satisfy (any match wins).
 * @param exclusions - exclusion layers evaluated before descending or accepting.
 * @param events - optional observer for skipped directory symlinks.
 * @returns an async generator completing after every reachable directory.
 */
export async function* walkWorkspace(
  root: string,
  include: readonly string[],
  exclusions: readonly PathExclusionFilter[],
  events: WalkEvents = {},
): AsyncGenerator<readonly ScanEntry[], void, undefined> {
  const includeMatcher = inclusionMatcherFromPatterns(include)
  const queue: PendingDirectory[] = [{ absolute: root, relative: '' }]
  while (queue.length > 0) {
    const current = queue.shift() as PendingDirectory
    const dirents = await readdir(current.absolute, { withFileTypes: true })
    const sorted = [...dirents].sort((left, right) => compareStrings(left.name, right.name))
    const batch: ScanEntry[] = []
    for (const dirent of sorted) {
      const childRelative = current.relative === '' ? dirent.name : `${current.relative}/${dirent.name}`
      const childAbsolute = join(current.absolute, dirent.name)
      if (dirent.isSymbolicLink()) {
        if (await symlinkPointsAtDirectory(childAbsolute)) events.onDirectorySymlink?.()
        continue
      }
      if (dirent.isDirectory()) {
        if (!exclusions.some(layer => layer.excludes(childRelative, true))) {
          queue.push({ absolute: childAbsolute, relative: childRelative })
        }
        continue
      }
      if (!dirent.isFile()) continue
      if (exclusions.some(layer => layer.excludes(childRelative, false))) continue
      if (!includeMatcher.matches(childRelative)) continue
      const stats = await stat(childAbsolute)
      batch.push({ path: childRelative, mtimeMs: stats.mtimeMs, size: stats.size })
    }
    if (batch.length > 0) yield batch
  }
}

/**
 * Collect one complete scan.
 * @param root - absolute workspace root to enumerate.
 * @param include - include globs a file must satisfy.
 * @param exclusions - exclusion layers evaluated during the walk.
 * @returns every accepted file plus the directory-symlink skip count.
 */
export async function collectWorkspaceEntries(
  root: string,
  include: readonly string[],
  exclusions: readonly PathExclusionFilter[],
): Promise<WorkspaceScan> {
  const counters = { directorySymlinksSkipped: 0 }
  const entries: ScanEntry[] = []
  const events: WalkEvents = {
    onDirectorySymlink: () => counters.directorySymlinksSkipped++,
  }
  for await (const batch of walkWorkspace(root, include, exclusions, events)) {
    entries.push(...batch)
  }
  return { entries, directorySymlinksSkipped: counters.directorySymlinksSkipped }
}
