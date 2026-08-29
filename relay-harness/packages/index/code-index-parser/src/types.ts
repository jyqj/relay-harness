/**
 * Record vocabulary produced by one parse. Fields are trimmed down from the
 * reference Rust implementation (`cc-model` symbol/edge/diagnostic records):
 * route, HTTP-call, semantic-edge, data-flow, dispatch-site, and type-assign
 * surfaces are out of scope for this phase and are omitted entirely.
 * {@link SymbolRefRecord} exists only for the SFC template layer; general
 * identifier refs arrive with the resolution phase.
 *
 * This module is types-only.
 *
 * @module @relay-harness/rlh-code-index-parser/types
 */

import type { ParserTier } from '@relay-harness/rlh-code-index'

/** Kind of a parsed symbol (same vocabulary as the reference implementation). */
export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'variable'
  | 'constant'
  | 'interface'
  | 'type_alias'
  | 'enum'
  | 'module'
  | 'namespace'
  | 'property'
  | 'export'
  | 'hook'
  | 'component'
  | 'middleware'
  | 'controller'
  | 'route_handler'
  | 'route'

/**
 * How a call site dispatches to its callee. `'event_emitter'` covers the SFC
 * template-event edges (the reference `DispatchKind::EventEmitter`); no
 * walker emits it yet.
 */
export type DispatchKind = 'direct' | 'dynamic' | 'virtual' | 'optional_chain' | 'constructor' | 'event_emitter'

/** How an emitted reference or edge resolved to a target (reference `ResolutionKind`). */
export type ResolutionKind = 'unresolved' | 'exact' | 'qualified' | 'scope_resolved' | 'heuristic'

/** One symbol definition extracted from source code. */
export interface SymbolRecord {
  /** Positional id (`sym:<hex16>`, stable per file/line/col). */
  symbolId: string
  /** Workspace-relative file path the symbol was parsed from. */
  filePath: string
  /** Declared short name. */
  name: string
  /** Declared kind. */
  kind: SymbolKind
  /** Enclosing declaration name (`Foo` for a method of class `Foo`). */
  container: string | null
  /** Inclusive 1-based start line. */
  startLine: number
  /** Inclusive 1-based end line. */
  endLine: number
  /** 0-based UTF-8 byte column of the first character. */
  startCol: number
  /** 0-based UTF-8 byte column one past the last character. */
  endCol: number
  /** Rendered signature (`function f(a, b)`) when the grammar exposes one. */
  signature: string | null
  /** Extraction tier that produced this record. */
  parserTier: ParserTier
  /** Confidence reported alongside {@link SymbolRecord.parserTier}. */
  parserConfidence: number
  /** Qualified name (`container.name` or plain name). */
  qname: string
  /** `null`: every symbol this parser emits is a span root for chunking. */
  parentSymbolId: null
  /** Exported name when the declaration is exported (`bar` for `export { foo as bar }`). */
  exportName: string | null
  /** True for `export default <name>`. */
  isDefaultExport: boolean
  /** Semantic identity id (`uid:<hex24>`), stable across line drift. */
  symbolUid: string
  /** Framework role inferred from naming/decorators, when recognized. */
  frameworkRole: string | null
  /** Receiver (container) type for methods; equals {@link SymbolRecord.container}. */
  receiverType: string | null
  /** Comma-joined TypeScript parameter types, when annotated. */
  paramTypes: string | null
  /** TypeScript return type, when annotated. */
  returnType: string | null
  /** Number of declared parameters. */
  paramCount: number | null
}

/**
 * One import declaration (ES `import`, `export ... from`, or `require()`).
 * Mutable: deferred export application flips `isReexport` in place.
 */
export interface ImportRecord {
  /** Workspace-relative file path the import was parsed from. */
  filePath: string
  /** Module specifier as written, quotes stripped. */
  importString: string
  /** Resolved project-relative path, when {@link ImportRecord.importString} points inside the project. */
  resolvedPath: string | null
  /** Imported binding text (whole clause text for ES imports, local name for `require()`). */
  importedName: string | null
  /** Export-side name of a re-export specifier. */
  alias: string | null
  /** True for `import * as ns` / `export * from` / `const x = require('m')`. */
  isNamespace: boolean
  /** True when the clause text contains `default`. */
  isDefault: boolean
  /** True for `export ... from` and two-step forwarding of an imported binding. */
  isReexport: boolean
}

/** One call site (AST-extracted or regex fallback). */
export interface CallEdgeRecord {
  /** Positional id (`call:<hex16>`, stable per file/line/col). */
  readonly edgeId: string
  /** Workspace-relative file path the call was parsed from. */
  readonly filePath: string
  /** Enclosing declaration short name, when known. */
  readonly callerSymbol: string | null
  /** Callee text: plain identifier, `obj.prop`, or constructor name. */
  readonly calleeSymbol: string
  /** 1-based start line. */
  readonly line: number
  /** 0-based UTF-8 byte start column. */
  readonly startCol: number
  /** Inclusive 1-based end line. */
  readonly endLine: number
  /** 0-based UTF-8 byte end column. */
  readonly endCol: number
  /** Symbol uid of the enclosing declaration, when known. */
  readonly callerSymbolUid: string | null
  /** Dispatch classification. */
  readonly dispatchKind: DispatchKind
  /** `direct`, `member`, `constructor`, or `template_event` (SFC template events). */
  readonly callKind: 'direct' | 'member' | 'constructor' | 'template_event'
  /** Receiver text for member calls. */
  readonly receiverExpr: string | null
  /** Non-punctuation argument count; `null` for regex-fallback edges. */
  readonly argCount: number | null
  /** True for `a?.b()` sites. */
  readonly isOptionalChain: boolean
  /** True when the call sits directly under `await`. */
  readonly isAwaited: boolean
  /** True for `new C()` sites. */
  readonly isConstructor: boolean
  /** Extraction tier that produced this record. */
  readonly parserTier: ParserTier
  /** Confidence reported alongside {@link CallEdgeRecord.parserTier}. */
  readonly parserConfidence: number
  /**
   * Resolution state, when the producing extraction is resolution-aware
   * (`'unresolved'` on SFC template edges). Walkers predate the resolution
   * phase and leave this unset.
   */
  readonly resolutionKind?: ResolutionKind
  /** Fine-grained resolver confidence, distinct from {@link CallEdgeRecord.parserConfidence}. */
  readonly resolutionConfidence?: number
  /**
   * Strategy tag naming where the edge came from (`'sfc_template'` marks SFC
   * template events). The resolution phase owns populated values.
   */
  readonly resolutionStrategy?: string
}

/**
 * One identifier reference. This phase's only producer is the SFC template
 * layer (component usage); general identifier extraction ships with the
 * resolution phase.
 */
export interface SymbolRefRecord {
  /** Positional id (`ref:<hex16>`, stable per file/line/col). */
  readonly refId: string
  /** Workspace-relative file path the reference was parsed from. */
  readonly filePath: string
  /** Referenced symbol name. */
  readonly symbolName: string
  /** Enclosing declaration name (the SFC component for template refs). */
  readonly container: string | null
  /** Reference classification (`component_usage` for template refs). */
  readonly refKind: string
  /** 1-based line. */
  readonly line: number
  /** 0-based UTF-8 byte column. */
  readonly column: number
  /** Resolved target symbol id; `null` means unresolved. */
  readonly targetSymbolId: string | null
  /** Resolved target file path, when bound. */
  readonly targetFilePath: string | null
  /** Resolved target symbol uid, when bound. */
  readonly targetSymbolUid: string | null
  /** Raw reference text when it differs from {@link SymbolRefRecord.symbolName}. */
  readonly refName: string | null
  /** Scope the reference sits in, when known. */
  readonly scopeId: string | null
  /** Resolution state (always `'unresolved'` in this phase). */
  readonly resolutionKind: ResolutionKind
  /** Fine-grained resolver confidence, distinct from {@link SymbolRefRecord.parserConfidence}. */
  readonly resolutionConfidence: number
  /** Strategy tag naming the producer (`'sfc_template'`). */
  readonly resolutionStrategy: string
  /** Inclusive 1-based end line, when known. */
  readonly refEndLine: number | null
  /** 0-based UTF-8 byte end column, when known. */
  readonly refEndCol: number | null
  /** Extraction tier that produced this record. */
  readonly parserTier: ParserTier
  /** Confidence reported alongside {@link SymbolRefRecord.parserTier}. */
  readonly parserConfidence: number
}

/** One string literal worth indexing. Classification arrives in a later phase. */
export interface LiteralRecord {
  /** Positional id (`lit:<hex16>`, stable per file/line/col). */
  readonly literalId: string
  /** Workspace-relative file path the literal was parsed from. */
  readonly filePath: string
  /** Literal text with quotes stripped. */
  readonly literal: string
  /** 1-based start line. */
  readonly line: number
  /** Enclosing declaration name, when known. */
  readonly container: string | null
  /** Symbol uid of the enclosing declaration, when known. */
  readonly enclosingSymbolUid: string | null
}

/** Complete extraction result for one file. */
export interface ParseOutcome {
  /** Language name the file was classified as (see `languageForPath`). */
  readonly language: string
  /** Extraction tier of the language's parser. */
  readonly parserTier: ParserTier
  /** Confidence reported alongside {@link ParseOutcome.parserTier}. */
  readonly parserConfidence: number
  /** Symbol definitions in source order. */
  readonly symbols: readonly SymbolRecord[]
  /** Import declarations in source order. */
  readonly imports: readonly ImportRecord[]
  /** Call sites: AST-extracted first, regex fallback merged in by (line, startCol). */
  readonly callEdges: readonly CallEdgeRecord[]
  /**
   * Identifier references. This phase's only producer is the SFC template
   * layer (component usage); general identifier extraction ships with the
   * resolution phase, and call-position references ride
   * {@link ParseOutcome.callEdges}.
   */
  readonly symbolRefs: readonly SymbolRefRecord[]
  /** Indexed string literals in source order. */
  readonly literals: readonly LiteralRecord[]
  /** True when the path matches the language's test-file heuristics. */
  readonly isTestFile: boolean
  /** One-line human summary (`"<path> (<lang>, N lines, M symbols)"`). */
  readonly summary: string
  /** First chunks of file text joined by `\n`, truncated to 20 000 chars. */
  readonly contentExcerpt: string
  /** Extraction failures formatted `"<file>: <message>"`; records before the failure stay in the outcome. */
  readonly parseErrors: readonly string[]
  /** Number of extraction failures ({@link ParseOutcome.parseErrors}.length). */
  readonly parseErrorCount: number
}
