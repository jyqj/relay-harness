/**
 * Extra extraction for JS/TS — literal collection and the regex call
 * fallback. Ported from the reference implementation's `jsts/extras.rs`;
 * only literals the classifier recognizes are recorded (reference parity),
 * and the regex identifier-ref half of the reference scan ships with
 * resolution.
 * @module
 */

import { Buffer } from 'node:buffer'
import type { Node as TsNode } from 'web-tree-sitter'
import { positionOf } from '../../columns.ts'
import { edgeId } from '../../id.ts'
import type { ExtractCtx } from '../../shared/extract-ctx.ts'
import { JS_KEYWORDS } from '../../shared/identifiers.ts'
import type { CallEdgeRecord, SymbolRecord } from '../../types.ts'
import { textLines } from '../../summary.ts'
import { classifyLiteral } from './literal-classify.ts'

/** Literal byte-size window worth indexing (reference: `3..=160`). */
const LITERAL_MIN_BYTES = 3
const LITERAL_MAX_BYTES = 160

/**
 * A literal within the byte window; classification arrives in a later phase.
 * @param value - quote-stripped literal text.
 * @returns true when the byte length is 3 through 160.
 */
export function isIndexableLiteral(value: string): boolean {
  const bytes = Buffer.byteLength(value, 'utf8')
  return bytes >= LITERAL_MIN_BYTES && bytes <= LITERAL_MAX_BYTES
}

/**
 * Record a literal at `node`'s position when the classifier recognizes it —
 * unclassifiable literals are not worth indexing (reference parity).
 * @param value - quote-stripped literal text.
 * @param node - literal AST node.
 * @param source - full source text.
 * @param filePath - workspace-relative file path.
 * @param ctx - extraction accumulator.
 * @param container - enclosing declaration name, or `null`.
 * @returns nothing; classified literals land on `ctx`.
 */
export function addLiteral(
  value: string,
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  container: string | null,
): void {
  if (classifyLiteral(value) === null) return
  const position = positionOf(source, node.startIndex)
  ctx.literals.push({
    literalId: edgeId('lit', filePath, position.line, position.col),
    filePath,
    literal: value,
    line: position.line,
    container,
    enclosingSymbolUid: ctx.currentSymbolUid,
  })
}

/** Per-line call shape used by the regex fallback (reference `JS_CALL_RE`). */
const JS_CALL_RE = /[A-Za-z_][A-Za-z0-9_]*\s*\(/g

/**
 * Regex fallback scan for direct calls inside function/method bodies, used
 * for intra-file resolution. AST edges take priority: the walker merges
 * these by (line, startCol) and drops duplicates.
 * @param content - full file text.
 * @param filePath - workspace-relative file path.
 * @param symbols - extracted symbols bounding the scanned spans.
 * @returns the fallback call edges.
 */
export function extractRegexCalls(
  content: string,
  filePath: string,
  symbols: readonly SymbolRecord[],
): CallEdgeRecord[] {
  const lines = textLines(content)
  const calls: CallEdgeRecord[] = []
  for (const sym of symbols) {
    if (sym.kind !== 'function' && sym.kind !== 'method') continue
    const start = Math.max(0, sym.startLine - 1)
    const end = Math.min(sym.endLine, lines.length)
    for (const [offset, line] of lines.slice(start, end).entries()) {
      const lineNo = start + offset + 1
      for (const match of line.matchAll(JS_CALL_RE)) {
        // The match always ends at the call's opening parenthesis.
        const callee = match[0].slice(0, -1).trimEnd()
        if (JS_KEYWORDS.has(callee)) continue
        const startCol = Buffer.byteLength(line.slice(0, match.index), 'utf8')
        const endCol = Buffer.byteLength(line.slice(0, match.index + match[0].length), 'utf8')
        calls.push({
          edgeId: edgeId('call', filePath, lineNo, startCol),
          filePath,
          callerSymbol: sym.name,
          calleeSymbol: callee,
          line: lineNo,
          startCol,
          endLine: lineNo,
          endCol,
          callerSymbolUid: sym.symbolUid,
          dispatchKind: 'direct',
          callKind: 'direct',
          receiverExpr: null,
          argCount: null,
          isOptionalChain: false,
          isAwaited: false,
          isConstructor: false,
          parserTier: 'semantic',
          parserConfidence: 0.7,
        })
      }
    }
  }
  return calls
}
