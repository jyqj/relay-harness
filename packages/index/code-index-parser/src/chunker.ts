/**
 * Unified chunking — splits source code into indexable chunks, symbol-aware
 * when the parser produced symbols, fixed line windows otherwise. Ported
 * from the reference implementation's `chunker.rs` (80-line default budget).
 * @module
 */

import type { ParserTier } from '@relay-harness/rlh-code-index'
import { chunkId } from './id.ts'
import type { SymbolKind, SymbolRecord } from './types.ts'
import { approxTokens, textLines } from './summary.ts'
import type { LanguageName } from './registry.ts'

/** One indexable chunk of a file. */
export interface ChunkRecord {
  /** Positional id (`chunk:<file>:<index>`). */
  readonly chunkId: string
  /** Workspace-relative file path. */
  readonly filePath: string
  /** Classified language name. */
  readonly language: LanguageName
  /** 0-based position of this chunk in the file's chunk sequence. */
  readonly chunkIndex: number
  /** Inclusive 1-based start line. */
  readonly startLine: number
  /** Inclusive 1-based end line. */
  readonly endLine: number
  /** Enclosing symbol name for symbol chunks, `""` for gap/fallback chunks. */
  readonly breadcrumb: string
  /** Chunk source text (lines joined with `\n`). */
  readonly text: string
  /** Enclosing symbol name, when chunked by a symbol span. */
  readonly symbolName: string | null
  /** Enclosing symbol kind, when chunked by a symbol span. */
  readonly symbolKind: SymbolKind | null
  /** Approximate token count of {@link ChunkRecord.text}. */
  readonly tokenEstimate: number
  /** Extraction tier that produced the chunk's metadata. */
  readonly parserTier: ParserTier
  /** Confidence reported alongside {@link ChunkRecord.parserTier}. */
  readonly parserConfidence: number
}

/** Default chunk window in lines (reference default). */
export const LINE_BUDGET = 80

interface ChunkParams {
  readonly filePath: string
  readonly content: string
  readonly language: LanguageName
  readonly parserTier: ParserTier
  readonly parserConfidence: number
  readonly lineBudget?: number
}

/**
 * Symbol-aware chunking: every symbol span becomes a chunk (gap text between
 * spans becomes gap chunks), and symbols longer than the line budget are
 * split into fixed windows that keep the symbol's name as breadcrumb.
 * @param params - file content, language, tier, and symbols; see {@link ChunkParams}.
 * @returns the chunks in file order.
 */
export function chunkWithSymbols(params: ChunkParams & {
  symbols: readonly SymbolRecord[]
}): ChunkRecord[] {
  const { filePath, content, language, parserTier, parserConfidence, symbols } = params
  const lineBudget = params.lineBudget ?? LINE_BUDGET
  const lines = textLines(content)
  if (lines.length === 0) return []

  const spans = symbols
    .map(symbol => ({
      startLine: symbol.startLine,
      endLine: symbol.endLine,
      name: symbol.name,
      kind: symbol.kind,
    }))
    .sort((a, b) => a.startLine - b.startLine)
  if (spans.length === 0) {
    return chunkByLines(params)
  }

  const chunks: ChunkRecord[] = []
  let index = 0
  let covered = 0

  for (const span of spans) {
    const s0 = Math.max(0, span.startLine - 1)
    const e0 = Math.min(span.endLine, lines.length)

    if (covered < s0) {
      const gap = lines.slice(covered, s0).join('\n')
      if (gap.trim().length > 0) {
        chunks.push(makeChunk({
          filePath, language, chunkIndex: index, parserTier, parserConfidence,
          startLine: covered + 1, endLine: span.startLine - 1,
          breadcrumb: '', text: gap, symbolName: null, symbolKind: null,
        }))
        index += 1
      }
    }

    const text = lines.slice(s0, e0).join('\n')
    const spanLines = e0 - s0
    if (spanLines <= lineBudget) {
      chunks.push(makeChunk({
        filePath, language, chunkIndex: index, parserTier, parserConfidence,
        startLine: span.startLine, endLine: span.endLine,
        breadcrumb: span.name, text, symbolName: span.name, symbolKind: span.kind,
      }))
      index += 1
    } else {
      let offset = 0
      while (offset < spanLines) {
        const end = Math.min(offset + lineBudget, spanLines)
        chunks.push(makeChunk({
          filePath, language, chunkIndex: index, parserTier, parserConfidence,
          startLine: span.startLine + offset, endLine: span.startLine + end - 1,
          breadcrumb: span.name, text: lines.slice(s0 + offset, s0 + end).join('\n'),
          symbolName: span.name, symbolKind: span.kind,
        }))
        index += 1
        offset = end
      }
    }
    // Overlapping spans cover forward: `covered` is assigned unconditionally,
    // matching the reference implementation.
    covered = span.endLine
  }

  if (covered < lines.length) {
    const gap = lines.slice(covered).join('\n')
    if (gap.trim().length > 0) {
      chunks.push(makeChunk({
        filePath, language, chunkIndex: index, parserTier, parserConfidence,
        startLine: covered + 1, endLine: lines.length,
        breadcrumb: '', text: gap, symbolName: null, symbolKind: null,
      }))
    }
  }

  return chunks
}

/**
 * Line-based fallback chunking: fixed windows, blank windows skipped.
 * @param params - file content, language, and tier; see {@link ChunkParams}.
 * @returns the chunks in file order.
 */
export function chunkByLines(params: ChunkParams): ChunkRecord[] {
  const { filePath, content, language, parserTier, parserConfidence } = params
  const lineBudget = params.lineBudget ?? LINE_BUDGET
  const lines = textLines(content)
  if (lines.length === 0) return []
  const chunks: ChunkRecord[] = []
  let index = 0
  let offset = 0
  while (offset < lines.length) {
    const end = Math.min(offset + lineBudget, lines.length)
    const text = lines.slice(offset, end).join('\n')
    if (text.trim().length > 0) {
      chunks.push(makeChunk({
        filePath, language, chunkIndex: index, parserTier, parserConfidence,
        startLine: offset + 1, endLine: end,
        breadcrumb: '', text, symbolName: null, symbolKind: null,
      }))
      index += 1
    }
    offset = end
  }
  return chunks
}

function makeChunk(args: {
  filePath: string
  language: LanguageName
  chunkIndex: number
  startLine: number
  endLine: number
  breadcrumb: string
  text: string
  symbolName: string | null
  symbolKind: SymbolKind | null
  parserTier: ParserTier
  parserConfidence: number
}): ChunkRecord {
  return {
    chunkId: chunkId(args.filePath, args.chunkIndex),
    filePath: args.filePath,
    language: args.language,
    chunkIndex: args.chunkIndex,
    startLine: args.startLine,
    endLine: args.endLine,
    breadcrumb: args.breadcrumb,
    text: args.text,
    symbolName: args.symbolName,
    symbolKind: args.symbolKind,
    tokenEstimate: approxTokens(args.text),
    parserTier: args.parserTier,
    parserConfidence: args.parserConfidence,
  }
}
