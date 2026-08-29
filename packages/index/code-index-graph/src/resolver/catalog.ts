/**
 * The cross-file symbol directory used during resolution, ported from the
 * reference implementation's `resolver/catalog.rs` (`SymbolCatalog`) plus its
 * `find_best` fallback from `route_resolve.rs`.
 *
 * The catalog registers symbol rows into seven lookup maps (by leaf name, uid,
 * qualified name, qualified-name leaf segment, file, per-file name/qname, and
 * per-file exports), tombstones rows of removed files without reusing their
 * slots so captured indices stay valid, and embeds the type catalog the fuzzy
 * steps and the second-pass type adjudication read.
 *
 * @module catalog
 */

import { ResolveMemo } from './catalog-cache.ts'
import { TypeCatalog } from './type-catalog.ts'
import type { SymbolKeyMeta } from './type-catalog.ts'
import {
  bestByImportDistance,
  buildAliasMap,
  classifyCallKind,
  importBindingOf,
  pickUnique,
  scopeChain,
  scopeForLine,
} from './penalties.ts'
import type { CallKindName } from './penalties.ts'
import type { CatalogScope, ImportBinding, ImportRow, SymbolKind, SymbolRow } from '../types.ts'

/** One entry in the symbol catalog (the reference's `CatalogEntry`). */
export interface CatalogEntry {
  /** Positional symbol id. */
  symbolId: string
  /** Semantic symbol uid, or `null`. */
  symbolUid: string | null
  /** Declared short name. */
  name: string
  /** Workspace-relative file path. */
  filePath: string
  /** Declared kind. */
  kind: SymbolKind
  /** Enclosing declaration name, or `null`. */
  container: string | null
  /** Qualified name, or `null`. */
  qname: string | null
  /** True for `export default <name>`. */
  isDefaultExport: boolean
  /** Inclusive 1-based start line. */
  startLine: number
  /** Inclusive 1-based end line. */
  endLine: number
  /** Owning scope id, or `null` (no parser emits scopes yet; the field stays for the binding step). */
  scopeId: string | null
}

/** Empty tombstone written into slots of removed files. */
function tombstone(): CatalogEntry {
  return {
    symbolId: '',
    symbolUid: null,
    name: '',
    filePath: '',
    kind: 'variable',
    container: null,
    qname: null,
    isDefaultExport: false,
    startLine: 0,
    endLine: 0,
    scopeId: null,
  }
}

/** Construction options of {@link SymbolCatalog}. */
export interface SymbolCatalogOptions {
  /**
   * Above this many same-named candidates, name-only resolution
   * (global-unique / fuzzy / suffix / find-best) is treated as non-resolvable:
   * a name shared by hundreds of symbols cannot be disambiguated by path
   * heuristics, and scanning the whole bucket per reference is the dominant
   * cold-build cost. Mirrors the reference's `CODECORTEX_RESOLVER_MAX_POOL`
   * default of 256.
   */
  readonly maxFuzzyPool?: number
}

/** Cross-file symbol directory used during indexing to resolve references. */
export class SymbolCatalog {
  /** Registered entries; removed files leave tombstones so indices stay stable. */
  readonly entries: CatalogEntry[] = []
  /** Lowercased leaf name → entry indices. */
  readonly byName = new Map<string, number[]>()
  /** Symbol uid → entry index (last wins, uids are file-scoped). */
  readonly byUid = new Map<string, number>()
  /** Lowercased qname → entry indices. */
  readonly byQname = new Map<string, number[]>()
  /** Lowercased qname leaf segment → entry indices (suffix-match probe bucket). */
  readonly byQnameLeaf = new Map<string, number[]>()
  /** File path → entry indices. */
  readonly byFile = new Map<string, number[]>()
  /** file → lowercased export name → entry indices. */
  readonly byExport = new Map<string, Map<string, number[]>>()
  /** file → lowercased short name → entry indices (same-file name lookup). */
  readonly byFileName = new Map<string, Map<string, number[]>>()
  /** file → lowercased qname → entry indices (same-file qname lookup). */
  readonly byFileQname = new Map<string, Map<string, number[]>>()
  /** Resolve memo consulted by the ladder; cleared on every mutation. */
  readonly memo: ResolveMemo
  /** Tombstoned slots left behind by {@link SymbolCatalog.removeFiles}. */
  dead = 0

  private typeCatalogValue: TypeCatalog | null = null
  private readonly maxFuzzyPoolValue: number

  constructor(options: SymbolCatalogOptions = {}) {
    this.maxFuzzyPoolValue = options.maxFuzzyPool ?? 256
    this.memo = new ResolveMemo()
  }

  /** Ambiguity cap shared by name-only resolution and the suffix bucket. */
  get maxFuzzyPool(): number {
    return this.maxFuzzyPoolValue
  }

  /** The embedded type catalog, or `null` before {@link SymbolCatalog.buildTypeCatalog}. */
  get typeCatalog(): TypeCatalog | null {
    return this.typeCatalogValue
  }

  /** Number of live (non-tombstoned) entries. */
  get liveLen(): number {
    return this.entries.length - this.dead
  }

  /**
   * Register symbol rows, extending every lookup surface. Rows already
   * present (same symbol id) are not deduplicated here — producers replace
   * whole files through {@link SymbolCatalog.removeFiles} before re-adding.
   *
   * Registrations clear the resolve memo (the reference clears it in
   * `remove_files` and explicitly in its fold step; clearing here as well
   * makes "memo never outlives catalog state" unconditional).
   *
   * @param rows - Symbol rows to register, in producer order.
   */
  addSymbols(rows: readonly SymbolRow[]): void {
    this.memo.clear()
    for (const row of rows) {
      const idx = this.entries.length
      const nameLower = row.name.toLowerCase()
      const qnameLower = row.qname === null ? null : row.qname.toLowerCase()
      this.entries.push({
        symbolId: row.symbolId,
        symbolUid: row.symbolUid,
        name: row.name,
        filePath: row.filePath,
        kind: row.kind,
        container: row.container,
        qname: row.qname,
        isDefaultExport: row.isDefaultExport,
        startLine: row.startLine,
        endLine: row.endLine,
        scopeId: row.scopeId,
      })
      pushToBucket(this.byName, nameLower, idx)
      if (row.symbolUid !== null) this.byUid.set(row.symbolUid, idx)
      if (qnameLower !== null) {
        pushToBucket(this.byQname, qnameLower, idx)
        pushToBucket(this.byQnameLeaf, leafSegmentOf(qnameLower), idx)
      }
      pushToBucket(this.byFile, row.filePath, idx)
      pushNested(this.byFileName, row.filePath, nameLower, idx)
      if (qnameLower !== null) pushNested(this.byFileQname, row.filePath, qnameLower, idx)
      const exportNames = new Set<string>([nameLower])
      if (row.exportName !== null) exportNames.add(row.exportName.toLowerCase())
      if (row.isDefaultExport) exportNames.add('default')
      for (const exportName of exportNames) {
        pushNested(this.byExport, row.filePath, exportName, idx)
      }
    }
  }

  /**
   * Remove every entry belonging to `files` from all lookup surfaces,
   * tombstone their slots (surviving indices — including captured resolve
   * results — stay valid), and clear the resolve memo. Removals mirror into
   * the embedded type catalog before tombstoning.
   *
   * @param files - Files whose symbols leave the catalog.
   */
  removeFiles(files: ReadonlySet<string>): void {
    this.memo.clear()
    const removedIndices: number[] = []
    for (const file of files) {
      const indices = this.byFile.get(file)
      if (indices !== undefined) removedIndices.push(...indices)
      this.byFile.delete(file)
      this.byFileName.delete(file)
      this.byFileQname.delete(file)
      this.byExport.delete(file)
    }
    if (removedIndices.length === 0) return
    const removedSet = new Set(removedIndices)

    const nameKeys = new Set<string>()
    const qnameKeys = new Set<string>()
    const leafKeys = new Set<string>()
    const metas: SymbolKeyMeta[] = []
    for (const idx of removedIndices) {
      const entry = this.entries[idx] as CatalogEntry
      nameKeys.add(entry.name.toLowerCase())
      if (entry.qname !== null) {
        const qLower = entry.qname.toLowerCase()
        leafKeys.add(leafSegmentOf(qLower))
        qnameKeys.add(qLower)
      }
      if (entry.symbolUid !== null) {
        // uid is file-scoped, so the last-wins mapping necessarily points at
        // an entry of the same removed file.
        const mapped = this.byUid.get(entry.symbolUid)
        if (mapped !== undefined && removedSet.has(mapped)) this.byUid.delete(entry.symbolUid)
      }
      metas.push({
        name: entry.name,
        qname: entry.qname,
        kind: entry.kind,
        symbolUid: entry.symbolUid,
      })
    }
    for (const key of nameKeys) retainBucket(this.byName, key, removedSet)
    for (const key of qnameKeys) retainBucket(this.byQname, key, removedSet)
    for (const key of leafKeys) retainBucket(this.byQnameLeaf, key, removedSet)

    this.typeCatalogValue?.removeFiles(metas, files)

    for (const idx of removedIndices) {
      this.entries[idx] = tombstone()
      this.dead += 1
    }
  }

  /**
   * Build (or rebuild) the embedded type catalog from the given rows; call
   * after all symbols have been registered, typically right before resolving.
   *
   * @param rows - Every symbol row the resolution pass may see.
   * @returns The built catalog (also embedded for the ladder's use).
   */
  buildTypeCatalog(rows: readonly SymbolRow[]): TypeCatalog {
    const tc = new TypeCatalog()
    tc.buildFromSymbols(rows)
    this.typeCatalogValue = tc
    return tc
  }

  /**
   * Feed variable type-assignment records into the embedded type catalog; no
   * effect before {@link SymbolCatalog.buildTypeCatalog}.
   *
   * @param assigns - Type-assign rows from the changed files.
   */
  addTypeAssigns(assigns: readonly { filePath: string; typeName: string; varName: string }[]): void {
    this.typeCatalogValue?.addTypeAssigns(assigns)
  }

  // -----------------------------------------------------------------------
  // Lookup helpers
  // -----------------------------------------------------------------------

  /**
   * Entries in one file matching a name case-insensitively against both short
   * name and qname (`same_file_named`), merged and deduplicated.
   *
   * @param filePath - File to probe.
   * @param name - Name to match.
   * @returns Matching entry indices.
   */
  sameFileNamed(filePath: string, name: string): number[] {
    const needle = name.toLowerCase()
    const nameHits = this.byFileName.get(filePath)?.get(needle)
    const qnameHits = this.byFileQname.get(filePath)?.get(needle)
    if (nameHits === undefined) return [...(qnameHits ?? [])]
    if (qnameHits === undefined) return [...nameHits]
    const merged = [...nameHits]
    for (const idx of qnameHits) {
      if (!merged.includes(idx)) merged.push(idx)
    }
    return merged
  }

  /**
   * Entries in one file matching a qname case-insensitively
   * (`same_file_qname`).
   *
   * @param filePath - File to probe.
   * @param qname - Qualified name to match.
   * @returns Matching entry indices.
   */
  sameFileQname(filePath: string, qname: string): number[] {
    return [...(this.byFileQname.get(filePath)?.get(qname.toLowerCase()) ?? [])]
  }

  /**
   * Exported symbols of one file by export name, case-insensitively
   * (`exported`).
   *
   * @param filePath - File to probe.
   * @param exportName - Export name to match.
   * @returns Matching entry indices.
   */
  exported(filePath: string, exportName: string): number[] {
    return [...(this.byExport.get(filePath)?.get(exportName.toLowerCase()) ?? [])]
  }

  /**
   * Catalog index of a symbol uid (`find_by_uid`).
   *
   * @param uid - Symbol uid to look up.
   * @returns The entry index, or `undefined`.
   */
  findByUid(uid: string): number | undefined {
    return this.byUid.get(uid)
  }

  /**
   * Canonical (qname-first) name for a catalog entry by uid
   * (`canonical_name_for_uid`).
   *
   * @param uid - Symbol uid to look up.
   * @returns The qname or short name, or `undefined`.
   */
  canonicalNameForUid(uid: string): string | undefined {
    const idx = this.byUid.get(uid)
    if (idx === undefined) return undefined
    const entry = this.entries[idx] as CatalogEntry
    return entry.qname ?? entry.name
  }

  /**
   * Walk upward from the container qname to find the owning class
   * (`owner_class_qname`).
   *
   * @param filePath - File the resolution runs in.
   * @param container - Enclosing declaration name, when known.
   * @returns The owning class's qname, or `undefined`.
   */
  ownerClassQname(filePath: string, container: string | null): string | undefined {
    if (container === null) return undefined
    let qname = container
    for (;;) {
      const direct = this.sameFileQname(filePath, qname)
      const first = direct[0]
      if (first !== undefined && (this.entries[first] as CatalogEntry).kind === 'class') {
        // byFileQname membership implies a non-null qname.
        return (this.entries[first] as CatalogEntry).qname as string
      }
      const dot = qname.lastIndexOf('.')
      if (dot === -1) break
      qname = qname.slice(0, dot)
    }
    return undefined
  }

  /**
   * Find a symbol by name within one file, preferring type-like kinds when
   * asked (`find_by_name_in_file`).
   *
   * @param name - Name to match.
   * @param filePath - File to probe.
   * @param preferType - Prefer class/interface/enum entries when several match.
   * @returns The entry index, or `undefined`.
   */
  findByNameInFile(name: string, filePath: string, preferType: boolean): number | undefined {
    const candidates = this.sameFileNamed(filePath, name)
    const first = candidates[0]
    if (first === undefined) return undefined
    if (candidates.length === 1) return first
    if (preferType) {
      for (const idx of candidates) {
        const kind = (this.entries[idx] as CatalogEntry).kind
        if (kind === 'class' || kind === 'interface' || kind === 'enum') return idx
      }
    }
    return first
  }

  /**
   * Find-best fallback: prefer globally unique qname, then same-file qname,
   * then by-name with the ambiguity cap and import-distance tie-breaking
   * (`find_best`).
   *
   * @param name - Name to resolve.
   * @param currentFile - File the resolution runs from.
   * @returns The entry index, or `undefined`.
   */
  findBest(name: string, currentFile: string): number | undefined {
    const lower = name.toLowerCase()

    const qnameIndices = this.byQname.get(lower)
    if (qnameIndices !== undefined) {
      if (qnameIndices.length === 1) return qnameIndices[0]
      const sameFile = this.sameFileFirst(this.byFileQname, currentFile, lower)
      if (sameFile !== undefined) return sameFile
      if (qnameIndices.length > this.maxFuzzyPoolValue) return undefined
      // Non-empty bucket, so the distance pick always yields a winner.
      return bestByImportDistance(this.entries, qnameIndices, currentFile)
    }

    const nameIndices = this.byName.get(lower)
    if (nameIndices !== undefined) {
      const sameFile = this.sameFileFirst(this.byFileName, currentFile, lower)
      if (sameFile !== undefined) return sameFile
      if (nameIndices.length > this.maxFuzzyPoolValue) return undefined
      // Non-empty bucket, so the distance pick always yields a winner.
      return bestByImportDistance(this.entries, nameIndices, currentFile)
    }

    return undefined
  }

  /**
   * First entry index in `nested[file][keyLower]` (`same_file_first`).
   *
   * @param nested - Nested file→key→indices index.
   * @param file - File to probe.
   * @param keyLower - Lowercased lookup key.
   * @returns The first index, or `undefined`.
   */
  private sameFileFirst(
    nested: ReadonlyMap<string, Map<string, number[]>>,
    file: string,
    keyLower: string,
  ): number | undefined {
    return nested.get(file)?.get(keyLower)?.[0]
  }

  // -----------------------------------------------------------------------
  // Scope chain resolution
  // -----------------------------------------------------------------------

  /**
   * Resolve `name` via scope-chain bindings starting from the scope at `line`
   * (`resolve_via_scope_bindings`): the first chain scope binding the name's
   * head resolves through its uid or shadows the lookup; a bound head with a
   * dotted tail continues through the member chain.
   *
   * @param scopes - Scope map of the file set.
   * @param file - File the resolution runs in.
   * @param name - Dotted name as written.
   * @param line - Call-site line.
   * @returns The entry index, or `undefined`.
   */
  resolveViaScopeBindings(
    scopes: ReadonlyMap<string, CatalogScope>,
    file: string,
    name: string,
    line: number,
  ): number | undefined {
    const scope = scopeForLine({ scopes, file, line })
    if (scope === undefined) return undefined
    const chain = scopeChain(scopes, scope.scopeId)

    const parts = name.split('.')
    const head = parts[0] as string
    const tail = parts.slice(1)

    for (const chainScope of chain) {
      const binding = chainScope.bindings.find(candidate => candidate.name === head)
      if (binding === undefined) continue
      const entryIdx = binding.symbolUid === null ? undefined : this.findByUid(binding.symbolUid)
      if (entryIdx !== undefined) {
        if (tail.length === 0) return entryIdx
        return this.resolveMemberChainFrom(entryIdx, tail, file)
      }
      // Binding found but no catalog entry → shadowed local.
      return undefined
    }
    return undefined
  }

  // -----------------------------------------------------------------------
  // Member chain resolution
  // -----------------------------------------------------------------------

  /**
   * Resolve a dotted name's head within `file`, then walk the remaining
   * members (`resolve_member_chain`).
   *
   * @param parts - Dot-split name segments.
   * @param file - File the resolution runs in.
   * @returns The entry index, or `undefined`.
   */
  resolveMemberChain(parts: readonly string[], file: string): number | undefined {
    const head = parts[0]
    if (head === undefined) return undefined
    const headIdx = pickUnique(this.entries, this.sameFileNamed(file, head))
    if (headIdx === undefined) return undefined
    if (parts.length === 1) return headIdx
    return this.resolveMemberChainFrom(headIdx, parts.slice(1), file)
  }

  /**
   * Resolve the remaining member parts starting from a known base entry
   * (`resolve_member_chain_from`).
   *
   * @param baseIdx - Entry index of the resolved base.
   * @param tail - Remaining dotted segments.
   * @param file - File the resolution runs in.
   * @returns The final entry index, or `undefined`.
   */
  resolveMemberChainFrom(baseIdx: number, tail: readonly string[], file: string): number | undefined {
    let current = baseIdx
    for (const part of tail) {
      const next = this.resolveMemberStep(current, part, file)
      if (next === undefined) return undefined
      current = next
    }
    return current
  }

  /**
   * Resolve one member-access step `current.member` through five layers:
   * direct qname, container-scoped member, constructor pattern
   * (variable/function/property → class member), cross-file global qname, and
   * cross-file container (`resolve_member_step`).
   *
   * @param containerIdx - Entry index of the container.
   * @param member - Member segment to resolve.
   * @param _file - File the resolution runs in (unused; kept for parity).
   * @returns The member's entry index, or `undefined`.
   */
  resolveMemberStep(containerIdx: number, member: string, _file: string): number | undefined {
    const container = this.entries[containerIdx] as CatalogEntry
    const containerQname = container.qname ?? container.name
    const memberLower = member.toLowerCase()

    // 1. Direct qname: "ClassName.method".
    const memberQname = `${containerQname}.${member}`
    const direct = pickUnique(this.entries, this.sameFileQname(container.filePath, memberQname))
    if (direct !== undefined) return direct

    // 2. Container-based: members whose container equals the current qname.
    // A registered container's own file always has a byFile bucket.
    const members = (this.byFile.get(container.filePath) as number[]).filter((idx) => {
      const entry = this.entries[idx] as CatalogEntry
      return entry.container !== null
        && entry.container.toLowerCase() === containerQname.toLowerCase()
        && entry.name.toLowerCase() === memberLower
    })
    const memberIdx = pickUnique(this.entries, members)
    if (memberIdx !== undefined) return memberIdx

    // 3. Constructor pattern: variable/function/property containers may hold
    // instances of same-file classes.
    if (container.kind === 'function' || container.kind === 'variable' || container.kind === 'property') {
      const classes = this.byFile.get(container.filePath) as number[]
      for (const idx of classes) {
        const entry = this.entries[idx] as CatalogEntry
        if (entry.kind !== 'class') continue
        const clsMemberQname = `${entry.qname ?? entry.name}.${member}`
        const clsMatches = pickUnique(this.entries, this.sameFileQname(entry.filePath, clsMemberQname))
        if (clsMatches !== undefined) return clsMatches
      }
    }

    // 4. Cross-file global: unique qname "container.member" anywhere.
    const cross = this.byQname.get(memberQname.toLowerCase())
    if (cross !== undefined && cross.length === 1) return cross[0]

    // 5. Cross-file container: unique member name carried by the container
    // qname anywhere.
    const crossByName = this.byName.get(memberLower)
    if (crossByName !== undefined) {
      const matches = crossByName.filter((idx) => {
        const entryContainer = (this.entries[idx] as CatalogEntry).container
        return entryContainer !== null && entryContainer.toLowerCase() === containerQname.toLowerCase()
      })
      const matchIdx = pickUnique(this.entries, matches)
      if (matchIdx !== undefined) return matchIdx
    }

    return undefined
  }

  // -----------------------------------------------------------------------
  // Import resolution
  // -----------------------------------------------------------------------

  /**
   * Resolve a name via import bindings (`resolve_via_imports`): a namespace
   * binding's tail head names the export, named/default bindings resolve the
   * imported name, and any further tail walks the member chain in the target
   * file.
   *
   * @param imports - Import bindings of the resolving file.
   * @param name - Dotted name as written.
   * @returns The entry index, or `undefined`.
   */
  resolveViaImports(imports: readonly ImportBinding[], name: string): number | undefined {
    const parts = name.split('.')
    const head = parts[0] as string
    const tail = parts.slice(1)

    const binding = imports.find(candidate => candidate.localName === head)
    if (binding === undefined) return undefined

    if (binding.isNamespace) {
      // Namespace import: the tail's first segment is the exported name.
      const exportName = tail[0]
      if (exportName === undefined) return undefined
      const target = this.resolveExport(binding.sourceModule, exportName)
      if (target === undefined) return undefined
      if (tail.length === 1) return target
      return this.resolveMemberChainFrom(target, tail.slice(1), (this.entries[target] as CatalogEntry).filePath)
    }

    const importedName = binding.importedName ?? head
    const target = this.resolveExport(binding.sourceModule, importedName)
    if (target === undefined) return undefined
    if (tail.length === 0) return target
    return this.resolveMemberChainFrom(target, tail, (this.entries[target] as CatalogEntry).filePath)
  }

  /**
   * Resolve an exported name from a module path by its export surface,
   * which already carries the name, the exported alias, and `default` for
   * default exports. (The reference additionally rescans the module's rows
   * for `is_default_export`; that scan is subsumed here — its result set is
   * empty whenever the exact export probe misses, because the same rows
   * populate the `default` export key.)
   *
   * @param modulePath - Resolved module path of the exporting file.
   * @param exportName - Export-side name to bind.
   * @returns The entry index, or `undefined`.
   */
  resolveExport(modulePath: string, exportName: string): number | undefined {
    return pickUnique(this.entries, this.exported(modulePath, exportName))
  }

  /**
   * Project the import rows of one file into resolution bindings
   * (`build_import_bindings`).
   *
   * @param rows - Import rows declared in the file.
   * @returns Bindings for rows with a resolved path and a non-blank local name.
   */
  static buildImportBindings(rows: readonly ImportRow[]): ImportBinding[] {
    const bindings: ImportBinding[] = []
    for (const row of rows) {
      const binding = importBindingOf(row)
      if (binding !== null) bindings.push(binding)
    }
    return bindings
  }

  /** Alias map: local name → qualified imported name (`build_alias_map`). */
  static readonly buildAliasMap = buildAliasMap

  /** Call-site classification (`classify_call_kind`). */
  static readonly classifyCallKind = classifyCallKind
}

/** `CallKindName` re-exported next to its consumer for ergonomic imports. */
export type { CallKindName }

/** Append `idx` to the bucket under `key`, creating it when absent. */
function pushToBucket(map: Map<string, number[]>, key: string, idx: number): void {
  const bucket = map.get(key)
  if (bucket === undefined) map.set(key, [idx])
  else bucket.push(idx)
}

/** Append `idx` to the nested bucket `nested[outer][inner]`. */
function pushNested(
  nested: Map<string, Map<string, number[]>>,
  outer: string,
  inner: string,
  idx: number,
): void {
  let innerMap = nested.get(outer)
  if (innerMap === undefined) {
    innerMap = new Map()
    nested.set(outer, innerMap)
  }
  pushToBucket(innerMap, inner, idx)
}

/** Drop removed indices from one bucket, deleting empty buckets. */
function retainBucket(
  map: Map<string, number[]>,
  key: string,
  removed: ReadonlySet<number>,
): void {
  // Every key derives from a removed entry's registration, so the bucket exists.
  const bucket = map.get(key) as number[]
  const kept = bucket.filter(idx => !removed.has(idx))
  if (kept.length === 0) map.delete(key)
  else map.set(key, kept)
}

/** Final `.`-segment of a lowercased qname. */
function leafSegmentOf(qnameLower: string): string {
  const dot = qnameLower.lastIndexOf('.')
  return dot === -1 ? qnameLower : qnameLower.slice(dot + 1)
}
