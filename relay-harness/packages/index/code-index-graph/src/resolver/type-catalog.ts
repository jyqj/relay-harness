/**
 * Lightweight type catalog for method-dispatch resolution, ported from the
 * reference implementation's `type_catalog.rs`, together with the
 * second-pass adjudication that decides whether a type-catalog proposal may
 * touch an already-processed call edge (`resolver/resolve_outcome.rs`).
 *
 * This is not a type system: it indexes information directly visible in
 * declarations (receiver types, parameter counts, base types, aliases,
 * variable type assignments) and uses it for disambiguation during
 * resolution.
 *
 * @module type-catalog
 */

import type { CallEdgeRow, ResolutionKind, SymbolKind, SymbolRow, TypeAssignRow } from '../types.ts'

/** One method entry in the type catalog. */
interface MethodEntry {
  /** Symbol uid of the declaring method/function. */
  readonly symbolUid: string
  /** Recorded receiver type, when the parser annotated one. */
  readonly receiverType: string | null
  /** Recorded parameter count, when the parser counted parameters. */
  readonly paramCount: number | null
}

/** Type-hierarchy information for one named type. */
interface TypeInfo {
  /** Declared base types. */
  readonly baseTypes: string[]
  /** Declared implemented interfaces. */
  readonly implementsList: string[]
}

/** Identity facets of a symbol that key its type-catalog contributions. */
export interface SymbolKeyMeta {
  /** Declared short name. */
  readonly name: string
  /** Qualified name, when derived. */
  readonly qname: string | null
  /** Declared kind. */
  readonly kind: SymbolKind
  /** Semantic symbol uid, or `null` for uid-less symbols (never indexed). */
  readonly symbolUid: string | null
}

/** Alias-chase depth cap that also stops cyclic alias chains. */
const MAX_ALIAS_CHASE = 16

/**
 * The lightweight type catalog: method lookup by receiver type, method
 * disambiguation by parameter count, alias chasing, and one-level subtype
 * checks. Contributions are stored per (file, value) so a removed file's
 * contribution disappears without erasing another file's; reads take the last
 * live contribution, preserving insert-overwrite semantics.
 */
export class TypeCatalog {
  /** Lowercased method name → method entries. */
  private readonly methodIndex = new Map<string, MethodEntry[]>()
  /** Lowercased canonical qname → per-file contributions; the last is live. */
  private readonly typeIndexByQname = new Map<string, { file: string; value: TypeInfo }[]>()
  /** Lowercased short name → (file, canonical qname) pairs; readers reduce to the distinct qname set. */
  private readonly shortToQnames = new Map<string, { file: string; value: string }[]>()
  /** Lowercased alias name → per-file targets; the last entry is live. */
  private readonly typeAliases = new Map<string, { file: string; value: string }[]>()
  /** (file, lowercased var name) → inferred type name. */
  private readonly typeAssignIndex = new Map<string, string>()

  /**
   * Register every row's contributions (`build_from_symbols`).
   *
   * @param rows - Symbol rows to index.
   */
  buildFromSymbols(rows: readonly SymbolRow[]): void {
    for (const row of rows) this.addSymbol(row)
  }

  /**
   * Register one symbol's contributions (methods, type hierarchy, alias),
   * insertion-order semantics matching the reference's build loop.
   *
   * @param row - Symbol row to index.
   */
  addSymbol(row: SymbolRow): void {
    const uid = row.symbolUid
    if (uid === null) return

    switch (row.kind) {
      case 'method':
      case 'function': {
        const entry: MethodEntry = {
          symbolUid: uid,
          receiverType: row.receiverType,
          paramCount: row.paramCount,
        }
        pushToBucket(this.methodIndex, row.name.toLowerCase(), entry)
        break
      }
      case 'class':
      case 'interface':
      case 'enum': {
        const base = splitTypeList(row.baseTypes)
        const impls = splitTypeList(row.implements)
        const canonicalKey = (row.qname ?? row.name).toLowerCase()
        appendContribution(this.typeIndexByQname, canonicalKey, row.filePath, { baseTypes: base, implementsList: impls })
        appendContribution(this.shortToQnames, row.name.toLowerCase(), row.filePath, canonicalKey)
        break
      }
      case 'type_alias': {
        const first = row.baseTypes === null ? '' : (row.baseTypes.split(',')[0] as string).trim()
        if (first !== '') {
          appendContribution(this.typeAliases, row.name.toLowerCase(), row.filePath, first.toLowerCase())
        }
        break
      }
      default:
        break
    }
  }

  /**
   * Remove the contributions of symbols that lived in `removedFiles`; only
   * the affected buckets are probed. Variable type assignments are
   * build-local state and are not cleaned here.
   *
   * @param removed - Key facets of every removed symbol.
   * @param removedFiles - Files whose symbols left the catalog.
   */
  removeFiles(removed: readonly SymbolKeyMeta[], removedFiles: ReadonlySet<string>): void {
    const removedUids = new Set<string>()
    const methodKeys = new Set<string>()
    const typeKeys = new Set<string>()
    const aliasKeys = new Set<string>()
    for (const meta of removed) {
      if (meta.symbolUid === null) continue
      switch (meta.kind) {
        case 'method':
        case 'function':
          removedUids.add(meta.symbolUid)
          methodKeys.add(meta.name.toLowerCase())
          break
        case 'class':
        case 'interface':
        case 'enum':
          typeKeys.add(`${(meta.qname ?? meta.name).toLowerCase()}\u0000${meta.name.toLowerCase()}`)
          break
        case 'type_alias':
          aliasKeys.add(meta.name.toLowerCase())
          break
        default:
          break
      }
    }

    for (const key of methodKeys) {
      retain(this.methodIndex, key, bucket => bucket.filter(entry => !removedUids.has(entry.symbolUid)))
    }
    for (const key of typeKeys) {
      const sep = key.indexOf('\u0000')
      const canonical = key.slice(0, sep)
      const short = key.slice(sep + 1)
      retain(this.typeIndexByQname, canonical, bucket => bucket.filter(item => !removedFiles.has(item.file)))
      retain(this.shortToQnames, short, bucket => bucket.filter(item => !removedFiles.has(item.file)))
    }
    for (const key of aliasKeys) {
      retain(this.typeAliases, key, bucket => bucket.filter(item => !removedFiles.has(item.file)))
    }
  }

  /**
   * Populate the variable type-assignment index; last write wins per
   * (file, variable).
   *
   * @param assigns - Type-assign rows from the changed files.
   */
  addTypeAssigns(assigns: readonly TypeAssignRow[]): void {
    for (const assign of assigns) {
      this.typeAssignIndex.set(`${assign.filePath}\u0000${assign.varName.toLowerCase()}`, assign.typeName)
    }
  }

  /**
   * Discard variable type assignments: they are derived from the current
   * batch's parse outcomes only, so a reused catalog must reset them.
   */
  resetTypeAssigns(): void {
    this.typeAssignIndex.clear()
  }

  /**
   * Resolve a variable name to its inferred type within a file
   * (`resolve_var_type`).
   *
   * @param filePath - File the variable lives in.
   * @param varName - Variable name as written.
   * @returns The inferred type name, or `undefined`.
   */
  resolveVarType(filePath: string, varName: string): string | undefined {
    return this.typeAssignIndex.get(`${filePath}\u0000${varName.toLowerCase()}`)
  }

  /**
   * Whether any method entries are indexed (`has_methods`).
   *
   * @returns True when the catalog holds methods.
   */
  hasMethods(): boolean {
    return this.methodIndex.size > 0
  }

  /**
   * Declared parameter count of one specific method symbol
   * (`method_param_count`).
   *
   * @param methodName - Method short name.
   * @param symbolUid - Symbol uid of the candidate.
   * @returns The declared count, or `undefined` when unrecorded.
   */
  methodParamCount(methodName: string, symbolUid: string): number | undefined {
    const entry = this.findMethodEntry(methodName, symbolUid)
    return entry?.paramCount ?? undefined
  }

  /**
   * Tri-state receiver compatibility: `undefined` means no recorded receiver
   * metadata (no evidence either way), while `true`/`false` is a positive
   * verdict from the recorded receiver type (`method_receiver_compat`).
   *
   * @param methodName - Method short name.
   * @param symbolUid - Symbol uid of the candidate.
   * @param receiverExpr - Receiver expression as written.
   * @returns The compatibility verdict, or `undefined` without metadata.
   */
  methodReceiverCompat(methodName: string, symbolUid: string, receiverExpr: string): boolean | undefined {
    const entry = this.findMethodEntry(methodName, symbolUid)
    const receiverType = entry?.receiverType
    if (receiverType === undefined || receiverType === null) return undefined
    const receiverNorm = this.normalizeTypeName(this.resolveAlias(receiverType))
    const recvLower = receiverExpr.toLowerCase()
    const recvNorm = this.normalizeTypeName(this.resolveAlias(recvLower))
    if (recvNorm === receiverNorm) return true
    // Dotted receivers may carry the type hint in any segment.
    if (receiverExpr.split('.').some(part => this.normalizeTypeName(part) === receiverNorm)) return true
    return this.isSubtype(recvLower, receiverType)
  }

  /**
   * Resolve a method by matching the receiver expression against known
   * receiver types (`resolve_method_by_receiver`); needs no disambiguation
   * (≤ 1 entry) and answers `undefined` in that case.
   *
   * @param methodName - Method short name.
   * @param receiverExpr - Receiver expression as written.
   * @returns The best-matching method's symbol uid, or `undefined`.
   */
  resolveMethodByReceiver(methodName: string, receiverExpr: string): string | undefined {
    const entries = this.methodIndex.get(methodName.toLowerCase())
    if (entries === undefined || entries.length <= 1) return undefined

    const receiverLower = receiverExpr.toLowerCase()
    const canonical = this.resolveAlias(receiverLower)
    const canonicalNorm = this.normalizeTypeName(canonical)
    const receiverParts = receiverExpr.split('.')

    let best: { uid: string; score: number } | undefined
    for (const entry of entries) {
      const receiverType = entry.receiverType
      if (receiverType === null) continue
      const rtCanonical = this.resolveAlias(receiverType)
      const rtNorm = this.normalizeTypeName(rtCanonical)

      // Direct match with the normalized receiver expression.
      if (rtNorm === canonicalNorm) return entry.symbolUid

      let score = 0
      if (this.normalizeTypeName(receiverParts.at(-1) as string) === rtNorm) score = 3
      else if (this.normalizeTypeName(receiverParts[0] as string) === rtNorm) score = 2
      else if (this.isSubtype(canonical, rtCanonical)) score = 1

      if (score > 0 && (best === undefined || score > best.score)) {
        best = { uid: entry.symbolUid, score }
      }
    }
    return best?.uid
  }

  /**
   * Resolve a method by argument count when multiple same-named methods
   * exist; answers `undefined` unless exactly one candidate matches
   * (`resolve_method_by_arg_count`).
   *
   * @param methodName - Method short name.
   * @param argCount - Argument count at the call site.
   * @returns The unique matching method's symbol uid, or `undefined`.
   */
  resolveMethodByArgCount(methodName: string, argCount: number): string | undefined {
    const entries = this.methodIndex.get(methodName.toLowerCase())
    if (entries === undefined || entries.length <= 1) return undefined
    const matches = entries.filter(entry => entry.paramCount === argCount)
    if (matches.length !== 1) return undefined
    return (matches[0] as MethodEntry).symbolUid
  }

  /**
   * Chase the type alias chain up to {@link MAX_ALIAS_CHASE} hops
   * (`resolve_alias`).
   *
   * @param typeName - Lowercased type name to chase.
   * @returns The canonical type name.
   */
  resolveAlias(typeName: string): string {
    let current = typeName
    for (let hop = 0; hop < MAX_ALIAS_CHASE; hop += 1) {
      const next = this.typeAliases.get(current)?.at(-1)?.value
      if (next === undefined || next === current) break
      current = next
    }
    return current
  }

  /**
   * Whether `child` is a subtype of `parent` by one level of
   * base_types/implements chains (`is_subtype`).
   *
   * @param child - Child type name.
   * @param parent - Parent type name.
   * @returns True when the one-level check succeeds.
   */
  isSubtype(child: string, parent: string): boolean {
    const childNorm = this.normalizeTypeName(child)
    const parentNorm = this.normalizeTypeName(parent)
    if (childNorm === parentNorm) return true
    const info = this.typeInfo(childNorm)
    if (info === undefined) return false
    return info.baseTypes.some(base => this.normalizeTypeName(base) === parentNorm)
      || info.implementsList.some(impl => this.normalizeTypeName(impl) === parentNorm)
  }

  /**
   * Normalize a type name: strip pointer/reference and optional/array
   * markers, strip generic parameters, chase aliases, and map a short name to
   * its qname when unambiguous (`normalize_type_name`).
   *
   * @param raw - Type name as written.
   * @returns The normalized lowercased name.
   */
  normalizeTypeName(raw: string): string {
    let s = raw.trim().replace(/^[*&]+/, '')
    s = s.replace(/[?\]]+$/, '')
    s = s.replace(/\[$/, '')
    const generic = s.indexOf('<')
    if (generic !== -1) s = s.slice(0, generic)

    const lower = s.toLowerCase()
    const resolved = this.resolveAlias(lower)

    const pairs = this.shortToQnames.get(resolved)
    const first = pairs?.[0]?.value
    if (pairs !== undefined && first !== undefined && pairs.every(pair => pair.value === first)) return first
    return resolved
  }

  /** The live type info for a canonical key: the last contribution wins. */
  private typeInfo(canonical: string): TypeInfo | undefined {
    return this.typeIndexByQname.get(canonical)?.at(-1)?.value
  }

  /** Method entry for one (method name, uid) pair. */
  private findMethodEntry(methodName: string, symbolUid: string): MethodEntry | undefined {
    return this.methodIndex.get(methodName.toLowerCase())?.find(entry => entry.symbolUid === symbolUid)
  }
}

/** Split a comma-joined type list into trimmed non-empty atoms. */
function splitTypeList(joined: string | null): string[] {
  if (joined === null) return []
  return joined
    .split(',')
    .map(part => part.trim())
    .filter(part => part !== '')
}

/** Append a per-file contribution under `key`, creating the bucket when absent. */
function appendContribution<T>(
  map: Map<string, { file: string; value: T }[]>,
  key: string,
  file: string,
  value: T,
): void {
  const bucket = map.get(key)
  const item = { file, value }
  if (bucket === undefined) map.set(key, [item])
  else bucket.push(item)
}

/** Append a method entry under `key`, creating the bucket when absent. */
function pushToBucket(map: Map<string, MethodEntry[]>, key: string, entry: MethodEntry): void {
  const bucket = map.get(key)
  if (bucket === undefined) map.set(key, [entry])
  else bucket.push(entry)
}

/** Retain surviving items in one bucket, deleting empty buckets. */
function retain<T>(
  map: Map<string, T[]>,
  key: string,
  keep: (bucket: T[]) => T[],
): void {
  const bucket = map.get(key)
  if (bucket === undefined) return
  const kept = keep(bucket)
  if (kept.length === 0) map.delete(key)
  else map.set(key, kept)
}

// ---------------------------------------------------------------------------
// Second-pass adjudication (type-catalog pass over processed call edges)
// ---------------------------------------------------------------------------

/**
 * Whether the type-catalog pass may touch an already-processed call edge
 * (`TypeUpgradeGate`): proof-based results are never touched, unresolved or
 * generic-heuristic results are overwritten unconditionally, and
 * name-evidence-only results may be replaced by a strictly better proposal.
 */
export type TypeUpgradeGate = 'skip' | 'backfill' | 'upgrade'

/** Strategies the upgrade gate treats as name-evidence-only results. */
const UPGRADEABLE_STRATEGIES: ReadonlySet<string> = new Set([
  'global_unique',
  'suffix',
  'fuzzy_single',
  'fuzzy_signal',
  'fuzzy_arg_count',
  'fuzzy_receiver',
  'fuzzy_multi',
])

/**
 * Gate decision for one edge (`type_upgrade_gate`): Unresolved → Backfill;
 * Heuristic with a name-evidence-only strategy → Upgrade; other Heuristic
 * strategies → Backfill; Exact/Qualified/ScopeResolved → Skip.
 *
 * @param edge - Edge the pass considers touching.
 * @returns The gate decision.
 */
export function typeUpgradeGate(edge: CallEdgeRow): TypeUpgradeGate {
  switch (edge.resolutionKind) {
    case 'unresolved':
      return 'backfill'
    case 'heuristic':
      return UPGRADEABLE_STRATEGIES.has(edge.resolutionStrategy) ? 'upgrade' : 'backfill'
    default:
      return 'skip'
  }
}

/** A type-catalog resolution proposal for a call edge. */
export interface TypeCatalogCandidate {
  /** Catalog entry index backing the proposal. */
  readonly catalogIndex: number
  /** Symbol uid of the proposed target. */
  readonly uid: string
  /** Stored resolution kind the proposal carries. */
  readonly kind: ResolutionKind
  /** Proposal confidence in `[0, 1]`. */
  readonly confidence: number
  /** Proposal strategy label. */
  readonly strategy: string
}

/**
 * Build the highest-priority type-catalog proposal for a call edge, trying
 * the signal sources in fixed precedence: type-assign-inferred receiver
 * (scope_resolved, 0.90), raw receiver expression (qualified, 0.95), then
 * arg-count disambiguation (scope_resolved, 0.9)
 * (`type_catalog_candidate`).
 *
 * @param tc - The embedded type catalog.
 * @param edge - Edge to propose for.
 * @param findByUid - Catalog uid lookup returning the entry index.
 * @returns The first proposal that binds to a catalog entry, or `undefined`.
 */
export function typeCatalogCandidate(
  tc: TypeCatalog,
  edge: CallEdgeRow,
  findByUid: (uid: string) => number | undefined,
): TypeCatalogCandidate | undefined {
  const callee = edge.calleeSymbol
  const leaf = callee.slice(callee.lastIndexOf('.') + 1)

  // A bare variable receiver ("client") may have a recorded type assignment;
  // prefer the inferred type over the raw expression.
  if (edge.receiverExpr !== null) {
    const resolvedType = tc.resolveVarType(edge.filePath, edge.receiverExpr)
    if (resolvedType !== undefined) {
      const uid = tc.resolveMethodByReceiver(leaf, resolvedType)
      const idx = uid === undefined ? undefined : findByUid(uid)
      if (idx !== undefined) {
        return { catalogIndex: idx, uid: uid as string, kind: 'scope_resolved', confidence: 0.90, strategy: 'type_assign_receiver' }
      }
    }
  }

  if (edge.receiverExpr !== null) {
    const uid = tc.resolveMethodByReceiver(leaf, edge.receiverExpr)
    const idx = uid === undefined ? undefined : findByUid(uid)
    if (idx !== undefined) {
      return { catalogIndex: idx, uid: uid as string, kind: 'qualified', confidence: 0.95, strategy: 'receiver_type' }
    }
  }

  if (edge.argCount !== null) {
    const uid = tc.resolveMethodByArgCount(leaf, edge.argCount)
    const idx = uid === undefined ? undefined : findByUid(uid)
    if (idx !== undefined) {
      return { catalogIndex: idx, uid: uid as string, kind: 'scope_resolved', confidence: 0.9, strategy: 'arg_count' }
    }
  }

  return undefined
}

/**
 * Apply a proposal onto an edge: target id/file, callee uid, resolution
 * fields, and parser confidence all take the proposal's values
 * (`TypeCatalogCandidate::apply`).
 *
 * @param edge - Mutable edge to rewrite.
 * @param candidate - Proposal to apply.
 * @param entries - Catalog entries backing the proposal index.
 * @returns The rewritten edge.
 */
export function applyTypeCatalogCandidate<Row extends CallEdgeRow>(
  edge: Row,
  candidate: TypeCatalogCandidate,
  entries: readonly { symbolId: string; filePath: string }[],
): Row {
  const entry = entries[candidate.catalogIndex] as { symbolId: string; filePath: string }
  return {
    ...edge,
    targetSymbolId: entry.symbolId,
    targetFilePath: entry.filePath,
    calleeSymbolUid: candidate.uid,
    resolutionKind: candidate.kind,
    resolutionConfidence: candidate.confidence,
    resolutionStrategy: candidate.strategy,
    parserConfidence: candidate.confidence,
  }
}
