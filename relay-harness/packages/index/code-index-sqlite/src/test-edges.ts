/**
 * Test-edge rebuild over the derived SQLite store.
 *
 * Ported from the reference implementation's edge writers
 * (`cc-db/src/index_db_edges.rs`): test edges are path-pair rows derived only
 * from the stored path set plus the path-derived `is_test_file` flag, so a
 * rebuild needs no parse output. The per-path rebuild heals exactly the
 * changed endpoints inside one epoch-bumped transaction; the full rebuild
 * recomputes every pair in memory (equivalent to running the per-path rebuild
 * over all paths) and lands in one delete+insert transaction. Both share the
 * candidate-fragment and LIKE-matching semantics pinned by
 * {@link testStemCandidateFragments} and {@link likeFragmentRegex}; LIKE
 * metacharacters inside fragments stay metacharacters on purpose — that is
 * SQLite LIKE behavior and the reference keeps it verbatim.
 *
 * @module @relay-harness/rlh-code-index-sqlite/test-edges
 */

import type { DatabaseSync } from 'node:sqlite'
import { bumpIndexEpochOnceInTx } from './epoch.ts'

/** Counts reported by one committed test-edge rebuild. */
export interface RebuildTestEdgesResult {
  /** `test_edges` rows written by the rebuild. */
  readonly edgesWritten: number
}

/**
 * Strip the `test_` prefix, then the `_test` suffix, then the `.test`/`.spec`
 * suffix from a test-file stem (`test_stem_to_base_clean` in the reference).
 * A failed prefix or suffix strip falls back to the ORIGINAL stem, not the
 * intermediate value — the reference's `unwrap_or(test_stem)` chain — so
 * `"test_a"` normalizes to `"test_a"`, not `"a"`.
 */
function testStemBaseClean(stem: string): string {
  const afterPrefix = stem.startsWith('test_') ? stem.slice('test_'.length) : stem
  const afterSuffix = afterPrefix.endsWith('_test') ? afterPrefix.slice(0, -'_test'.length) : stem
  if (afterSuffix.endsWith('.test')) return afterSuffix.slice(0, -'.test'.length)
  if (afterSuffix.endsWith('.spec')) return afterSuffix.slice(0, -'.spec'.length)
  return afterSuffix
}

/**
 * Candidate fragments for a test-file stem, shared by the incremental SQL
 * path (wrapped as `%fragment%` LIKE patterns) and the in-memory full
 * rebuild: the `base_clean` stem first (covers same-basename and
 * code-path-overlap matching), then every `_`/`-`-separated stem part of at
 * least three characters other than `"test"` (covers test-path-overlap
 * matching), deduplicated in first-seen order.
 * @param stem - the test file's stem (path without directory or extension).
 * @returns fragments in first-seen order; may be empty for degenerate stems.
 */
export function testStemCandidateFragments(stem: string): string[] {
  const baseClean = testStemBaseClean(stem)
  const fragments: string[] = []
  if (baseClean !== '') fragments.push(baseClean)
  for (const part of stem.split('_')) {
    if (part.length >= 3 && part !== 'test' && !fragments.includes(part)) fragments.push(part)
  }
  for (const part of stem.split('-')) {
    if (part.length >= 3 && part !== 'test' && !fragments.includes(part)) fragments.push(part)
  }
  return fragments
}

/**
 * ASCII-lowercase one character. `String.prototype.toLowerCase` would also
 * fold non-ASCII letters, but SQLite LIKE compares those by codepoint.
 */
function asciiLowerChar(character: string): string {
  const code = character.charCodeAt(0)
  return code >= 0x41 && code <= 0x5a ? String.fromCharCode(code + 0x20) : character
}

/** Escape a literal pattern run so the RegExp constructor reads it verbatim. */
function escapeRegexLiteral(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Compile a `%fragment%` LIKE predicate into a RegExp matched against the
 * ASCII-lowercased path (`like_fragment_regex` in the reference): `_` matches
 * any single character, `%` any run, all other characters literally, and the
 * match searches anywhere — the leading/trailing `%`. SQLite LIKE folds only
 * ASCII case, so both pattern literals and haystacks lowercase ASCII-only.
 *
 * The reference returns `Option` because a compiled regex can fail; the
 * fragments fed here are built from escaped literals plus `.`/`.*` runs, so
 * this port has no failing arm and returns the RegExp directly.
 */
function likeFragmentRegex(fragment: string): RegExp {
  let pattern = ''
  let literal = ''
  for (const character of fragment) {
    if (character === '_' || character === '%') {
      if (literal !== '') {
        pattern += escapeRegexLiteral(literal)
        literal = ''
      }
      pattern += character === '_' ? '.' : '.*'
    } else {
      literal += asciiLowerChar(character)
    }
  }
  if (literal !== '') pattern += escapeRegexLiteral(literal)
  return new RegExp(pattern, 's')
}

/**
 * The stem of a path, with Rust `Path::file_stem` semantics: the final
 * `/`-separated component minus its last `.extension`, where a leading dot
 * with no other dot is not an extension (`".hidden"` stays whole,
 * `"app.test.ts"` stems to `"app.test"`). Workspace-relative store paths are
 * `/`-separated by the provider scanner's contract.
 */
function fileStem(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const lastDot = name.lastIndexOf('.')
  return lastDot > 0 ? name.slice(0, lastDot) : name
}

/** One test edge computed by the in-memory full rebuild. */
interface ComputedTestEdge {
  readonly testFilePath: string
  readonly codeFilePath: string
  readonly reason: 'same-basename' | 'path-overlap'
  readonly confidence: 0.9 | 0.7
}

/**
 * Score one (test, code) candidate pair: `same-basename` at 0.9 when the code
 * stem equals the test stem's `base_clean`, `path-overlap` at 0.7 when either
 * path contains the other side's stem fragment, otherwise no edge.
 */
function scorePair(
  testFilePath: string,
  codeFilePath: string,
  codeStem: string,
  baseClean: string,
): ComputedTestEdge | null {
  if (codeStem === baseClean) {
    return { testFilePath, codeFilePath, reason: 'same-basename', confidence: 0.9 }
  }
  if (codeFilePath.includes(baseClean) || testFilePath.includes(codeStem)) {
    return { testFilePath, codeFilePath, reason: 'path-overlap', confidence: 0.7 }
  }
  return null
}

/**
 * In-memory equivalent of the per-path rebuild over every stored file
 * (`compute_test_edges_full` in the reference): for each test file, candidate
 * code files are those whose ASCII-lowercased path matches at least one
 * compiled fragment regex; candidates then pass the same
 * same-basename/path-overlap scoring. The per-path rebuild's code-file branch
 * (discovering test files from a changed code file) is intentionally absent —
 * with every file in the changed set it contributes nothing new.
 */
function computeTestEdgesFull(files: ReadonlyMap<string, boolean>): ComputedTestEdge[] {
  const codeFiles: Array<{ path: string; lower: string; stem: string }> = []
  for (const [path, isTest] of files) {
    if (!isTest) codeFiles.push({ path, lower: asciiLowerAll(path), stem: fileStem(path) })
  }
  const regexCache = new Map<string, RegExp>()
  const edges: ComputedTestEdge[] = []
  for (const [testPath, isTest] of files) {
    if (!isTest) continue
    const stem = fileStem(testPath)
    const baseClean = testStemBaseClean(stem)
    const fragments = testStemCandidateFragments(stem)
    const matchers: RegExp[] = []
    for (const fragment of fragments) {
      let regex = regexCache.get(fragment)
      if (regex === undefined) {
        regex = likeFragmentRegex(fragment)
        regexCache.set(fragment, regex)
      }
      matchers.push(regex)
    }
    if (matchers.length === 0) continue
    for (const codeFile of codeFiles) {
      if (!matchers.some(regex => regex.test(codeFile.lower))) continue
      const scored = scorePair(testPath, codeFile.path, codeFile.stem, baseClean)
      if (scored !== null) edges.push(scored)
    }
  }
  return edges
}

/** ASCII-lowercase a whole path (haystack side of the LIKE fold). */
function asciiLowerAll(path: string): string {
  let lowered = ''
  for (const character of path) lowered += asciiLowerChar(character)
  return lowered
}

/**
 * Rebuild the test edges of exactly the given paths, inside one
 * index-epoch-bumped transaction. Each path first loses both endpoint halves
 * of its previous edges, then rebuilds from live `files` rows: a test file
 * discovers candidate code files through `%fragment%` LIKE queries over its
 * stem fragments; a code file discovers candidate test files through its stem
 * and stem-part patterns. A path without a `files` row (removed in this
 * batch) keeps its deletions and rebuilds nothing — resurrecting edges for a
 * dead path would diverge from the full rebuild, which only iterates live
 * files. Code-file candidates that are themselves in the changed set are
 * skipped: their own iteration owns their edges.
 * @param db - admitted handle; must not have another transaction open.
 * @param changedPaths - workspace-relative paths written or removed by this batch.
 * @returns what changed, observable only after the COMMIT succeeded. An empty
 *   path list commits nothing and moves no epoch.
 */
export function rebuildTestEdgesForFiles(
  db: DatabaseSync,
  changedPaths: readonly string[],
): RebuildTestEdgesResult {
  if (changedPaths.length === 0) return { edgesWritten: 0 }
  return bumpIndexEpochOnceInTx(db, () => {
    const changedSet = new Set(changedPaths)
    const deleteEndpoints = db.prepare(
      'DELETE FROM test_edges WHERE test_file_path = ? OR code_file_path = ?',
    )
    const readIsTest = db.prepare('SELECT is_test_file FROM files WHERE file_path = ?')
    const insertEdge = db.prepare(`
      INSERT OR REPLACE INTO test_edges (edge_id, test_file_path, code_file_path, reason, confidence)
      VALUES (?, ?, ?, ?, ?)
    `)
    let edgesWritten = 0
    // The reference runs two passes: every changed path loses both endpoint
    // halves first, then the rebuild pass runs — an in-batch pair is rebuilt
    // exactly once by whichever endpoint iterates it, never deleted again by
    // the other endpoint's delete.
    for (const path of changedPaths) {
      deleteEndpoints.run(path, path)
    }
    for (const path of changedPaths) {
      const row = readIsTest.get(path) as { is_test_file: number } | undefined
      if (row === undefined) continue
      const scored = row.is_test_file === 1
        ? edgesForTestFile(db, path, insertEdge)
        : edgesForCodeFile(db, path, insertEdge, changedSet)
      edgesWritten += scored
    }
    return { edgesWritten }
  })
}

/** Candidate paths reached by the given LIKE patterns, first-seen deduplicated. */
function likeCandidates(db: DatabaseSync, patterns: readonly string[], isTestFile: boolean): string[] {
  const seen = new Set<string>()
  const candidates: string[] = []
  const query = db.prepare(
    `SELECT file_path FROM files WHERE is_test_file = ${isTestFile ? 1 : 0} AND file_path LIKE ?`,
  )
  for (const pattern of patterns) {
    for (const row of query.all(pattern) as Array<{ file_path: string }>) {
      if (!seen.has(row.file_path)) {
        seen.add(row.file_path)
        candidates.push(row.file_path)
      }
    }
  }
  return candidates
}

/** Write the scored edges of one changed test file; returns the row count. */
function edgesForTestFile(
  db: DatabaseSync,
  testPath: string,
  insertEdge: ReturnType<DatabaseSync['prepare']>,
): number {
  const stem = fileStem(testPath)
  const baseClean = testStemBaseClean(stem)
  const patterns = testStemCandidateFragments(stem).map(fragment => `%${fragment}%`)
  let written = 0
  for (const codePath of likeCandidates(db, patterns, false)) {
    const scored = scorePair(testPath, codePath, fileStem(codePath), baseClean)
    if (scored === null) continue
    insertEdge.run(`test:${testPath}:${codePath}`, testPath, codePath, scored.reason, scored.confidence)
    written += 1
  }
  return written
}

/** Write the scored edges of one changed code file; returns the row count. */
function edgesForCodeFile(
  db: DatabaseSync,
  codePath: string,
  insertEdge: ReturnType<DatabaseSync['prepare']>,
  changedSet: ReadonlySet<string>,
): number {
  const codeStem = fileStem(codePath)
  // The code-stem pattern covers test-path-overlap matches; the stem-part
  // patterns cover pairs where the test's base_clean is a sub-segment of the
  // code stem (`user_service` also searches `%user%` and `%service%`).
  const patterns: string[] = []
  if (codeStem !== '') patterns.push(`%${codeStem}%`)
  for (const part of [...codeStem.split('_'), ...codeStem.split('-')]) {
    if (part.length < 3) continue
    const pattern = `%${part}%`
    if (!patterns.includes(pattern)) patterns.push(pattern)
  }
  let written = 0
  for (const testPath of likeCandidates(db, patterns, true)) {
    // A test file in the changed set rebuilds its own edges in its iteration.
    if (changedSet.has(testPath)) continue
    const baseClean = testStemBaseClean(fileStem(testPath))
    const scored = scorePair(testPath, codePath, codeStem, baseClean)
    if (scored === null) continue
    insertEdge.run(`test:${testPath}:${codePath}`, testPath, codePath, scored.reason, scored.confidence)
    written += 1
  }
  return written
}

/**
 * Rebuild every test edge from the whole stored path set: matching runs
 * entirely in memory over `(file_path, is_test_file)` — test edges depend on
 * nothing else — then the full replacement lands in one delete+insert
 * transaction. Equivalent to running {@link rebuildTestEdgesForFiles} over
 * every stored path, minus that path's per-path edge deletes.
 * @param db - admitted handle; must not have another transaction open.
 * @returns what changed, observable only after the COMMIT succeeded.
 */
export function rebuildTestEdgesFull(db: DatabaseSync): RebuildTestEdgesResult {
  return bumpIndexEpochOnceInTx(db, () => {
    const rows = db.prepare('SELECT file_path, is_test_file FROM files').all() as Array<{
      file_path: string
      is_test_file: number
    }>
    const files = new Map(rows.map(row => [row.file_path, row.is_test_file === 1]))
    const edges = computeTestEdgesFull(files)
    db.prepare('DELETE FROM test_edges').run()
    const insertEdge = db.prepare(`
      INSERT OR REPLACE INTO test_edges (edge_id, test_file_path, code_file_path, reason, confidence)
      VALUES (?, ?, ?, ?, ?)
    `)
    for (const edge of edges) {
      insertEdge.run(
        `test:${edge.testFilePath}:${edge.codeFilePath}`,
        edge.testFilePath,
        edge.codeFilePath,
        edge.reason,
        edge.confidence,
      )
    }
    return { edgesWritten: edges.length }
  })
}
