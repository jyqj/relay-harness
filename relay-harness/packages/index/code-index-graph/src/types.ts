/**
 * Vocabulary types for the symbol-resolution layer. This module is types-only.
 *
 * Row types mirror the reference implementation's `cc-model` records and the
 * local `symbols` / `imports` / `symbol_refs` / `call_edges` tables, trimmed
 * to the fields resolution reads or writes. Scope types stay in the interface
 * for the reference's lexical scope-chain step even though no parser currently
 * emits scopes (the step stays dormant with an empty scope map).
 *
 * @module @relay-harness/rlh-code-index-graph/types
 */

import type { ParserTier } from '@relay-harness/rlh-code-index'
import type { DispatchKind, SymbolKind } from '@relay-harness/rlh-code-index-parser'
import type { ImportRow } from '@relay-harness/rlh-code-index-search'

export type { DispatchKind, SymbolKind }
export type { ImportRow }
export type { ParserTier }

/** Stored resolution status of a call edge or symbol ref (`resolution_kind` column). */
export type ResolutionKind = 'unresolved' | 'exact' | 'qualified' | 'scope_resolved' | 'heuristic'

/** Call-site classification written to `call_kind` when a call edge resolves. */
export type CallKind = 'constructor' | 'method' | 'imported' | 'local'

/** Internal resolution kinds of the ladder, mapped to {@link ResolutionKind} on output. */
export type InternalResKind =
  | 'exact'
  | 'qualified'
  | 'scope_resolved'
  | 'import_resolved'
  | 'global_unique'
  | 'suffix_match'
  | 'heuristic'
  | 'fuzzy_single'
  | 'fuzzy_signal'
  | 'fuzzy_multi'
  | 'unresolved'

/** The nine ladder steps, in evaluation order. */
export type ResolveStep =
  | 'self_member'
  | 'scope_binding'
  | 'same_file'
  | 'import'
  | 'suffix'
  | 'global_unique'
  | 'fuzzy_arg_count'
  | 'fuzzy_receiver'
  | 'fuzzy_import_distance'

/** Stored `resolution_strategy` values plus the two signal-step overrides. */
export type StrategyName =
  | 'exact'
  | 'qualified'
  | 'scope'
  | 'import_map'
  | 'global_unique'
  | 'suffix'
  | 'heuristic'
  | 'fuzzy_single'
  | 'fuzzy_signal'
  | 'fuzzy_multi'
  | 'fuzzy_arg_count'
  | 'fuzzy_receiver'
  | 'unresolved'

/** One lexical scope binding (`ScopeBinding` in the reference). */
export interface ScopeBinding {
  /** Bound local name as written. */
  readonly name: string
  /** Binding kind tag (`variable`, `function`, ...); informational. */
  readonly kind: string
  /** Catalog symbol uid the binding points at, when known. */
  readonly symbolUid: string | null
}

/** One scope extracted from parse output, used for scope-chain resolution. */
export interface CatalogScope {
  /** Scope identity, unique within the resolved file set. */
  readonly scopeId: string
  /** Enclosing scope id, or `null` at the file root. */
  readonly parentId: string | null
  /** Scope display name. */
  readonly name: string
  /** File the scope spans. */
  readonly filePath: string
  /** Inclusive 1-based start line. */
  readonly startLine: number
  /** Inclusive 1-based end line. */
  readonly endLine: number
  /** Bindings visible inside the scope. */
  readonly bindings: readonly ScopeBinding[]
}

/** One import binding projected from an {@link ImportRow} for resolution. */
export interface ImportBinding {
  /** Local name the module member is reachable under. */
  readonly localName: string
  /** Resolved module path the binding points at. */
  readonly sourceModule: string
  /** Export-side name, or `null` for namespace imports. */
  readonly importedName: string | null
  /** File the import was declared in. */
  readonly filePath: string
  /** True for `import * as ns`. */
  readonly isNamespace: boolean
  /** True for default imports. */
  readonly isDefault: boolean
}

/** Symbol row projection the catalog registers (the `symbols` table's resolution-relevant columns). */
export interface SymbolRow {
  /** Positional symbol id (`symbol_id`). */
  readonly symbolId: string
  /** Semantic symbol uid, or `null` when the parser could not derive one. */
  readonly symbolUid: string | null
  /** Declared short name. */
  readonly name: string
  /** Declared kind. */
  readonly kind: SymbolKind
  /** Workspace-relative file path declaring the symbol. */
  readonly filePath: string
  /** Enclosing declaration name, or `null` at file scope. */
  readonly container: string | null
  /** Qualified name, or `null` when the producer did not derive one. */
  readonly qname: string | null
  /** True for `export default <name>`. */
  readonly isDefaultExport: boolean
  /** Inclusive 1-based start line. */
  readonly startLine: number
  /** Inclusive 1-based end line. */
  readonly endLine: number
  /** Exported name when the declaration is exported, else `null`. */
  readonly exportName: string | null
  /** Receiver (container) type recorded for a method, else `null`. */
  readonly receiverType: string | null
  /** Declared parameter count, else `null`. */
  readonly paramCount: number | null
  /** Comma-joined base types, else `null`. */
  readonly baseTypes: string | null
  /** Comma-joined implemented interfaces, else `null`. */
  readonly implements: string | null
  /** Owning scope id for the scope-proximity ranking; producers currently always send `null`. */
  readonly scopeId: string | null
}

/** One variable type-assignment record feeding the type catalog (`TypeAssignRecord` projection). */
export interface TypeAssignRow {
  /** File the assignment was observed in. */
  readonly filePath: string
  /** Variable name as written. */
  readonly varName: string
  /** Inferred type name. */
  readonly typeName: string
}

/** Call-edge row the resolver reads and rewrites (`call_edges` resolution columns included). */
export interface CallEdgeRow {
  /** Positional edge id (`edge_id`). */
  readonly edgeId: string
  /** Workspace-relative file path the call was parsed from. */
  readonly filePath: string
  /** Enclosing declaration short name, when known. */
  readonly callerSymbol: string | null
  /** Callee text: plain identifier, `obj.prop`, or constructor name. */
  readonly calleeSymbol: string
  /** 1-based call-site line. */
  readonly line: number
  /** Resolved target symbol id; `null` means unresolved and eligible for resolution. */
  readonly targetSymbolId: string | null
  /** Resolved target file path, when bound. */
  readonly targetFilePath: string | null
  /** Caller symbol id, when known. */
  readonly callerSymbolId: string | null
  /** Caller symbol uid, when known. */
  readonly callerSymbolUid: string | null
  /** Callee symbol uid, when bound. */
  readonly calleeSymbolUid: string | null
  /** Dispatch classification, `null` when unset. */
  readonly dispatchKind: DispatchKind | null
  /** Call-site classification, `null` when unset. */
  readonly callKind: string | null
  /** Stored resolution status. */
  readonly resolutionKind: ResolutionKind
  /** Stored resolver confidence; `0` means unset and is backfilled. */
  readonly resolutionConfidence: number
  /** Stored strategy name; `''` means unset and is backfilled. */
  readonly resolutionStrategy: string
  /** Receiver expression for member calls, else `null`. */
  readonly receiverExpr: string | null
  /** Argument count at the call site, else `null`. */
  readonly argCount: number | null
  /**
   * Extraction tier that produced the edge; `null` only on rows reloaded from
   * the store, which may predate tier stamping. The resolver never interprets
   * the tier, it round-trips to the write-back.
   */
  readonly parserTier: ParserTier | null
  /** Parser confidence; the type-catalog pass overwrites it on apply. */
  readonly parserConfidence: number
}

/** Symbol-ref row the resolver reads and rewrites (`symbol_refs` resolution columns included). */
export interface SymbolRefRow {
  /** Positional ref id (`ref_id`). */
  readonly refId: string
  /** Workspace-relative file path the ref was parsed from. */
  readonly filePath: string
  /** Referenced symbol name as stored. */
  readonly symbolName: string
  /** Raw reference text overriding {@link SymbolRefRow.symbolName} when present. */
  readonly refName: string | null
  /** Enclosing declaration name, when known. */
  readonly container: string | null
  /** 1-based reference line, when known. */
  readonly line: number | null
  /** Resolved target symbol id; `null` means unresolved and eligible for resolution. */
  readonly targetSymbolId: string | null
  /** Resolved target file path, when bound. */
  readonly targetFilePath: string | null
  /** Resolved target symbol uid, when bound. */
  readonly targetSymbolUid: string | null
  /** Stored resolution status. */
  readonly resolutionKind: ResolutionKind
  /** Stored resolver confidence; `0` means unset and is backfilled. */
  readonly resolutionConfidence: number
  /** Stored strategy name; `''` means unset and is backfilled. */
  readonly resolutionStrategy: string
  /**
   * Extraction tier that produced the ref; `null` only on rows reloaded from
   * the store, which may predate tier stamping. Never interpreted by the
   * resolver, it round-trips to the write-back.
   */
  readonly parserTier: ParserTier | null
  /** Parser confidence; unchanged by resolution. */
  readonly parserConfidence: number
}

/** Per-call-site disambiguation signals consumed by the fuzzy-multi ladder steps. */
export interface CallSiteSignals {
  /** Argument count at the call site, when the parser extracted one. */
  readonly argCount: number | null
  /** Receiver expression (`obj` in `obj.method(...)`), when present. */
  readonly receiver: string | null
}
