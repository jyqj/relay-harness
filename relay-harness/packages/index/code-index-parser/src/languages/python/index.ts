/**
 * Python walker: one DFS pass extracts symbols and imports, then a
 * per-function-body regex pass extracts direct call edges with in-file
 * caller attribution. Ported from the reference implementation's
 * `python/mod.rs` (`visit_node_recursive`, `extract_refs_and_calls`); route
 * edges, HTTP/broker calls, diagnostics, semantic edges, and identifier refs
 * are out of scope for this phase (refs ship with the resolution phase).
 * @module
 */

import { Buffer } from 'node:buffer'
import { Parser } from 'web-tree-sitter'
import type { Node as TsNode } from 'web-tree-sitter'
import { edgeId } from '../../id.ts'
import { fieldOf } from '../../shared/cursor.ts'
import { loadLanguage, parseWith } from '../../loader.ts'
import { textLines } from '../../summary.ts'
import { ExtractCtx } from '../../shared/extract-ctx.ts'
import type { CallEdgeRecord, ImportRecord, LiteralRecord, SymbolRecord } from '../../types.ts'
import { extractImportFromStatement, extractImportStatement } from './imports.ts'
import { extractClass, extractFunction } from './symbols.ts'

/** Raw extraction output for one Python file. */
export interface PythonExtraction {
  readonly symbols: SymbolRecord[]
  readonly imports: ImportRecord[]
  readonly callEdges: CallEdgeRecord[]
  readonly literals: LiteralRecord[]
}

/**
 * Call shape used by the body call pass — the reference's
 * `([A-Za-z_][A-Za-z0-9_]*)\s*\(` rendered with a lookahead so the matched
 * text is the callee identifier itself, whose span is what the reference
 * records (the `(` and inter-token whitespace are excluded).
 */
const PY_CALL_RE = /[A-Za-z_][A-Za-z0-9_]*(?=\s*\()/g

/** Reserved words and common receivers that never surface as callees. */
const PY_KEYWORDS: ReadonlySet<string> = new Set([
  'def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'with', 'as', 'try', 'except',
  'finally', 'import', 'from', 'pass', 'True', 'False', 'None', 'and', 'or', 'not', 'in', 'is',
  'self',
])

/**
 * Semantic-tier call-edge confidence (reference confidence matrix:
 * `Semantic × CallEdge`).
 */
export const BODY_CALL_CONFIDENCE = 0.7

/**
 * Parse `text` with the Python grammar and extract symbols, imports, and the
 * direct call edges found inside function/method bodies.
 *
 * @param filePath - workspace-relative file path (used for record ids).
 * @param text - full file text.
 * @returns the extracted records.
 * @throws when the grammar or the parse itself fails; the caller formats and
 * counts the failure.
 */
export async function extractPython(filePath: string, text: string): Promise<PythonExtraction> {
  const language = await loadLanguage('python')
  const parser = new Parser()
  parser.setLanguage(language)
  const ctx = new ExtractCtx()
  try {
    const tree = parseWith(parser, text)
    try {
      visitNode(tree.rootNode, text, filePath, ctx, null)
    } finally {
      tree.delete()
    }
  } finally {
    parser.delete()
  }
  return {
    symbols: ctx.symbols,
    imports: ctx.imports,
    callEdges: extractBodyCalls(text, filePath, ctx.symbols),
    literals: [],
  }
}

/**
 * DFS walk. `container` is the enclosing class name inside class bodies — it
 * stays the class (not the method) while descending into method bodies, so a
 * function nested in a method is still qualified under the class (reference
 * behavior).
 */
function visitNode(
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  container: string | null,
): void {
  switch (node.type) {
    case 'class_definition':
      visitClassDefinition(node, source, filePath, ctx)
      return
    case 'decorated_definition':
      visitDecoratedDefinition(node, source, filePath, ctx, container)
      return
    case 'function_definition':
      // The record lands here; the recursion below still enters the body so
      // nested definitions and calls are found (the reference does not return
      // early for functions).
      pushFunction(node, source, filePath, ctx, container)
      break
    case 'import_statement':
      ctx.imports.push(...extractImportStatement(node, filePath))
      break
    case 'import_from_statement':
      ctx.imports.push(...extractImportFromStatement(node, filePath))
      break
    default:
      break
  }
  for (const child of node.children) visitNode(child, source, filePath, ctx, container)
}

/**
 * Class walk: extract the class, then dispatch its body members — functions
 * (plain or decorated) as methods of the class, nested classes re-entered
 * with the outer class as container, everything else re-entered for calls.
 * An enclosing container is intentionally ignored: a nested class's record
 * stays unqualified, as in the reference (`_parent_container`).
 */
function visitClassDefinition(
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
): void {
  const sym = extractClass(node, source, filePath)
  ctx.symbols.push(sym)
  // A class definition always carries its body (the grammar requires it).
  const body = fieldOf(node, 'body')
  for (const member of body.children) {
    if (member.type === 'function_definition' || member.type === 'decorated_definition') {
      visitMemberFunction(member, source, filePath, ctx, sym.name)
    } else if (member.type === 'class_definition') {
      visitClassDefinition(member, source, filePath, ctx)
    } else {
      visitNode(member, source, filePath, ctx, sym.name)
    }
  }
}

/**
 * Class-body function walk. Decorated members keep the decorated span for the
 * method record and skip decorator subtrees when re-entering; plain members
 * re-enter every child.
 */
function visitMemberFunction(
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  className: string,
): void {
  pushFunction(node, source, filePath, ctx, className)
  // Decorator subtrees are skipped only for class-body members (reference
  // asymmetry); the definition itself is re-entered for nested defs/calls.
  for (const child of node.children) {
    if (node.type === 'decorated_definition' && child.type === 'decorator') continue
    visitNode(child, source, filePath, ctx, className)
  }
}

/**
 * Module-level (or nested) decorated definition: the unwrapped function is
 * extracted at the decorated span, then every child — decorators included —
 * is re-entered (reference behavior).
 */
function visitDecoratedDefinition(
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  container: string | null,
): void {
  pushFunction(node, source, filePath, ctx, container)
  for (const child of node.children) visitNode(child, source, filePath, ctx, container)
}

function pushFunction(
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  container: string | null,
): void {
  ctx.symbols.push(extractFunction(node, source, filePath, container))
}

/* jscpd:ignore-start — the body-scan skeleton necessarily mirrors the jsts
   regex fallback (both port the same reference pattern); the keyword table,
   capture group, and confidence differ. */
/**
 * Regex call pass over function/method bodies (reference
 * `extract_refs_and_calls` call half). The `def` line itself is scanned, so a
 * parameter default call or the function's own name followed by `(` also
 * emits — reference behavior. Direct dispatch only: the reference's Python
 * call surface is text-based and resolves no receivers.
 * @param content - full file text.
 * @param filePath - workspace-relative file path.
 * @param symbols - extracted symbols bounding the scanned spans.
 * @returns the direct call edges in symbol order.
 */
function extractBodyCalls(
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
      for (const match of line.matchAll(PY_CALL_RE)) {
        const callee = match[0]
        if (PY_KEYWORDS.has(callee)) continue
        // The edge span is the callee identifier (reference `cap.get(1)`).
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
          parserConfidence: BODY_CALL_CONFIDENCE,
        })
      }
    }
  }
  return calls
}
/* jscpd:ignore-end */
