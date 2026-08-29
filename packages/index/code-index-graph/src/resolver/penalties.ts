/**
 * Free helper functions and confidence tables shared by the resolver modules,
 * ported from the reference implementation's `resolver/helpers.rs` and
 * `resolver/types.rs` kind metadata.
 *
 * @module penalties
 */

import type {
  CallEdgeRow,
  CatalogScope,
  ImportBinding,
  ImportRow,
  InternalResKind,
  ResolutionKind,
  ResolveStep,
  StrategyName,
} from '../types.ts'

/** Minimal shape the path/pool helpers need from a catalog entry. */
export interface CatalogEntryLike {
  /** Positional symbol id; dedup keys on it. */
  readonly symbolId: string
  /** Workspace-relative file path. */
  readonly filePath: string
}

/**
 * Base confidence per internal kind, ported verbatim from the reference's
 * `InternalResKind::base_confidence`.
 */
export const BASE_CONFIDENCE: Readonly<Record<InternalResKind, number>> = Object.freeze({
  exact: 1.0,
  qualified: 0.95,
  scope_resolved: 0.9,
  import_resolved: 0.85,
  global_unique: 0.75,
  suffix_match: 0.65,
  heuristic: 0.5,
  fuzzy_single: 0.40,
  // Between fuzzy_single (0.40) and global_unique (0.75): the call-site signal
  // positively discriminated among same-name candidates (stronger evidence than
  // an uncontested single match), but parser-derived arg counts and receiver
  // text are themselves heuristic, so it must stay below the global-uniqueness
  // proof.
  fuzzy_signal: 0.55,
  fuzzy_multi: 0.30,
  unresolved: 0.0,
})

/** Kind-level strategy labels; signal-narrowed wins override per result. */
const KIND_STRATEGY: Readonly<Record<InternalResKind, StrategyName>> = Object.freeze({
  exact: 'exact',
  qualified: 'qualified',
  scope_resolved: 'scope',
  import_resolved: 'import_map',
  global_unique: 'global_unique',
  suffix_match: 'suffix',
  heuristic: 'heuristic',
  fuzzy_single: 'fuzzy_single',
  fuzzy_signal: 'fuzzy_signal',
  fuzzy_multi: 'fuzzy_multi',
  unresolved: 'unresolved',
})

/**
 * Internal kind → stored `resolution_kind`, ported from `to_resolution_kind`:
 * ImportResolved folds into `scope_resolved` and every fuzzy/name-evidence
 * kind folds into `heuristic`.
 *
 * @param kind - Internal resolution kind of a ladder result.
 * @returns The stored `resolution_kind` value.
 */
export function toResolutionKind(kind: InternalResKind): ResolutionKind {
  switch (kind) {
    case 'exact':
      return 'exact'
    case 'qualified':
      return 'qualified'
    case 'scope_resolved':
    case 'import_resolved':
      return 'scope_resolved'
    case 'global_unique':
    case 'suffix_match':
    case 'heuristic':
    case 'fuzzy_single':
    case 'fuzzy_signal':
    case 'fuzzy_multi':
      return 'heuristic'
    case 'unresolved':
      return 'unresolved'
  }
}

/**
 * Kind-level strategy label for a resolved candidate.
 *
 * @param kind - Internal resolution kind of a ladder result.
 * @returns The kind-level `resolution_strategy` value.
 */
export function strategyNameOf(kind: InternalResKind): StrategyName {
  return KIND_STRATEGY[kind]
}

/**
 * Strategy label for a ladder result: signal-narrowed fuzzy wins get
 * step-specific labels; every other step keeps the kind-level label.
 *
 * @param kind - Resolution kind the winning step produced.
 * @param winningStep - Ladder step that produced the result.
 * @returns The stored `resolution_strategy` value.
 */
export function strategyForResult(kind: InternalResKind, winningStep: ResolveStep): StrategyName {
  if (winningStep === 'fuzzy_arg_count') return 'fuzzy_arg_count'
  if (winningStep === 'fuzzy_receiver') return 'fuzzy_receiver'
  return strategyNameOf(kind)
}

/**
 * Default confidence backfilled onto rows that carry none, per stored
 * `resolution_kind` (`default_resolution_confidence`).
 *
 * @param kind - Stored resolution kind of the row.
 * @returns The default confidence in `[0, 1]`.
 */
export function defaultResolutionConfidence(kind: ResolutionKind): number {
  switch (kind) {
    case 'exact':
      return 1.0
    case 'qualified':
      return 0.95
    case 'scope_resolved':
      return 0.9
    case 'heuristic':
      return 0.5
    case 'unresolved':
      return 0.0
  }
}

/**
 * Default strategy backfilled onto rows that carry none, per stored
 * `resolution_kind` (`default_resolution_strategy`).
 *
 * @param kind - Stored resolution kind of the row.
 * @returns The parser-provenance strategy label.
 */
export function defaultResolutionStrategy(kind: ResolutionKind): string {
  switch (kind) {
    case 'exact':
      return 'parser_exact'
    case 'qualified':
      return 'parser_qualified'
    case 'scope_resolved':
      return 'parser_scope'
    case 'heuristic':
      return 'heuristic'
    case 'unresolved':
      return 'unresolved'
  }
}

/**
 * Penalize confidence when multiple candidates exist: no penalty for 1–3,
 * linear decay capped at `3/count` beyond that
 * (`candidate_count_penalty`).
 *
 * @param base - Confidence before the count penalty.
 * @param count - Number of candidates the winning step considered.
 * @returns The penalized confidence.
 */
export function candidateCountPenalty(base: number, count: number): number {
  if (count <= 3) return base
  return base * Math.min(1, 3 / count)
}

/** Source extensions stripped before path comparison. */
const PATH_EXTENSIONS = ['.py', '.ts', '.tsx', '.js', '.jsx', '.rs', '.go', '.java'] as const

/**
 * Strip common source-file extensions for path comparison.
 *
 * @param path - File path as stored.
 * @returns The path without a recognized source extension.
 */
export function stripExt(path: string): string {
  for (const ext of PATH_EXTENSIONS) {
    if (path.endsWith(ext)) return path.slice(0, -ext.length)
  }
  return path
}

/**
 * Strip the file extension and convert path separators to dots
 * (`strip_ext_to_dotted`).
 *
 * @param path - File path or module path as stored.
 * @returns Dotted module form of the path.
 */
export function stripExtToDotted(path: string): string {
  return stripExt(path).replace(/\//g, '.')
}

/**
 * Check whether `a` is a dot-prefix of `b` or vice versa; `"src.utils"` is a
 * prefix of `"src.utils.helpers"` but not of `"src.utilsXtra"`.
 *
 * @param a - First dotted module path.
 * @param b - Second dotted module path.
 * @returns True when one is a segment-aligned prefix of the other or they match.
 */
export function dottedPrefixMatch(a: string, b: string): boolean {
  if (a === b) return true
  if (b.length > a.length && b.startsWith(a) && b[a.length] === '.') return true
  if (a.length > b.length && a.startsWith(b) && a[b.length] === '.') return true
  return false
}

/**
 * Whether a candidate symbol's file is reachable through the current file's
 * import chain: any import's source module is a dot-prefix of the candidate's
 * module path or vice versa (`is_import_reachable`).
 *
 * @param candidateFile - File path of the candidate symbol.
 * @param imports - Import bindings of the resolving file.
 * @returns True when some import reaches the candidate's module tree.
 */
export function isImportReachable(candidateFile: string, imports: readonly ImportBinding[]): boolean {
  if (imports.length === 0) return false
  const candidateModule = stripExtToDotted(candidateFile)
  return imports.some(imp => dottedPrefixMatch(candidateModule, stripExtToDotted(imp.sourceModule)))
}

/**
 * Count the common `/`-separated directory prefix segments between two file
 * paths, extensions stripped first so `a.py` vs `a.ts` in one directory still
 * count as co-located (`common_path_prefix_len`).
 *
 * @param a - First file path.
 * @param b - Second file path.
 * @returns Number of leading equal segments.
 */
export function commonPathPrefixLen(a: string, b: string): number {
  const segA = stripExt(a).split('/')
  const segB = stripExt(b).split('/')
  let count = 0
  while (count < segA.length && count < segB.length && segA[count] === segB[count]) count += 1
  return count
}

/**
 * Among candidate indices, pick the one whose file shares the longest common
 * path prefix with `currentFile` (`best_by_import_distance`); ties keep the
 * last tied candidate, matching `Iterator::max_by_key`'s winner.
 *
 * @param entries - Catalog entries backing the indices.
 * @param candidates - Candidate entry indices.
 * @param currentFile - File the resolution runs from.
 * @returns The winning index, or `undefined` for an empty candidate list.
 */
export function bestByImportDistance(
  entries: readonly CatalogEntryLike[],
  candidates: readonly number[],
  currentFile: string,
): number | undefined {
  let best: number | undefined
  let bestDistance = -1
  for (const idx of candidates) {
    const distance = commonPathPrefixLen((entries[idx] as CatalogEntryLike).filePath, currentFile)
    if (distance >= bestDistance) {
      best = idx
      bestDistance = distance
    }
  }
  return best
}

/**
 * Pick candidates deduplicated by symbol id, keeping first-occurrence order;
 * `undefined` unless exactly one distinct symbol survives (`pick_unique`).
 *
 * @param entries - Catalog entries backing the indices.
 * @param candidates - Candidate entry indices.
 * @returns The single surviving index, or `undefined`.
 */
export function pickUnique(
  entries: readonly CatalogEntryLike[],
  candidates: readonly number[],
): number | undefined {
  const seen = new Set<string>()
  let unique: number | undefined
  for (const idx of candidates) {
    const id = (entries[idx] as CatalogEntryLike).symbolId
    if (seen.has(id)) continue
    if (unique !== undefined) return undefined
    seen.add(id)
    unique = idx
  }
  return unique
}

/**
 * Deduplicate indices by symbol id, keeping first-occurrence order
 * (`dedup_by_id`).
 *
 * @param entries - Catalog entries backing the indices.
 * @param indices - Candidate entry indices.
 * @returns Indices with repeated symbol ids dropped.
 */
export function dedupById(
  entries: readonly CatalogEntryLike[],
  indices: readonly number[],
): number[] {
  const seen = new Set<string>()
  const kept: number[] = []
  for (const idx of indices) {
    const id = (entries[idx] as CatalogEntryLike).symbolId
    if (seen.has(id)) continue
    seen.add(id)
    kept.push(idx)
  }
  return kept
}

/** Walking state shared by the scope-chain helpers. */
export interface ScopeLookupInput {
  /** Scope map of the resolved file set, keyed by scope id. */
  readonly scopes: ReadonlyMap<string, CatalogScope>
  /** File whose scopes are probed. */
  readonly file: string
  /** Call-site line. */
  readonly line: number
}

/**
 * Find the innermost scope of `file` containing `line`: smallest span first,
 * start line as the tiebreak (`scope_for_line`).
 *
 * @param input - Scope lookup state.
 * @returns The innermost containing scope, or `undefined`.
 */
export function scopeForLine(input: ScopeLookupInput): CatalogScope | undefined {
  let best: CatalogScope | undefined
  let bestSpan = Number.POSITIVE_INFINITY
  let bestStart = Number.POSITIVE_INFINITY
  for (const scope of input.scopes.values()) {
    if (scope.filePath !== input.file) continue
    if (scope.startLine > input.line || input.line > scope.endLine) continue
    const span = scope.endLine - scope.startLine
    if (span < bestSpan || (span === bestSpan && scope.startLine < bestStart)) {
      best = scope
      bestSpan = span
      bestStart = scope.startLine
    }
  }
  return best
}

/**
 * Walk the `parentId` chain upward from `scopeId`, innermost first; cycles
 * break the walk (`scope_chain`).
 *
 * @param scopes - Scope map keyed by scope id.
 * @param scopeId - Scope to walk from.
 * @returns Chain of scopes from innermost to outermost.
 */
export function scopeChain(
  scopes: ReadonlyMap<string, CatalogScope>,
  scopeId: string,
): CatalogScope[] {
  const chain: CatalogScope[] = []
  const seen = new Set<string>()
  let current: string | null = scopeId
  while (current !== null && !seen.has(current)) {
    seen.add(current)
    const scope = scopes.get(current)
    if (!scope) break
    chain.push(scope)
    current = scope.parentId
  }
  return chain
}

/**
 * Count hops from `current` to `target` along the parent chain; `undefined`
 * when unreachable (`scope_distance`).
 *
 * @param scopes - Scope map keyed by scope id.
 * @param current - Scope to walk from.
 * @param target - Scope to reach.
 * @returns Hop count, or `undefined`.
 */
export function scopeDistance(
  scopes: ReadonlyMap<string, CatalogScope>,
  current: string,
  target: string,
): number | undefined {
  const position = scopeChain(scopes, current).findIndex(scope => scope.scopeId === target)
  return position === -1 ? undefined : position
}

/**
 * Build alias map: local name → qualified imported name
 * (`SymbolCatalog::build_alias_map`).
 *
 * @param imports - Import bindings of the file.
 * @returns Map keyed by local import name.
 */
export function buildAliasMap(imports: readonly ImportBinding[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const imp of imports) {
    map.set(imp.localName, `${imp.sourceModule}:${imp.importedName ?? imp.localName}`)
  }
  return map
}

/**
 * Classify a call by its callee name and import context
 * (`SymbolCatalog::classify_call_kind`).
 *
 * @param calleeName - Callee text as written at the call site.
 * @param imports - Import bindings of the resolving file.
 * @returns One of `constructor`, `method`, `imported`, `local`.
 */
export function classifyCallKind(calleeName: string, imports: readonly ImportBinding[]): CallKindName {
  if (calleeName.includes('.')) {
    const last = calleeName.slice(calleeName.lastIndexOf('.') + 1)
    if (last === '__init__' || /^[A-Z]/.test(last)) return 'constructor'
    return 'method'
  }
  const head = calleeName.split('.')[0] as string
  if (imports.some(binding => binding.localName === head)) return 'imported'
  if (/^[A-Z]/.test(calleeName)) return 'constructor'
  return 'local'
}

/** Return type of {@link classifyCallKind}. */
export type CallKindName = 'constructor' | 'method' | 'imported' | 'local'

/**
 * Project one import row into a resolution binding: the alias wins, then the
 * imported name, then the module specifier's tail segment; rows without a
 * resolved path or with a blank local name are skipped
 * (`SymbolCatalog::build_import_bindings`). The namespace flag rides the row;
 * the tail-of-namespace semantics are applied in the import step.
 *
 * @param row - Import row as stored.
 * @returns The binding, or `null` when the row cannot name a local binding.
 */
export function importBindingOf(row: ImportRow): ImportBinding | null {
  if (row.resolvedPath === null) return null
  const localName = row.alias ?? row.importedName ?? tailSegment(row.importString)
  if (localName.trim() === '') return null
  return {
    localName,
    sourceModule: row.resolvedPath,
    importedName: row.importedName,
    filePath: row.filePath,
    isNamespace: row.isNamespace,
    isDefault: row.isDefault,
  }
}

/**
 * The reference's import-string fallback rule, replicated verbatim: the last
 * `/` segment, then the segment after the last `.` — for extension-bearing
 * specifiers that yields the extension (`'pkg/lib.py'` → `'py'`), which the
 * reference accepts because rows with a meaningful clause always carry an
 * alias or imported name.
 *
 * @param importString - Module specifier as written.
 * @returns The tail segment naming the local binding.
 */
function tailSegment(importString: string): string {
  const lastSegment = importString.slice(importString.lastIndexOf('/') + 1)
  const dot = lastSegment.lastIndexOf('.')
  return dot === -1 ? lastSegment : lastSegment.slice(dot + 1)
}

/**
 * Whether the ladder runs with rich context for a file: lexical scopes or
 * import bindings present (`has_rich_context`); without either, rows fall to
 * the find-best fallback exactly as in the reference.
 *
 * @param scopes - Scope map of the file set.
 * @param imports - Import bindings of the file.
 * @returns True when the full ladder may run.
 */
export function hasRichContext(
  scopes: ReadonlyMap<string, CatalogScope>,
  imports: readonly ImportBinding[],
): boolean {
  return scopes.size > 0 || imports.length > 0
}

/**
 * Signals of a call edge: the parser's arg count, and the explicit receiver
 * or the dotted callee head (`"obj.method"` → `"obj"`).
 *
 * @param edge - Call edge being resolved.
 * @returns The call-site signals.
 */
export function signalsOf(edge: CallEdgeRow): { argCount: number | null; receiver: string | null } {
  const receiver = edge.receiverExpr ?? splitHead(edge.calleeSymbol)
  return { argCount: edge.argCount, receiver }
}

/** Head segment of a dotted callee, or `null` for a plain identifier. */
function splitHead(callee: string): string | null {
  const dot = callee.indexOf('.')
  return dot === -1 ? null : callee.slice(0, dot)
}
