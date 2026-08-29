/**
 * Position arithmetic: string indices from tree-sitter nodes to 1-based lines
 * and 0-based UTF-8 byte columns (the reference implementation's byte-column
 * convention; web-tree-sitter indices are UTF-16 code units, so columns are
 * re-measured over the source text, never taken from the node's point).
 * @module
 */

import { Buffer } from 'node:buffer'

/** Position of one string index in a source text. */
export interface SourcePosition {
  /** 1-based line. */
  readonly line: number
  /** 0-based UTF-8 byte offset from the start of the line. */
  readonly col: number
}

/**
 * Resolve the 1-based line and UTF-8 byte column of `index` within `source`.
 * An `index` of 0 is line 1, column 0; an index at a `\n` belongs to the line
 * that ends there.
 * @param source - full source text the index refers to.
 * @param index - UTF-16 code-unit offset into `source`.
 * @returns the 1-based line and 0-based UTF-8 byte column.
 */
export function positionOf(source: string, index: number): SourcePosition {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1
  return {
    line: countLines(source, lineStart) + 1,
    col: Buffer.byteLength(source.slice(lineStart, index), 'utf8'),
  }
}

function countLines(source: string, upTo: number): number {
  let lines = 0
  for (let i = 0; i < upTo; i++) {
    if (source.charCodeAt(i) === 10) lines++
  }
  return lines
}

/** Inclusive 1-based start/end lines and 0-based UTF-8 byte columns of a span. */
export interface Span {
  readonly startLine: number
  readonly endLine: number
  readonly startCol: number
  readonly endCol: number
}

/**
 * Resolve the full span (lines and byte columns) between two string indices —
 * the multi-byte-safe equivalent of reading tree-sitter's start/end points.
 * @param source - full source text the indices refer to.
 * @param startIndex - UTF-16 offset of the first character.
 * @param endIndex - UTF-16 offset one past the last character.
 * @returns inclusive 1-based lines and 0-based UTF-8 byte columns.
 */
export function spanOf(source: string, startIndex: number, endIndex: number): Span {
  const start = positionOf(source, startIndex)
  const end = positionOf(source, endIndex)
  return {
    startLine: start.line,
    endLine: end.line,
    startCol: start.col,
    endCol: end.col,
  }
}
