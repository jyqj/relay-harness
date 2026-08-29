/**
 * Minimal `.gitignore`-style pattern evaluation for the local scanner.
 *
 * The scanner stacks three exclusion layers (built-in hard excludes, the
 * parsed `.gitignore` files, and explicit config excludes) plus one inclusion
 * layer (workspace include globs), and every layer evaluates paths through
 * this module's matcher. Supported syntax stays deliberately small — comment
 * and blank lines, `!` negation (last match wins), a trailing `/` marking a
 * directory-only rule, anchoring at the root for patterns containing `/`
 * elsewhere, `**` globstar segments, and per-segment `*` / `?` wildcards.
 * The scanner composes one filter per discovered `.gitignore`, rebasing each
 * document to its owning directory and applying the deepest matching rule
 * last, as Git does.
 *
 * @module @relay-harness/rlh-code-index-local/gitignore
 */

import { readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

/** One parsed pattern line with its gitignore modifiers resolved. */
export interface GitignoreRule {
  /** A matching path unmatches instead of matches (`!` prefix). */
  readonly negated: boolean
  /** Only directories satisfy this rule (trailing `/`). */
  readonly directoryOnly: boolean
  /** Match starts at the workspace root, not at any depth. */
  readonly anchored: boolean
  /** Pattern body without its modifiers, still containing glob metacharacters. */
  readonly pattern: string
}

/** Path predicate shared by the exclusion layers of the scanner. */
export interface PathExclusionFilter {
  /**
   * Decide whether one relative POSIX path is excluded.
   * @param relPath - workspace-relative path using `/` separators.
   * @param isDirectory - whether {@link relPath} names a directory; lets
   *   directory-only rules hit it directly and lets generic rules imply
   *   exclusion of everything below a matched directory.
   */
  excludes(relPath: string, isDirectory?: boolean): boolean
  /** Return this document's winning rule, or `undefined` when none matched. */
  decision?(relPath: string, isDirectory?: boolean): boolean | undefined
}

/** Path predicate accepting files that any include pattern matches. */
export interface PathInclusionMatcher {
  /**
   * Decide whether one file-level relative POSIX path satisfies the pattern set.
   * @param relPath - workspace-relative path using `/` separators.
   */
  matches(relPath: string): boolean
}

/**
 * Parse one `.gitignore` document into ordered rules.
 * @param content - raw document text; line order carries precedence.
 * @returns the rules in source order; comments and blank lines dropped.
 */
export function parseGitignoreRules(content: string): readonly GitignoreRule[] {
  const rules: GitignoreRule[] = []
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    let body = line.replace(/^\\([#!])/u, '$1')
    let negated = false
    if (body.startsWith('!')) {
      negated = true
      body = body.slice(1)
    }
    let directoryOnly = false
    if (body.endsWith('/')) {
      directoryOnly = true
      body = body.slice(0, -1)
    }
    const anchored = body.includes('/')
    if (body === '' || body === '/') continue
    rules.push({ negated, directoryOnly, anchored, pattern: body })
  }
  return rules
}

/** Characters that must lose their regex meaning inside one path segment. */
const SEGMENT_LITERAL_ESCAPE = /[.+^${}()|[\]\\]/gu

/** Translate one non-globstar segment: literals kept, `*`/`?` bounded to the segment. */
function segmentToSource(segment: string): string {
  return segment
    .replace(SEGMENT_LITERAL_ESCAPE, '\\$&')
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]')
}

/**
 * Compile one rule into an anchored regular expression over full relative
 * paths. Trailing double-globstar segments collapse away because the scanner
 * prunes matched directories physically, so descendants never need their own
 * match; every globstar segment — including the canonical leading one of
 * include globs — matches zero or more whole intermediate segments.
 */
function ruleToRegExp(rule: GitignoreRule): RegExp {
  const segments = rule.pattern.split('/').filter(part => part !== '')
  while (segments.length > 0 && segments[segments.length - 1] === '**') segments.pop()
  let source = '^'
  if (!rule.anchored) source += '(?:[^/]+/)*'
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index] as string
    const last = index === segments.length - 1
    if (segment === '**') {
      // Globstar: zero or more whole intermediate segments. Trailing globstars
      // were collapsed above, so one can never appear last here.
      source += '(?:[^/]+/)*'
      continue
    }
    source += segmentToSource(segment)
    if (!last) source += '/'
  }
  return new RegExp(`${source}$`, 'u')
}

/**
 * The candidate spellings a rule may hit for one path: the path itself plus
 * every proper ancestor directory. Testing ancestors lets generic rules like
 * `logs` exclude everything below any such directory, which pairs with the
 * scanner pruning excluded directories before descending.
 */
function candidatesOf(relPath: string, isDirectory: boolean, directoryOnlyRule: boolean): readonly string[] {
  const parts = relPath.split('/')
  const prefixes: string[] = []
  for (let depth = 1; depth < parts.length; depth++) {
    prefixes.push(parts.slice(0, depth).join('/'))
  }
  if (isDirectory || !directoryOnlyRule) return [relPath, ...prefixes]
  return prefixes
}

/**
 * Evaluate rules over a path set. Later rules override earlier ones; the
 * final verdict excludes unless the winning hit was a negation.
 */
function evaluateDecision(
  rules: readonly GitignoreRule[],
  compiled: readonly RegExp[],
  relPath: string,
  isDirectory: boolean,
): boolean | undefined {
  let excluded: boolean | undefined
  for (let index = 0; index < rules.length; index++) {
    const rule = rules[index] as GitignoreRule
    const regexp = compiled[index]
    const candidates = candidatesOf(relPath, isDirectory, rule.directoryOnly)
    const hit = candidates.some(candidate => regexp?.test(candidate) === true)
    if (hit) excluded = !rule.negated
  }
  return excluded
}

function compileFilter(rules: readonly GitignoreRule[]): PathExclusionFilter {
  const compiled = rules.map(ruleToRegExp)
  const decision = (relPath: string, isDirectory = false): boolean | undefined =>
    evaluateDecision(rules, compiled, relPath, isDirectory)
  return {
    decision,
    excludes: (relPath, isDirectory = false) => decision(relPath, isDirectory) === true,
  }
}

/**
 * Build an exclusion filter from pattern lines sharing the `.gitignore` grammar.
 * @param patterns - ordered pattern strings; joined with newlines and parsed once.
 * @returns one filter whose `excludes` applies the full rule chain per query.
 */
export function exclusionFilterFromPatterns(patterns: readonly string[]): PathExclusionFilter {
  return compileFilter(parseGitignoreRules(patterns.join('\n')))
}

/**
 * Build an inclusion matcher from include-style globs. Files qualify when any
 * pattern matches their own path; ancestor components play no role here, and
 * negation is not supported on the include layer.
 * @param patterns - include globs in the same grammar, matched at any depth.
 * @returns one matcher answering per-file acceptance queries.
 */
export function inclusionMatcherFromPatterns(patterns: readonly string[]): PathInclusionMatcher {
  const rules = parseGitignoreRules(patterns.join('\n'))
  const compiled = rules.map(ruleToRegExp)
  return {
    matches(relPath: string): boolean {
      return compiled.some(regexp => regexp.test(relPath))
    },
  }
}

/**
 * Load one directory's `.gitignore` as an exclusion filter. The scanner owns
 * rebasing it to that directory and ordering it relative to ancestor files.
 * @param root - absolute directory whose direct `.gitignore` applies.
 * @returns the filter, or `undefined` when no `.gitignore` exists.
 */
export async function loadWorkspaceGitIgnore(root: string): Promise<PathExclusionFilter | undefined> {
  try {
    const content = await readFile(join(root, '.gitignore'), 'utf8')
    return compileFilter(parseGitignoreRules(content))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * Load the repository-local Git exclude document, including linked worktrees.
 * @param root - workspace root containing a `.git` directory or gitdir file.
 * @returns the compiled low-precedence filter, or `undefined` outside Git or when absent.
 */
export async function loadWorkspaceGitInfoExclude(root: string): Promise<PathExclusionFilter | undefined> {
  const dotGit = join(root, '.git')
  let metadata: Awaited<ReturnType<typeof stat>>
  try {
    metadata = await stat(dotGit)
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT')) return undefined
    throw error
  }
  if (metadata.isDirectory()) return loadOptionalIgnore(join(dotGit, 'info', 'exclude'))
  if (!metadata.isFile()) return undefined
  const marker = await readFile(dotGit, 'utf8')
  const match = /^gitdir:\s*(.+?)\s*$/imu.exec(marker)
  if (match?.[1] === undefined) return undefined
  const gitDirectory = resolve(root, match[1])
  const direct = await loadOptionalIgnore(join(gitDirectory, 'info', 'exclude'))
  if (direct !== undefined) return direct
  let commonDirectory: string
  try {
    commonDirectory = resolve(gitDirectory, (await readFile(join(gitDirectory, 'commondir'), 'utf8')).trim())
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT')) return undefined
    throw error
  }
  return loadOptionalIgnore(join(commonDirectory, 'info', 'exclude'))
}

async function loadOptionalIgnore(path: string): Promise<PathExclusionFilter | undefined> {
  try {
    return compileFilter(parseGitignoreRules(await readFile(path, 'utf8')))
  } catch (error: unknown) {
    if (isErrnoCode(error, 'ENOENT')) return undefined
    throw error
  }
}

function isErrnoCode(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
