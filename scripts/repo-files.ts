/** Shared repository file discovery and line-oriented reference scanning. */

import { spawnSync } from 'node:child_process'
import { existsSync, globSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'

/** One authored path plus its canonical target for symlink deduplication. */
export interface RepoFile {
  /** Absolute path matched by the caller's glob. */
  abs: string
  /** Absolute canonical path used only for deduplication. */
  real: string
}

/** A rejected line-oriented repository reference. */
export interface ReferenceViolation {
  /** Repo-relative file containing the reference. */
  file: string
  /** 1-based line containing the reference. */
  line: number
  /** Normalized reference text. */
  ref: string
}

/** Content plane used when enumerating repository-owned files through Git. */
export type GitRepoFilePlane = 'worktree' | 'index'

/**
 * List files Git considers part of the selected repository plane.
 * Worktree discovery combines tracked files with ordinary untracked files and
 * honors `.gitignore`, `.git/info/exclude`, and global excludes. Index
 * discovery reads staged paths only. Deleted tracked files are absent from the
 * worktree result but remain visible in the index plane.
 * @param root - absolute Git worktree root.
 * @param plane - working-tree or staged-index discovery.
 * @returns normalized repository-relative paths in Git's stable byte order.
 */
export function gitVisibleRepoFiles(root: string, plane: GitRepoFilePlane = 'worktree'): string[] {
  const args = ['-C', root, 'ls-files', '-z', '--cached']
  if (plane === 'worktree') args.push('--others', '--exclude-standard')
  args.push('--')
  const result = spawnSync('git', args, { encoding: 'utf8' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`git ls-files failed for ${root}: ${result.stderr.trim() || `exit ${String(result.status)}`}`)
  }
  const files = result.stdout.split('\0').filter(Boolean).map(path => path.replaceAll('\\', '/'))
  return plane === 'index' ? files : files.filter(path => existsSync(resolve(root, path)))
}

/** Whether a repository path is frozen Agent Note history, not evolving source prose. */
export function isArchivedAgentNotePath(path: string): boolean {
  return path.replaceAll('\\', '/').startsWith('.agents/notes/archived/')
}

/**
 * Expand repository-relative globs and deduplicate symlinked files.
 * @param root - absolute repository root.
 * @param patterns - repository-relative glob patterns, processed in order.
 * @param isExcluded - optional predicate over each matched relative path.
 * @returns matched files in stable first-seen order.
 */
export function uniqueRepoFiles(
  root: string,
  patterns: readonly string[],
  isExcluded: (relativePath: string) => boolean = () => false,
): RepoFile[] {
  const seen = new Set<string>()
  const files: RepoFile[] = []
  for (const pattern of patterns) {
    for (const match of globSync(pattern, { cwd: root })) {
      const repoPath = match.split(sep).join('/')
      if (isExcluded(repoPath)) continue
      const abs = resolve(root, repoPath)
      const real = realpathSync(abs)
      if (seen.has(real)) continue
      seen.add(real)
      files.push({ abs, real })
    }
  }
  return files
}

/**
 * Scan regex matches line by line and return the normalized matches rejected by
 * a caller predicate.
 * @param root - absolute repository root used for violation paths.
 * @param absPath - absolute text-file path to scan.
 * @param pattern - global regex matched independently against each line.
 * @param normalize - maps raw regex text to the reference the gate evaluates.
 * @param isViolation - returns true when the normalized reference is invalid.
 * @returns every rejected reference in source order.
 */
export function findReferenceViolations(
  root: string,
  absPath: string,
  pattern: RegExp,
  normalize: (raw: string) => string,
  isViolation: (ref: string) => boolean,
): ReferenceViolation[] {
  const file = relative(root, absPath).split(sep).join('/')
  const out: ReferenceViolation[] = []
  const lines = readFileSync(absPath, 'utf8').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    for (const match of line.matchAll(pattern)) {
      const ref = normalize(match[0])
      if (isViolation(ref)) out.push({ file, line: i + 1, ref })
    }
  }
  return out
}
