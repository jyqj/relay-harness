/**
 * Spec-driven language table: per-language metadata plus the regex set the
 * extractor runs. Transcribed from the reference implementation's
 * `lang_spec.rs` (metadata) and `spec_driven.rs` (patterns, blocklist).
 * All eight languages parse without a grammar — pure regular-expression
 * heuristics at the `heuristic` tier.
 *
 * Regex transcription notes (`spec_driven.rs` → JavaScript):
 * - Rust `(?m)` becomes the `m` flag; `^` then matches at line starts. The JS
 *   `m` flag also treats `\r`, U+2028, and U+2029 as line terminators where
 *   Rust only splits on `\n`, but every pattern here requires a keyword at the
 *   anchor, and a `\r`-poisoned anchor position can only be followed by `\n`,
 *   which no alternative accepts — so the match sets agree.
 * - `[^\S\n]` (whitespace except newline) is portable as written.
 * - `SCALA_IMPORT_RE`: the reference's `\_` escape (literal underscore) is
 *   written as a plain `_`, so the suffix alternative `._` carries a WILDCARD
 *   dot where Rust matched a literal `._`. A faithful `\.\_` needs the Annex B
 *   `\_` compatibility escape, which oxlint's `no-useless-escape` rejects. The
 *   branch is unreachable in practice — greedy `[\w.]+` already consumes a
 *   wildcard-import suffix like `foo._`, and the optional group at the end of
 *   the pattern never participates when the empty match succeeds — so captures
 *   agree with the reference despite the looser alternative.
 * - No pattern uses JS-unsupported Rust constructs (`(?U)`, Unicode classes),
 *   so no other rewrites were needed.
 *
 * @module
 */

import type { LanguageName } from '../../registry.ts'

/** Languages served by the spec-driven extractor. */
export type SpecDrivenLanguage = Extract<
  LanguageName,
  'csharp' | 'php' | 'ruby' | 'swift' | 'kotlin' | 'dart' | 'scala' | 'lua'
>

/** One language's spec-driven parsing table row. */
export interface LanguageSpec {
  /** Classified language name (see `languageForPath`). */
  readonly language: SpecDrivenLanguage
  /** Reference grammar-name tag (metadata; kept for reference parity). */
  readonly grammarName: string
  /** File extensions for this language (without dot). */
  readonly extensions: readonly string[]
  /** Separator for qualified names (`"."`, `"::"`, `"\\"`). */
  readonly qnameSeparator: string
  /** Function/method declaration pattern (anchored at line start). */
  readonly funcRe: RegExp
  /** Class-like declaration pattern, or `null` for languages without one (Lua). */
  readonly classRe: RegExp | null
  /** Namespace/package context pattern, or `null` when the language has none. */
  readonly namespaceRe: RegExp | null
  /** Import-statement pattern (first non-empty capture group is the module string). */
  readonly importRe: RegExp
}

const CSHARP: LanguageSpec = {
  language: 'csharp',
  grammarName: 'c_sharp',
  extensions: ['cs'],
  qnameSeparator: '.',
  // CS_METHOD_RE
  funcRe: /^[^\S\n]*(?:(?:public|private|protected|internal|static|virtual|override|abstract|async|sealed|partial|new)\s+)*(?:\w+(?:<[^>]+>)?(?:\[\])?)\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/gm,  // eslint-disable-line @stylistic/max-len
  // CS_CLASS_RE
  classRe: /^[^\S\n]*(?:(?:public|private|protected|internal|static|abstract|sealed|partial|new)\s+)*(?:class|struct|interface|enum|record)\s+([A-Za-z_]\w*)/gm,  // eslint-disable-line @stylistic/max-len
  // CS_NAMESPACE_RE
  namespaceRe: /^[^\S\n]*namespace\s+([\w.]+)/gm,
  // CS_USING_RE
  importRe: /^[^\S\n]*using\s+(?:static\s+)?([\w.]+)\s*;/gm,
}

const PHP: LanguageSpec = {
  language: 'php',
  grammarName: 'php',
  extensions: ['php'],
  qnameSeparator: '\\',
  // PHP_FUNC_RE
  funcRe: /^[^\S\n]*(?:(?:public|private|protected|static|abstract|final)\s+)*function\s+([A-Za-z_]\w*)\s*\(/gm,
  // PHP_CLASS_RE
  classRe: /^[^\S\n]*(?:(?:abstract|final)\s+)?(?:class|interface|trait|enum)\s+([A-Za-z_]\w*)/gm,
  // PHP_NAMESPACE_RE
  namespaceRe: /^[^\S\n]*namespace\s+([\w\\]+)\s*;/gm,
  // PHP_USE_RE
  importRe: /^[^\S\n]*(?:use\s+([\w\\]+)|(?:require|include)(?:_once)?\s+['"]([^'"]+)['"])/gm,
}

const RUBY: LanguageSpec = {
  language: 'ruby',
  grammarName: 'ruby',
  extensions: ['rb', 'rake'],
  qnameSeparator: '::',
  // RB_DEF_RE
  funcRe: /^[^\S\n]*def\s+(?:self\.)?([A-Za-z_]\w*[?!=]?)/gm,
  // RB_CLASS_RE
  classRe: /^[^\S\n]*(?:class|module)\s+([A-Z]\w*(?:::[A-Z]\w*)*)/gm,
  namespaceRe: null,
  // RB_REQUIRE_RE
  importRe: /^[^\S\n]*(?:require|require_relative|load)\s+['"]([^'"]+)['"]/gm,
}

const SWIFT: LanguageSpec = {
  language: 'swift',
  grammarName: 'swift',
  extensions: ['swift'],
  qnameSeparator: '.',
  // SWIFT_FUNC_RE
  funcRe: /^[^\S\n]*(?:(?:public|private|internal|fileprivate|open|static|class|override|mutating|@\w+\s+)*\s*)func\s+([A-Za-z_]\w*)/gm,
  // SWIFT_CLASS_RE
  classRe: /^[^\S\n]*(?:(?:public|private|internal|fileprivate|open|final)\s+)?(?:class|struct|protocol|enum)\s+([A-Za-z_]\w*)/gm,
  namespaceRe: null,
  // SWIFT_IMPORT_RE
  importRe: /^[^\S\n]*import\s+(\w+)/gm,
}

const KOTLIN: LanguageSpec = {
  language: 'kotlin',
  grammarName: 'kotlin',
  extensions: ['kt', 'kts'],
  qnameSeparator: '.',
  // KT_FUN_RE
  funcRe: /^[^\S\n]*(?:(?:public|private|protected|internal|open|abstract|override|inline|suspend|operator|infix|tailrec)\s+)*fun\s+(?:<[^>]+>\s+)?([A-Za-z_]\w*)/gm,  // eslint-disable-line @stylistic/max-len
  // KT_CLASS_RE
  classRe: /^[^\S\n]*(?:(?:public|private|protected|internal|open|abstract|sealed|data|enum|inner|annotation)\s+)*(?:class|object|interface)\s+([A-Za-z_]\w*)/gm,  // eslint-disable-line @stylistic/max-len
  // KT_PACKAGE_RE
  namespaceRe: /^[^\S\n]*package\s+([\w.]+)/gm,
  // KT_IMPORT_RE
  importRe: /^[^\S\n]*import\s+([\w.]+(?:\.\*)?)/gm,
}

const DART: LanguageSpec = {
  language: 'dart',
  grammarName: 'dart',
  extensions: ['dart'],
  qnameSeparator: '.',
  // DART_FUNC_RE
  funcRe: /^[^\S\n]*(?:(?:static|abstract|external|@\w+\s+)*\s*)(?:\w+(?:<[^>]+>)?(?:\?)?)\s+([A-Za-z_]\w*)\s*(?:<[^>]*>)?\s*\(/gm,
  // DART_CLASS_RE
  classRe: /^[^\S\n]*(?:abstract\s+)?(?:class|enum|mixin|extension)\s+([A-Za-z_]\w*)/gm,
  // DART_LIBRARY_RE
  namespaceRe: /^[^\S\n]*library\s+([\w.]+)\s*;/gm,
  // DART_IMPORT_RE
  importRe: /^[^\S\n]*(?:import|export)\s+['"]([^'"]+)['"]/gm,
}

const SCALA: LanguageSpec = {
  language: 'scala',
  grammarName: 'scala',
  extensions: ['scala', 'sc'],
  qnameSeparator: '.',
  // SCALA_DEF_RE
  funcRe: /^[^\S\n]*(?:(?:private|protected|override|abstract|final|implicit|lazy)\s+)*def\s+([A-Za-z_]\w*)/gm,
  // SCALA_CLASS_RE
  classRe: /^[^\S\n]*(?:(?:abstract|sealed|final|private|protected|case|implicit)\s+)*(?:class|object|trait|enum)\s+([A-Za-z_]\w*)/gm,
  // SCALA_PACKAGE_RE
  namespaceRe: /^[^\S\n]*package\s+([\w.]+)/gm,
  // SCALA_IMPORT_RE (`\_` rewritten to `_`, leaving a wildcard dot in an
  // unreachable branch; see the module notes)
  importRe: /^[^\S\n]*import\s+([\w.]+(?:\.\{[^}]+\}|._)?)/gm,
}

const LUA: LanguageSpec = {
  language: 'lua',
  grammarName: 'lua',
  extensions: ['lua', 'luau'],
  qnameSeparator: '.',
  // LUA_FUNC_RE — matches both `function name()` and `local function name()`
  funcRe: /^[^\S\n]*(?:local\s+)?function\s+([A-Za-z_][\w.:]*)\s*\(/gm,
  // Lua has no class declarations; only functions are extracted.
  classRe: null,
  namespaceRe: null,
  // LUA_REQUIRE_RE — deliberately unanchored, as upstream
  importRe: /(?:require)\s*\(?['"]([^'"]+)['"]\)?/g,
}

/** The eight spec-driven rows, in the reference's `all_specs` order. */
export const SPEC_TABLE: readonly LanguageSpec[] = [CSHARP, PHP, RUBY, SWIFT, KOTLIN, DART, SCALA, LUA]

/**
 * Look up the spec-driven row for a classified language.
 * @param language - classified language name.
 * @returns the row, or `undefined` for languages outside the spec-driven set.
 */
export function specForLanguage(language: LanguageName): LanguageSpec | undefined {
  return SPEC_TABLE.find(spec => spec.language === language)
}

/**
 * Keywords that look like calls (`if (`, `while (`, …) across the supported
 * languages but are control-flow / declarations, never function calls.
 * Transcribed verbatim from the reference `CALL_KEYWORD_BLOCKLIST`; used to
 * suppress false-positive call edges.
 */
export const CALL_KEYWORD_BLOCKLIST: ReadonlySet<string> = new Set([
  'if',
  'else',
  'elif',
  'while',
  'for',
  'foreach',
  'switch',
  'match',
  'case',
  'when',
  'catch',
  'do',
  'return',
  'yield',
  'throw',
  'throws',
  'await',
  'using',
  'lock',
  'with',
  'in',
  'and',
  'or',
  'not',
  'is',
  'as',
  'new',
  'delete',
  'sizeof',
  'typeof',
  'defined',
  'func',
  'fun',
  'def',
  'function',
  'class',
  'struct',
  'interface',
  'enum',
  'trait',
  'object',
  'module',
  'namespace',
  'package',
  'import',
  'require',
  'include',
  'let',
  'var',
  'val',
  'const',
  'static',
  'public',
  'private',
  'protected',
  'internal',
  'override',
  'virtual',
  'abstract',
  'final',
  'sealed',
  'super',
  'base',
  'this',
  'self',
  'print',
  'puts',
  'echo',
])

/**
 * Generic call-site detector: an identifier (optionally dotted/`::`-qualified
 * receiver) immediately followed by `(`. Capture 1 = full callee path, capture
 * 2 = bare final segment used for intra-file symbol matching. Transcribed
 * verbatim from the reference `CALL_SITE_RE`.
 */
export const CALL_SITE_RE = /(?:([A-Za-z_][A-Za-z0-9_]*(?:\s*(?:\.|::|->)\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*(?:\.|::|->)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/g  // eslint-disable-line @stylistic/max-len
