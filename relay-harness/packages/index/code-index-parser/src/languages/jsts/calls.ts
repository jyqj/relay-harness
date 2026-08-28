/**
 * Call-edge extraction for JS/TS — member and identifier call expressions
 * and constructor calls. Ported from the reference implementation's
 * `jsts/calls.rs`; route, HTTP-client, broker, and EventEmitter dispatch
 * extraction is out of scope for this phase (their constant tables are
 * retained in `constants.ts`).
 * @module
 */

import type { Node as TsNode } from 'web-tree-sitter'
import { spanOf } from '../../columns.ts'
import { edgeId } from '../../id.ts'
import { childAt, countArgs, fieldOf } from '../../shared/cursor.ts'
import type { ExtractCtx } from '../../shared/extract-ctx.ts'
import { JS_KEYWORDS } from '../../shared/identifiers.ts'
import type { CallEdgeRecord, DispatchKind } from '../../types.ts'

/** AST call edges are more precise than the regex fallback: 0.85. */
export const AST_CALL_CONFIDENCE = 0.85

/**
 * Visit a `call_expression`: dispatch on the callee shape (member,
 * identifier, or nested call) and record the call edge.
 * @param node - `call_expression` node.
 * @param source - full source text.
 * @param filePath - workspace-relative file path.
 * @param ctx - extraction accumulator.
 * @param container - enclosing declaration name, or `null`.
 * @param isAwaited - whether the call sits directly under `await`.
 * @returns nothing; edges land on `ctx`.
 */
export function visitCallExpression(
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  container: string | null,
  isAwaited: boolean,
): void {
  // A call expression always carries its callee as the first child.
  const funcNode = childAt(node, 0)
  // Optional dispatch: an `optional_chain_expression` callee, or a member
  // callee carrying an `optional_chain` (`?.`) child.
  const isOptional = funcNode.type.includes('optional') || hasOptionalChild(funcNode)

  if (funcNode.type === 'member_expression') {
    emitMemberCall(node, funcNode, source, filePath, ctx, container, isAwaited, isOptional)
    return
  }
  if (funcNode.type === 'identifier') {
    emitIdentifierCall(node, funcNode, source, filePath, ctx, container, isAwaited)
    return
  }
  // Nested call: foo()()
  if (funcNode.type === 'call_expression') {
    visitCallExpression(funcNode, source, filePath, ctx, container, isAwaited)
  }
}

/** True when any direct child marks optional chaining (`?.`). */
function hasOptionalChild(node: TsNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (childAt(node, i).type.includes('optional')) return true
  }
  return false
}

/** `obj.method(args)` — callee is `{obj}.{prop}`, dispatch is dynamic (or optional-chain). */
function emitMemberCall(
  node: TsNode,
  funcNode: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  container: string | null,
  isAwaited: boolean,
  isOptional: boolean,
): void {
  const objNode = fieldOf(funcNode, 'object')
  const propNode = fieldOf(funcNode, 'property')
  // Route registration (`app.get`), broker methods, HTTP client calls, and
  // EventEmitter sites are detected from this (obj, prop) pair in the route
  // phase; this phase only records the call edge itself.

  const callee = `${objNode.text}.${propNode.text}`
  const span = spanOf(source, node.startIndex, node.endIndex)
  const dispatch: DispatchKind = isOptional ? 'optional_chain' : 'dynamic'
  const edge: CallEdgeRecord = {
    edgeId: edgeId('call', filePath, span.startLine, span.startCol),
    filePath,
    callerSymbol: container,
    calleeSymbol: callee,
    line: span.startLine,
    startCol: span.startCol,
    endLine: span.endLine,
    endCol: span.endCol,
    callerSymbolUid: ctx.currentSymbolUid,
    dispatchKind: dispatch,
    callKind: 'member',
    receiverExpr: objNode.text,
    argCount: countArgs(node),
    isOptionalChain: isOptional,
    isAwaited,
    isConstructor: false,
    parserTier: 'semantic',
    parserConfidence: AST_CALL_CONFIDENCE,
  }
  ctx.callEdges.push(edge)
}

/** `identifier(args)` — plain direct call; reserved words never emit. */
function emitIdentifierCall(
  node: TsNode,
  funcNode: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  container: string | null,
  isAwaited: boolean,
): void {
  const callee = funcNode.text
  // Reserved words can never be identifier callees in a valid AST, so no
  // keyword filter is needed here (unlike the regex fallback below).
  const span = spanOf(source, node.startIndex, node.endIndex)
  ctx.callEdges.push({
    edgeId: edgeId('call', filePath, span.startLine, span.startCol),
    filePath,
    callerSymbol: container,
    calleeSymbol: callee,
    line: span.startLine,
    startCol: span.startCol,
    endLine: span.endLine,
    endCol: span.endCol,
    callerSymbolUid: ctx.currentSymbolUid,
    dispatchKind: 'direct',
    callKind: 'direct',
    receiverExpr: null,
    argCount: countArgs(node),
    isOptionalChain: false,
    isAwaited,
    isConstructor: false,
    parserTier: 'semantic',
    parserConfidence: AST_CALL_CONFIDENCE,
  })
}

/**
 * `new Foo(args)` — constructor call edge.
 * @param node - `new_expression` node.
 * @param source - full source text.
 * @param filePath - workspace-relative file path.
 * @param ctx - extraction accumulator.
 * @param container - enclosing declaration name, or `null`.
 * @returns nothing; edges land on `ctx`.
 */
export function visitNewExpression(
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  container: string | null,
): void {
  // children: "new" <constructor> <arguments> — the constructor is the
  // second child of every new_expression these grammars produce.
  const constructorNode = childAt(node, 1)
  const name = constructorNode.text
  if (JS_KEYWORDS.has(name)) return
  const span = spanOf(source, node.startIndex, node.endIndex)
  ctx.callEdges.push({
    edgeId: edgeId('call', filePath, span.startLine, span.startCol),
    filePath,
    callerSymbol: container,
    calleeSymbol: name,
    line: span.startLine,
    startCol: span.startCol,
    endLine: span.endLine,
    endCol: span.endCol,
    callerSymbolUid: ctx.currentSymbolUid,
    dispatchKind: 'constructor',
    callKind: 'constructor',
    receiverExpr: null,
    argCount: countArgs(node),
    isOptionalChain: false,
    isAwaited: false,
    isConstructor: true,
    parserTier: 'semantic',
    parserConfidence: AST_CALL_CONFIDENCE,
  })
}
