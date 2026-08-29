/**
 * Parsing layer for the local code-index capability: one entry point turns a
 * file's text into symbols, imports, call edges, and literals, plus the
 * summary/excerpt projection the index stores alongside them.
 *
 * Walker coverage: the JS/TS family (JavaScript, TypeScript, TSX, JSX),
 * Python, and Rust through their semantic-tier walkers; Go, Java, C, and C++
 * through their tree-sitter-tier walkers; Vue and Svelte single-file
 * components by lifting their `<script>` blocks onto the JS/TS walker and
 * adding template refs/events; and C#, PHP, Ruby, Swift, Kotlin, Dart,
 * Scala, and Lua through the grammar-free regex-heuristic spec-driven
 * extractor. `parseFile` returns `null` only for unsupported paths and
 * oversized files, both of which the caller handles through generic chunking.
 *
 * @module @relay-harness/rlh-code-index-parser
 */

import { Buffer } from 'node:buffer'
import type { ParserTier } from '@relay-harness/rlh-code-index'
import { chunkByLines, chunkWithSymbols } from './chunker.ts'
import { extractCCpp } from './languages/c-cpp.ts'
import { extractGo } from './languages/go.ts'
import { extractJava } from './languages/java.ts'
import { extractJsts, grammarFor } from './languages/jsts/index.ts'
import { extractPython } from './languages/python/index.ts'
import { extractRust } from './languages/rust/index.ts'
import { extractSfc } from './languages/sfc.ts'
import { extractSpecDriven } from './languages/spec-driven/index.ts'
import { resolveImport } from './import-resolver.ts'
import { supportedLanguageFor } from './registry.ts'
import type { SupportedLanguage } from './registry.ts'
import { buildContentExcerpt, formatSummary, textLineCount } from './summary.ts'
import { isTestFile } from './test-detect.ts'
import type {
  CallEdgeRecord,
  ImportRecord,
  LiteralRecord,
  ParseOutcome,
  SymbolRecord,
  SymbolRefRecord,
} from './types.ts'

export { chunkByLines, chunkWithSymbols, LINE_BUDGET } from './chunker.ts'
export type { ChunkRecord } from './chunker.ts'
export { languageForPath, supportedLanguageFor, tierForLanguage } from './registry.ts'
export type { LanguageName, SupportedLanguage } from './registry.ts'
export { initParser, loadLanguage } from './loader.ts'
export { resolveImport } from './import-resolver.ts'
export { isTestFile } from './test-detect.ts'
export { approxTokens, buildContentExcerpt, formatSummary } from './summary.ts'
export {
  literalId,
  refId,
  symbolUid,
  edgeId,
  chunkId,
  normalizeWhitespace,
} from './id.ts'
export type {
  ParseOutcome,
  SymbolRecord,
  SymbolKind,
  ImportRecord,
  CallEdgeRecord,
  LiteralRecord,
  DispatchKind,
} from './types.ts'

/** Options for {@link parseFile}. */
export interface ParseFileOptions {
  /** Workspace root used to resolve import specifiers to project files. */
  readonly projectRoot: string
  /** Byte ceiling; a file over it yields `null` (the caller falls back to generic handling). */
  readonly maxFileBytes: number
}

/**
 * Parse one file into its index records.
 *
 * @param relPath - workspace-relative file path.
 * @param text - full file text.
 * @param options - workspace root and byte ceiling; see {@link ParseFileOptions}.
 * @returns the extraction outcome, or `null` when the file exceeds
 * `maxFileBytes` or its language has no parser (grammar walker or spec-driven
 * table row).
 */
export async function parseFile(
  relPath: string,
  text: string,
  options: ParseFileOptions,
): Promise<ParseOutcome | null> {
  if (Buffer.byteLength(text, 'utf8') > options.maxFileBytes) return null
  const language = supportedLanguageFor(relPath)
  if (language === null) return null
  // `WALKED_TIERS` covers every supported language; the gate stays so the
  // dispatch switch's default arm remains a loud contract failure.
  const tier = WALKED_TIERS.get(language)
  /* v8 ignore next: unreachable while the map and `SupportedLanguage` stay
     in lockstep — the arm keeps a future map/union drift loud. */
  if (tier === undefined) return null

  try {
    return await extract(language, tier, relPath, text, options)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const parseErrors = [`${relPath}: ${message}`]
    return {
      language,
      parserTier: tier.tier,
      parserConfidence: tier.confidence,
      symbols: [],
      imports: [],
      callEdges: [],
      symbolRefs: [],
      literals: [],
      isTestFile: isTestFile(relPath, language),
      summary: formatSummary(relPath, language, textLineCount(text), 0),
      contentExcerpt: '',
      parseErrors,
      parseErrorCount: parseErrors.length,
    }
  }
}

/** Walker-agnostic extraction result; every language extractor returns this. */
interface WalkerExtraction {
  readonly symbols: SymbolRecord[]
  readonly imports: ImportRecord[]
  readonly callEdges: CallEdgeRecord[]
  readonly literals: LiteralRecord[]
  /** Template refs; empty except for the SFC extractor. */
  readonly symbolRefs: readonly SymbolRefRecord[]
}

/**
 * Lift a Go/Java/C/C++ extraction (no literal extraction yet) onto the
 * walker-agnostic result.
 */
function withNoLiterals(extraction: {
  symbols: SymbolRecord[]
  imports: ImportRecord[]
  callEdges: CallEdgeRecord[]
}): WalkerExtraction {
  return { ...extraction, literals: [], symbolRefs: [] }
}

/**
 * Lift a literal-producing extraction (which emits no template refs in this
 * phase) onto the walker-agnostic result.
 */
function withNoRefs(extraction: {
  symbols: SymbolRecord[]
  imports: ImportRecord[]
  callEdges: CallEdgeRecord[]
  literals: LiteralRecord[]
}): WalkerExtraction {
  return { ...extraction, symbolRefs: [] }
}

/**
 * Dispatch a walked language to its extractor. The JS/TS family shares one
 * walker keyed by grammar; Python, Rust, Go, Java, and C/C++ have dedicated
 * walkers; the spec-driven languages share one regex-driven extractor keyed
 * by language.
 * @param language - a language with a walker (gated by {@link WALKED_TIERS}).
 * @param relPath - workspace-relative file path.
 * @param text - full file text.
 * @returns the extraction outcome.
 */
function extractWithWalker(
  language: SupportedLanguage,
  relPath: string,
  text: string,
): Promise<WalkerExtraction> {
  switch (language) {
    case 'javascript':
    case 'jsx':
      return extractJsts(relPath, text, grammarFor('javascript')).then(withNoRefs)
    case 'typescript':
      return extractJsts(relPath, text, grammarFor('typescript')).then(withNoRefs)
    case 'tsx':
      return extractJsts(relPath, text, grammarFor('tsx')).then(withNoRefs)
    case 'python':
      return extractPython(relPath, text).then(withNoRefs)
    case 'rust':
      return extractRust(relPath, text).then(withNoRefs)
    case 'go':
      return extractGo(relPath, text).then(withNoLiterals)
    case 'java':
      return extractJava(relPath, text).then(withNoLiterals)
    case 'c':
    case 'cpp':
      return extractCCpp(relPath, text, language).then(withNoLiterals)
    case 'vue':
    case 'svelte':
      // SFC extraction reuses the JS/TS grammars internally — no loader of
      // its own — and is the only producer of symbol refs in this phase.
      return extractSfc(language, relPath, text)
    case 'csharp':
    case 'php':
    case 'ruby':
    case 'swift':
    case 'kotlin':
    case 'dart':
    case 'scala':
    case 'lua':
      // Grammar-free extraction: synchronous, no loader involvement.
      return Promise.resolve(withNoRefs(extractSpecDriven(language, relPath, text)))
    /* v8 ignore next 2: `WALKED_TIERS` gates the entry before dispatch and
       covers every `SupportedLanguage` member, so the default arm is
       unreachable through `parseFile`. */
    default:
      throw new Error(`no walker implemented for '${String(language)}'`)
  }
}

async function extract(
  language: SupportedLanguage,
  tier: { tier: ParserTier; confidence: number },
  relPath: string,
  text: string,
  options: ParseFileOptions,
): Promise<ParseOutcome> {
  const extraction = await extractWithWalker(language, relPath, text)
  const imports = extraction.imports.map(importRecord => ({
    ...importRecord,
    resolvedPath: resolveImport(options.projectRoot, relPath, importRecord.importString),
  }))
  const symbols = extraction.symbols
  const chunks = symbols.length > 0
    ? chunkWithSymbols({
      filePath: relPath,
      content: text,
      language,
      symbols,
      parserTier: tier.tier,
      parserConfidence: tier.confidence,
    })
    : chunkByLines({
      filePath: relPath,
      content: text,
      language,
      parserTier: tier.tier,
      parserConfidence: tier.confidence,
    })
  return {
    language,
    parserTier: tier.tier,
    parserConfidence: tier.confidence,
    symbols,
    imports,
    callEdges: extraction.callEdges,
    symbolRefs: extraction.symbolRefs,
    literals: extraction.literals,
    isTestFile: isTestFile(relPath, language),
    summary: formatSummary(relPath, language, textLineCount(text), symbols.length),
    contentExcerpt: buildContentExcerpt(chunks),
    parseErrors: [],
    parseErrorCount: 0,
  }
}

/** Walker-implemented languages with their tier assignments (every supported language). */
const WALKED_TIERS: ReadonlyMap<string, { tier: ParserTier; confidence: number }> = new Map([
  ['javascript', { tier: 'semantic', confidence: 0.85 }],
  ['typescript', { tier: 'semantic', confidence: 0.85 }],
  ['tsx', { tier: 'semantic', confidence: 0.85 }],
  ['jsx', { tier: 'semantic', confidence: 0.85 }],
  ['python', { tier: 'semantic', confidence: 0.85 }],
  ['rust', { tier: 'semantic', confidence: 0.85 }],
  ['go', { tier: 'tree-sitter', confidence: 0.7 }],
  ['java', { tier: 'tree-sitter', confidence: 0.7 }],
  ['c', { tier: 'tree-sitter', confidence: 0.7 }],
  ['cpp', { tier: 'tree-sitter', confidence: 0.7 }],
  // SFC: the reference `parse_sfc` pins 0.78 on its outcome despite the
  // heuristic tier's 0.5 default — the pin is the tier entry here.
  ['vue', { tier: 'heuristic', confidence: 0.78 }],
  ['svelte', { tier: 'heuristic', confidence: 0.78 }],
  ['csharp', { tier: 'heuristic', confidence: 0.5 }],
  ['php', { tier: 'heuristic', confidence: 0.5 }],
  ['ruby', { tier: 'heuristic', confidence: 0.5 }],
  ['swift', { tier: 'heuristic', confidence: 0.5 }],
  ['kotlin', { tier: 'heuristic', confidence: 0.5 }],
  ['dart', { tier: 'heuristic', confidence: 0.5 }],
  ['scala', { tier: 'heuristic', confidence: 0.5 }],
  ['lua', { tier: 'heuristic', confidence: 0.5 }],
])
