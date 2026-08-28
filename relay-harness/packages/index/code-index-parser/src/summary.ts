/**
 * Human-facing summary line, content excerpt, and text shaping helpers
 * shared by the walker and the chunker.
 * @module
 */

import { Buffer } from 'node:buffer'

/** One indexed chunk's text-bearing projection (avoids a chunker import cycle). */
export interface ChunkText {
  readonly text: string
}

/** Excerpt ceiling in characters (reference truncation budget). */
export const EXCERPT_MAX_CHARS = 20_000

/**
 * Split `content` into lines with Rust `str::lines` semantics: a trailing
 * newline does not produce a trailing empty line, and only the empty string
 * yields an empty array. `\r` is stripped from line ends.
 * @param content - full file text.
 * @returns the lines without terminators.
 */
export function textLines(content: string): string[] {
  if (content === '') return []
  const lines = content.split('\n')
  if (content.endsWith('\n')) lines.pop()
  return lines.map(line => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

/**
 * Line count of `content` under {@link textLines} semantics.
 * @param content - full file text.
 * @returns the number of lines.
 */
export function textLineCount(content: string): number {
  if (content === '') return 0
  return content.split('\n').length - (content.endsWith('\n') ? 1 : 0)
}

/**
 * Summary line for one parsed file: `"<path> (<lang>, <n> lines, <s> symbols)"`.
 * (The reference implementation appends a route count; route extraction is
 * out of scope for this phase.)
 * @param relPath - workspace-relative file path.
 * @param language - classified language name.
 * @param lineCount - file line count.
 * @param symbolCount - extracted symbol count.
 * @returns the formatted summary line.
 */
export function formatSummary(
  relPath: string,
  language: string,
  lineCount: number,
  symbolCount: number,
): string {
  return `${relPath} (${language}, ${lineCount} lines, ${symbolCount} symbols)`
}

/**
 * Content excerpt: the first three chunk texts joined with `\n`, truncated
 * to {@link EXCERPT_MAX_CHARS} characters.
 * @param chunks - the file's chunks in order.
 * @returns the excerpt text.
 */
export function buildContentExcerpt(chunks: readonly ChunkText[]): string {
  return chunks.slice(0, 3).map(chunk => chunk.text).join('\n').slice(0, EXCERPT_MAX_CHARS)
}

/**
 * Approximate token count (1 token ~= 4 UTF-8 bytes), rounding up.
 * @param text - arbitrary text.
 * @returns the approximate token count.
 */
export function approxTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4)
}
