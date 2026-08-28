/**
 * Call-edge extraction for Rust — an AST walk over function/method bodies
 * recognizing plain, path-qualified, method-receiver, and turbofish calls
 * plus macro invocations. Ported from the reference implementation's
 * `rust.rs` (`extract_refs_and_calls`, `resolve_callee`); identifier refs and
 * the in-file `by_name` resolution ship with the resolution phase.
 * @module
 */

import type { Node as TsNode } from 'web-tree-sitter'
import { spanOf } from '../../columns.ts'
import { edgeId } from '../../id.ts'
import { fieldOf } from '../../shared/cursor.ts'
import type { SymbolRecord, CallEdgeRecord, DispatchKind } from '../../types.ts'

/** Semantic-tier call-edge confidence (reference matrix: `Semantic × CallEdge`). */
export const RUST_CALL_CONFIDENCE = 0.7

/** Rust keywords and pseudo-identifiers that never surface as callees. */
const RS_KEYWORDS: ReadonlySet<string> = new Set([
  'fn', 'let', 'mut', 'pub', 'impl', 'struct', 'enum', 'trait', 'use', 'mod', 'match', 'if',
  'else', 'loop', 'while', 'for', 'return', 'self', 'Self', 'crate', 'super',
])

/** Resolved callee of a call expression's `function` node. */
interface ResolvedCallee {
  readonly callee: string
  readonly dispatch: DispatchKind
  readonly receiver: string | null
}

/**
 * Walk the whole tree, attributing every call inside a function/method body
 * to that function. A nested `function_item` with no extracted symbol (the
 * declaration walk only registers top-level and `impl` functions) keeps the
 * outer function as the caller — reference behavior.
 * @param root - tree root node.
 * @param source - full source text.
 * @param filePath - workspace-relative file path.
 * @param symbols - symbols from the declaration pass (function binding).
 * @returns the call edges in source order.
 */
export function extractCalls(
  root: TsNode,
  source: string,
  filePath: string,
  symbols: readonly SymbolRecord[],
): CallEdgeRecord[] {
  const calls: CallEdgeRecord[] = []
  walkForCalls(root, source, filePath, symbols, null, calls)
  return calls
}

function walkForCalls(
  node: TsNode,
  source: string,
  filePath: string,
  symbols: readonly SymbolRecord[],
  currentFn: SymbolRecord | null,
  calls: CallEdgeRecord[],
): void {
  let activeFn = currentFn
  if (node.type === 'function_item') {
    const sym = findSymbolForFn(node, source, symbols)
    if (sym !== undefined) activeFn = sym
  }
  // Calls and macros emit only inside a known function/method body.
  if (activeFn !== null) {
    if (node.type === 'call_expression') {
      extractCall(node, source, filePath, activeFn, calls)
    } else if (node.type === 'macro_invocation') {
      extractMacroCall(node, source, filePath, activeFn, calls)
    }
  }
  for (const child of node.children) {
    walkForCalls(child, source, filePath, symbols, activeFn, calls)
  }
}

/**
 * The extracted Function/Method matching a `function_item` (by name and
 * start line), or `undefined` for nested functions the declaration pass did
 * not register.
 */
function findSymbolForFn(
  node: TsNode,
  source: string,
  symbols: readonly SymbolRecord[],
): SymbolRecord | undefined {
  const name = fieldOf(node, 'name').text
  const line = spanOf(source, node.startIndex, node.startIndex).startLine
  return symbols.find(sym => sym.name === name
    && sym.startLine === line
    && (sym.kind === 'function' || sym.kind === 'method'))
}

/**
 * Resolve the bare callee of a `call_expression`'s `function` node:
 * identifiers and the trailing name of a path (`path::to::foo` → `foo`) are
 * direct, a `field_expression` keeps the receiver text and dispatches
 * dynamically, and `generic_function` (turbofish) recurses into its inner
 * function so the type-argument suffix drops. Anything else (a parenthesized
 * or computed callee) resolves to nothing.
 * @param funcNode - the `function` field of a `call_expression`.
 * @returns the resolved callee, or `null` for skipped shapes.
 */
function resolveCallee(funcNode: TsNode): ResolvedCallee | null {
  switch (funcNode.type) {
    case 'identifier':
      return { callee: funcNode.text, dispatch: 'direct', receiver: null }
    case 'scoped_identifier':
      // `path::to::foo` / `Type::method` — the callee is the final name.
      return { callee: fieldOf(funcNode, 'name').text, dispatch: 'direct', receiver: null }
    case 'field_expression':
      return {
        callee: fieldOf(funcNode, 'field').text,
        dispatch: 'dynamic',
        receiver: fieldOf(funcNode, 'value').text,
      }
    case 'generic_function':
      // Turbofish `foo::<T>()` / `obj.m::<T>()`: drop the type-argument
      // suffix by resolving the inner function.
      return resolveCallee(fieldOf(funcNode, 'function'))
    default:
      return null
  }
}

function extractCall(
  node: TsNode,
  source: string,
  filePath: string,
  caller: SymbolRecord,
  calls: CallEdgeRecord[],
): void {
  const funcNode = fieldOf(node, 'function')
  const resolved = resolveCallee(funcNode)
  if (resolved === null || RS_KEYWORDS.has(resolved.callee)) return
  // The edge positions come from the callee expression, not the whole call.
  const span = spanOf(source, funcNode.startIndex, funcNode.endIndex)
  calls.push({
    edgeId: edgeId('call', filePath, span.startLine, span.startCol),
    filePath,
    callerSymbol: caller.name,
    calleeSymbol: resolved.callee,
    line: span.startLine,
    startCol: span.startCol,
    endLine: span.startLine,
    endCol: span.endCol,
    callerSymbolUid: caller.symbolUid,
    dispatchKind: resolved.dispatch,
    // The reference's per-shape call kinds ("direct"/"dynamic") map onto this
    // package's member vocabulary: a dynamic dispatch is a member call.
    callKind: resolved.dispatch === 'dynamic' ? 'member' : 'direct',
    receiverExpr: resolved.receiver,
    argCount: fieldOf(node, 'arguments').namedChildren.length,
    isOptionalChain: false,
    isAwaited: false,
    isConstructor: false,
    parserTier: 'semantic',
    parserConfidence: RUST_CALL_CONFIDENCE,
  })
}

/**
 * Emit a `macro_invocation` edge (`println!`, `vec!`, `path::mac!`). The
 * frozen `callKind` vocabulary has no `macro` member, so a macro edge rides
 * the direct shape; the edge itself is additive coverage the reference's old
 * regex could never see. Rust keywords cannot name a macro, so no keyword
 * guard applies here (unlike plain calls).
 */
function extractMacroCall(
  node: TsNode,
  source: string,
  filePath: string,
  caller: SymbolRecord,
  calls: CallEdgeRecord[],
): void {
  const macroNode = fieldOf(node, 'macro')
  // The grammar's `macro` field is an identifier or a path; a path collapses
  // to its trailing name like plain calls do.
  const callee = macroNode.type === 'scoped_identifier'
    ? fieldOf(macroNode, 'name').text
    : macroNode.text
  const span = spanOf(source, macroNode.startIndex, macroNode.endIndex)
  calls.push({
    edgeId: edgeId('call', filePath, span.startLine, span.startCol),
    filePath,
    callerSymbol: caller.name,
    calleeSymbol: callee,
    line: span.startLine,
    startCol: span.startCol,
    endLine: span.startLine,
    endCol: span.endCol,
    callerSymbolUid: caller.symbolUid,
    dispatchKind: 'direct',
    callKind: 'direct',
    receiverExpr: null,
    argCount: null,
    isOptionalChain: false,
    isAwaited: false,
    isConstructor: false,
    parserTier: 'semantic',
    parserConfidence: RUST_CALL_CONFIDENCE,
  })
}
