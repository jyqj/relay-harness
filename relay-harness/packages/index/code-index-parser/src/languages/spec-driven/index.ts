/**
 * Spec-driven extractor: symbol, import, and same-file call-edge extraction
 * for the eight languages without a vendored grammar (C#, PHP, Ruby, Swift,
 * Kotlin, Dart, Scala, Lua) through pure regular-expression heuristics.
 * Ported from the reference implementation's `spec_driven.rs`; the C#
 * `Environment.GetEnvironmentVariable` data-flow edges and the reference's
 * resolution-tier edge fields (callee uid, resolution kind/strategy) are out
 * of scope for this phase's record vocabulary.
 * @module
 */

import { edgeId, symbolUid } from '../../id.ts'
import { textLines } from '../../summary.ts'
import type { CallEdgeRecord, ImportRecord, SymbolKind, SymbolRecord } from '../../types.ts'
import { CALL_KEYWORD_BLOCKLIST, CALL_SITE_RE, specForLanguage } from './table.ts'
import type { LanguageSpec } from './table.ts'

/** Baseline confidence of the heuristic tier (reference `ParserTier::Heuristic.default_confidence`). */
export const HEURISTIC_CONFIDENCE = 0.5

/** Maximum lines scanned forward from a declaration when estimating its end. */
const END_SCAN_LIMIT = 200

/** Fallback span in lines when no closer is found within the scan limit. */
const END_FALLBACK_LINES = 30

/** Raw extraction output for one spec-driven file. */
export interface SpecDrivenExtraction {
  readonly symbols: SymbolRecord[]
  readonly imports: ImportRecord[]
  readonly callEdges: CallEdgeRecord[]
  /** Always empty: no spec-driven language extracts literals. */
  readonly literals: never[]
}

/**
 * Extract symbols, imports, and intra-file call edges from `text` with the
 * language's regex table.
 *
 * @param language - a spec-driven language (must resolve to a table row).
 * @param filePath - workspace-relative file path (used for record ids).
 * @param text - full file text.
 * @returns the extracted records.
 * @throws when `language` has no table row (a dispatch contract failure).
 */
export function extractSpecDriven(
  language: LanguageSpec['language'],
  filePath: string,
  text: string,
): SpecDrivenExtraction {
  const spec = specForLanguage(language)
  if (spec === undefined) throw new Error(`no spec-driven table row for '${language}'`)
  const lines = textLines(text)
  const content = lines.join('\n')
  const symbols = spec.classRe === null
    ? extractLuaFunctions(spec, lines, content, filePath)
    : extractWithRegexes(spec, spec.classRe, lines, content, filePath)
  return {
    symbols,
    imports: extractImports(spec, content, filePath),
    callEdges: extractCallEdges(content, filePath, symbols),
    literals: [],
  }
}

/**
 * Estimate a declaration's end line: scan forward from the declaration line
 * (at most {@link END_SCAN_LIMIT} lines) for a closing `}` / `end` / `end
 * ...` line at the declaration's indentation or less, falling back to
 * {@link END_FALLBACK_LINES} lines or the end of file. Ported from the
 * reference `estimate_end_line` — an estimate, never a parsed span.
 * @param lines - the file's lines (`textLines` semantics).
 * @param startLine - 1-based declaration start line.
 * @param startIndent - declaration line's leading-whitespace width.
 * @returns the estimated inclusive end line.
 */
function estimateEndLine(lines: readonly string[], startLine: number, startIndent: number): number {
  const scanEnd = Math.min(startLine - 1 + END_SCAN_LIMIT, lines.length)
  for (const [idx, line] of lines.entries()) {
    if (idx < startLine) continue
    if (idx >= scanEnd) break
    const trimmed = line.trim()
    if (trimmed === '}' || trimmed === 'end' || trimmed.startsWith('end ')) {
      if (line.length - line.trimStart().length <= startIndent) return idx + 1
    }
  }
  return Math.min(startLine - 1 + END_FALLBACK_LINES, lines.length)
}

/**
 * Leading-whitespace width of a declaration, read off the matched text: the
 * table patterns anchor at `^` and lead with `[^\S\n]*`, so everything before
 * the first non-whitespace character is exactly the line's indentation.
 */
function startIndentOf(declText: string): number {
  return declText.length - declText.trimStart().length
}

/**
 * Qualified name: `namespace<separator>name` when a namespace context was
 * found, the bare name otherwise (reference `build_qname`).
 */
function buildQname(spec: LanguageSpec, namespace: string | null, name: string): string {
  return namespace === null ? name : `${namespace}${spec.qnameSeparator}${name}`
}

/**
 * Classify a class-like declaration's matched text into its symbol kind, by
 * the reference `classify_class_kind` keyword order: interface → enum →
 * module → struct/record → protocol/trait → everything else (covers
 * `object` and plain classes).
 */
function classifyClassKind(declText: string): SymbolKind {
  if (declText.includes('interface')) return 'interface'
  if (declText.includes('enum')) return 'enum'
  if (declText.includes('module')) return 'module'
  if (declText.includes('struct') || declText.includes('record')) return 'class'
  if (declText.includes('protocol') || declText.includes('trait')) return 'interface'
  return 'class'
}

/**
 * The literal `spec:<file>:<kind>:<name>` symbol id.
 *
 * Deliberately NOT the SHA-256 `sym:`/`uid:` family from `../id.ts`: the
 * reference spec-driven parser emits this human-readable literal format, and
 * the port preserves it byte-for-byte for reference parity.
 *
 * Same-key redefinitions within one file (a Ruby class reopened, or `def self.x`
 * colliding with a same-name method under the same kind) repeat this id — and
 * its content-derived {@link symbolUid} — inside one file's delta. The store's
 * write path keeps the FIRST occurrence (`dedupeGraphRows` over symbolId, then
 * symbolUid), which differs from the reference store's `INSERT OR REPLACE`
 * last-wins semantics; later declarations of the same key never reach a row.
 */
function specSymbolId(filePath: string, kind: SymbolKind, name: string): string {
  return `spec:${filePath}:${kind}:${name}`
}

/** Assemble one symbol record for the matched declaration `name`. */
function makeSymbol(
  spec: LanguageSpec,
  filePath: string,
  name: string,
  kind: SymbolKind,
  namespace: string | null,
  declText: string,
  line: number,
  lines: readonly string[],
): SymbolRecord {
  const qname = buildQname(spec, namespace, name)
  return {
    symbolId: specSymbolId(filePath, kind, name),
    filePath,
    name,
    kind,
    container: namespace,
    startLine: line,
    endLine: estimateEndLine(lines, line, startIndentOf(declText)),
    startCol: 0,
    endCol: 0,
    signature: null,
    parserTier: 'heuristic',
    parserConfidence: HEURISTIC_CONFIDENCE,
    qname,
    parentSymbolId: null,
    exportName: null,
    isDefaultExport: false,
    symbolUid: symbolUid(filePath, qname, kind),
    frameworkRole: null,
    receiverType: null,
    paramTypes: null,
    returnType: null,
    paramCount: null,
  }
}

/** 1-based line of `offset` in `content`: newline count before it, plus one. */
function lineOf(content: string, offset: number): number {
  let line = 1
  let at = content.indexOf('\n')
  while (at >= 0 && at < offset) {
    line++
    at = content.indexOf('\n', at + 1)
  }
  return line
}

/** The capture group naming a declaration; the table patterns always capture it. */
function capturedName(match: RegExpExecArray): string {
  const name = match[1]
  /* v8 ignore next: every table pattern's only capture group participates in
     a successful match */
  if (name === undefined) return ''
  return name
}

/**
 * First match's capture, or `null` when the pattern finds nothing. Consumed
 * through `matchAll` (which scans a clone) so the table regexes' shared
 * `lastIndex` state is never mutated between files.
 */
function firstCapture(content: string, pattern: RegExp | null): string | null {
  if (pattern === null) return null
  for (const match of content.matchAll(pattern)) return capturedName(match)
  return null
}

/**
 * The generic pass (reference `extract_with_regexes`): every class-like match
 * first, then every function/method match; an indented function counts as a
 * method, and the first namespace capture names every symbol's container.
 */
function extractWithRegexes(
  spec: LanguageSpec,
  classRe: RegExp,
  lines: readonly string[],
  content: string,
  filePath: string,
): SymbolRecord[] {
  const symbols: SymbolRecord[] = []
  const namespace = firstCapture(content, spec.namespaceRe)

  for (const match of content.matchAll(classRe)) {
    const line = lineOf(content, match.index)
    symbols.push(makeSymbol(
      spec,
      filePath,
      capturedName(match),
      classifyClassKind(match[0]),
      namespace,
      match[0],
      line,
      lines,
    ))
  }

  for (const match of content.matchAll(spec.funcRe)) {
    const line = lineOf(content, match.index)
    // Heuristic: an indented declaration sits inside a class-like body.
    const kind: SymbolKind = startIndentOf(match[0]) > 0 ? 'method' : 'function'
    symbols.push(makeSymbol(spec, filePath, capturedName(match), kind, namespace, match[0], line, lines))
  }

  return symbols
}

/**
 * Lua has no class declarations: functions only, with the reference's Lua
 * branch — a dotted/colon-qualified name or an indented declaration is a
 * method, and the qualified name itself is the qname (no namespace pass).
 */
function extractLuaFunctions(
  spec: LanguageSpec,
  lines: readonly string[],
  content: string,
  filePath: string,
): SymbolRecord[] {
  const symbols: SymbolRecord[] = []
  for (const match of content.matchAll(spec.funcRe)) {
    const name = capturedName(match)
    const line = lineOf(content, match.index)
    const kind: SymbolKind = name.includes(':') || name.includes('.') || startIndentOf(match[0]) > 0
      ? 'method'
      : 'function'
    symbols.push(makeSymbol(spec, filePath, name, kind, null, match[0], line, lines))
  }
  return symbols
}

/**
 * Import records: one pattern per language; the module string is the first
 * non-empty capture group after group 0 (reference `extract_imports_re`),
 * with the constant record tail every regex importer shares.
 */
function extractImports(spec: LanguageSpec, content: string, filePath: string): ImportRecord[] {
  const records: ImportRecord[] = []
  for (const match of content.matchAll(spec.importRe)) {
    for (let group = 1; group < match.length; group++) {
      const importString = match[group]
      if (importString === undefined) continue
      records.push({
        filePath,
        importString,
        resolvedPath: null,
        importedName: null,
        alias: null,
        isNamespace: false,
        isDefault: false,
        isReexport: false,
      })
      break
    }
  }
  return records
}

/**
 * Same-file call-edge heuristic (reference `extract_call_edges`, emitted by
 * default on every parse): each `name(` site whose bare callee resolves to an
 * in-file function/method produces one edge at exact confidence. Unresolved
 * or external callees drop — for a regex-only parser an unresolved guess is
 * more likely a false positive than a useful edge. Guards, in upstream order:
 * the keyword blocklist, the declaration line itself, and self-loops; the
 * caller is the innermost containing function/method that does not *start* on
 * the call line (the extractor can misparse `return Helper(x)` as a method
 * declaration, and that phantom must not become the caller).
 */
function extractCallEdges(
  content: string,
  filePath: string,
  symbols: readonly SymbolRecord[],
): CallEdgeRecord[] {
  // Index callable symbols by name; the first definition wins on duplicates.
  const byName = new Map<string, SymbolRecord>()
  for (const sym of symbols) {
    if ((sym.kind === 'function' || sym.kind === 'method') && !byName.has(sym.name)) {
      byName.set(sym.name, sym)
    }
  }
  if (byName.size === 0) return []

  const edges: CallEdgeRecord[] = []
  for (const match of content.matchAll(CALL_SITE_RE)) {
    const callee = match[2]
    /* v8 ignore next: capture 2 always participates in a successful match */
    if (callee === undefined) continue
    if (CALL_KEYWORD_BLOCKLIST.has(callee)) continue
    const calleeSym = byName.get(callee)
    if (calleeSym === undefined) continue

    // Capture 2 is the match's final identifier before the trailing
    // `\s*\(`, so its last occurrence in the match text is its position
    // (the reference reads the same offsets off `cap.get(2)`).
    const calleeStart = match.index + match[0].lastIndexOf(callee)
    const calleeEnd = calleeStart + callee.length
    const line = lineOf(content, calleeStart)
    // The reference records the callee's absolute content offset in both
    // position fields (not a within-line column); preserved for parity.
    const startCol = calleeStart
    if (calleeSym.startLine === line) continue

    // Innermost enclosing fn/method (reference `min_by_key` on span, first
    // definition wins on ties), excluding declarations starting on the line.
    const enclosing = symbols.filter(sym =>
      (sym.kind === 'function' || sym.kind === 'method')
      && sym.startLine < line
      && sym.endLine >= line)
    const minSpan = Math.min(...enclosing.map(sym => sym.endLine - sym.startLine), Number.POSITIVE_INFINITY)
    let caller: SymbolRecord | null = null
    for (const sym of enclosing) {
      if (sym.endLine - sym.startLine === minSpan) {
        caller = sym
        break
      }
    }
    // Self-loops (recursion) are noise from the phantom-symbol misparse above.
    if (caller !== null && caller.symbolUid === calleeSym.symbolUid) continue

    edges.push({
      edgeId: edgeId('call', filePath, line, startCol),
      filePath,
      calleeSymbol: callee,
      callerSymbol: caller === null ? null : caller.name,
      line,
      startCol,
      endLine: line,
      endCol: calleeEnd,
      callerSymbolUid: caller === null ? null : caller.symbolUid,
      dispatchKind: 'direct',
      // The reference's per-shape call kinds map onto this package's member
      // vocabulary; a bare-name callee is a direct call.
      callKind: 'direct',
      receiverExpr: null,
      argCount: null,
      isOptionalChain: false,
      isAwaited: false,
      isConstructor: false,
      parserTier: 'heuristic',
      parserConfidence: HEURISTIC_CONFIDENCE,
    })
  }
  return edges
}
