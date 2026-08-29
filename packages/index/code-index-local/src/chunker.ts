/**
 * Generic line-window chunker for the local provider.
 *
 * P1 parses no ASTs: every accepted file is split into windows of at most
 * {@link CHUNK_LINE_BUDGET} lines (`default_chunk_line_budget` in the
 * reference implementation's `IndexingConfig`), flagged as `generic` parser
 * output with fixed confidence, and decorated with filename heuristics only.
 * Undecodable files are treated as binary and skipped entirely by the caller;
 * files over the byte ceiling still record their file-level row (summary and
 * excerpt from the first window) but contribute no chunks.
 *
 * @module @relay-harness/rlh-code-index-local/chunker
 */

/** Maximum window size in lines, ported from `default_chunk_line_budget`. */
export const CHUNK_LINE_BUDGET = 80

/** Fixed extraction tier stamped on every chunk this package produces. */
export const GENERIC_PARSER_TIER = 'generic' as const

/** Confidence paired with {@link GENERIC_PARSER_TIER}: heuristic-only parsing. */
export const GENERIC_PARSER_CONFIDENCE = 0.5

/** Summary cap in Unicode code points, keeping file summaries far under FTS noise. */
export const FILE_SUMMARY_MAX_CHARS = 200

/** Excerpt cap in Unicode code points mirrored into `files_fts`. */
export const FILE_EXCERPT_MAX_CHARS = 1000

/** Well-known extensions mapped to language names for reader joins. */
const EXTENSION_LANGUAGES: Readonly<Record<string, string>> = {
  cs: 'csharp',
  css: 'css',
  dart: 'dart',
  go: 'go',
  html: 'html',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsx: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  lua: 'lua',
  md: 'markdown',
  php: 'php',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sc: 'scala',
  scala: 'scala',
  svelte: 'svelte',
  swift: 'swift',
  sql: 'sql',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'typescript',
  txt: 'text',
  vue: 'vue',
  yaml: 'yaml',
  yml: 'yaml',
}

/**
 * Map one workspace-relative path to the language name stored on its files row.
 * Dockerfiles (any suffix variant) map before the extension lookup runs.
 * @param filePath - workspace-relative POSIX path.
 * @returns the language name; `plaintext` when nothing better is known.
 */
export function deriveLanguage(filePath: string): string {
  const baseName = filePath.slice(filePath.lastIndexOf('/') + 1)
  if (baseName === 'Dockerfile' || baseName.startsWith('Dockerfile.')) return 'dockerfile'
  const dot = baseName.lastIndexOf('.')
  if (dot <= 0 || dot === baseName.length - 1) return 'plaintext'
  return EXTENSION_LANGUAGES[baseName.slice(dot + 1).toLowerCase()] ?? 'plaintext'
}

/**
 * Filename heuristics marking a path as test source, feeding ranking bonuses.
 * @param filePath - workspace-relative POSIX path.
 * @returns whether directory segments or the basename classify it as test source.
 */
export function isTestFile(filePath: string): boolean {
  const directoryHit = filePath.split('/').slice(0, -1)
    .some(part => part === 'test' || part === 'tests' || part === '__tests__')
  const baseName = filePath.slice(filePath.lastIndexOf('/') + 1)
  const prefixedHit = /^(?:test|spec)[._][^/]+$/u.test(baseName)
  const suffixedHit = /\.(?:test|spec)\.[^.]+$/u.test(baseName)
  return directoryHit || prefixedHit || suffixedHit
}

/**
 * Decode bytes as UTF-8 strictly.
 * @param bytes - raw payload bytes.
 * @returns the decoded text, or `null` when the payload is not valid UTF-8
 *   (the caller treats this as binary and skips the file).
 */
export function decodeUtf8Strict(bytes: Uint8Array): string | null {
  const decoder = new TextDecoder('utf-8', { fatal: true })
  try {
    return decoder.decode(bytes)
  } catch {
    // The fatal decoder is the whole binary gate here: invalid sequences are
    // the only rejection reason TextDecoder reports for utf-8.
    return null
  }
}

/** Split decoded text into lines, dropping the trailing empty element of a final newline. */
function splitLines(text: string): string[] {
  const rawLines = text.split('\n')
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop()
  return rawLines.map(line => line.endsWith('\r') ? line.slice(0, -1) : line)
}

/** Slice to a code-point budget so multibyte content truncates identically everywhere. */
function sliceCodePoints(text: string, maxChars: number): string {
  return Array.from(text).slice(0, maxChars).join('')
}

/** One prepared line-window chunk ready for storage binding. */
export interface PreparedChunk {
  /** Zero-based position within the file. */
  readonly chunkIndex: number
  /** Inclusive start line (1-based). */
  readonly startLine: number
  /** Inclusive end line (1-based). */
  readonly endLine: number
  /** Window text with original interior newlines preserved. */
  readonly text: string
  /** Cheap token estimate used for exit-side budgeting upstream. */
  readonly tokenEstimate: number
}

/** Everything a refresh pass needs to compose one file's stored row. */
export interface PreparedFileDocument {
  /** Language name derived from the path. */
  readonly language: string
  /** Whether filename heuristics classify the path as test source. */
  readonly isTestFile: boolean
  /** First meaningful line, bounded; empty when the file has none. */
  readonly summary: string
  /** First-window excerpt, bounded; empty for empty files. */
  readonly contentExcerpt: string
  /** Line windows; empty when the file is oversized or has zero lines. */
  readonly chunks: readonly PreparedChunk[]
}

/**
 * Chunk one file's bytes under the generic strategy.
 * @param filePath - workspace-relative path driving language/test heuristics.
 * @param bytes - full file contents.
 * @param options - {@link options.maxFileBytes} marks files whose row records
 *   no chunks.
 * @returns the prepared document, or `null` for an invalid-UTF-8 (binary) payload.
 */
export function prepareFileDocument(
  filePath: string,
  bytes: Uint8Array,
  options: { maxFileBytes: number },
): PreparedFileDocument | null {
  const text = decodeUtf8Strict(bytes)
  if (text === null) return null
  return prepareTextDocument(filePath, text, bytes.byteLength, options)
}

/**
 * Generic line-window preparation over already-decoded text; the byte length
 * travels separately because the byte ceiling (not the character count) marks
 * oversized rows.
 * @param filePath - workspace-relative path driving language/test heuristics.
 * @param text - decoded file contents.
 * @param byteLength - the payload's UTF-8 byte length.
 * @param options - {@link options.maxFileBytes} marks files whose row records
 *   no chunks.
 * @returns the prepared document.
 */
export function prepareTextDocument(
  filePath: string,
  text: string,
  byteLength: number,
  options: { maxFileBytes: number },
): PreparedFileDocument {
  const lines = splitLines(text)
  const oversized = byteLength > options.maxFileBytes
  const windows: Array<{ startLine: number; endLine: number }> = []
  if (!oversized) {
    for (let startLine = 1; startLine <= lines.length; startLine += CHUNK_LINE_BUDGET) {
      windows.push({ startLine, endLine: Math.min(startLine + CHUNK_LINE_BUDGET - 1, lines.length) })
    }
  }
  const firstWindowText = windows.length === 0 ? '' : joinWindow(lines, windows[0] as { startLine: number; endLine: number })
  return {
    language: deriveLanguage(filePath),
    isTestFile: isTestFile(filePath),
    summary: sliceCodePoints(firstMeaningfulLine(lines), FILE_SUMMARY_MAX_CHARS),
    contentExcerpt: sliceCodePoints(firstWindowText, FILE_EXCERPT_MAX_CHARS),
    chunks: windows.map((window, index) => ({
      chunkIndex: index,
      startLine: window.startLine,
      endLine: window.endLine,
      text: joinWindow(lines, window),
      tokenEstimate: Math.ceil(joinWindow(lines, window).length / 4),
    })),
  }
}

/** Concatenate one inclusive 1-based line range back into window text. */
function joinWindow(lines: readonly string[], window: { startLine: number; endLine: number }): string {
  return lines.slice(window.startLine - 1, window.endLine).join('\n')
}

/** First non-blank line, trimmed; falls back to the trimmed head of blank-only files. */
function firstMeaningfulLine(lines: readonly string[]): string {
  const meaningful = lines.find(line => line.trim() !== '')
  return (meaningful ?? lines[0] ?? '').trim()
}
