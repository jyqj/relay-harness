/**
 * Go walker: top-level function/method/type declarations, import
 * declarations, and call edges from function/method bodies only (the
 * reference's body-only emission discipline). Ported from the reference
 * implementation's `go.rs` at TreeSitter tier; route edges, embedded-field
 * semantic edges, type assignments, and doc comments (the reference carries
 * `doc`/resolution fields this phase's record vocabulary trims) are out of
 * scope. The grammar name follows the loader's `tree-sitter-<language>.wasm`
 * convention (`go`).
 * @module
 */

import { Parser } from 'web-tree-sitter'
import type { Node as TsNode } from 'web-tree-sitter'
import { positionOf, spanOf } from '../columns.ts'
import { edgeId, symbolUid } from '../id.ts'
import { loadLanguage, parseWith } from '../loader.ts'
import { childAt, fieldOf, stripQuotes } from '../shared/cursor.ts'
import { ExtractCtx } from '../shared/extract-ctx.ts'
import type { CallEdgeRecord, DispatchKind, ImportRecord, SymbolKind, SymbolRecord } from '../types.ts'

/** Node/source/file thread-through for symbol construction. */
interface SymbolSite {
  readonly node: TsNode
  readonly source: string
  readonly filePath: string
}

/** Confidence for TreeSitter-tier records (reference `element_confidence`). */
const TREE_SITTER_CONFIDENCE = 0.7

/** Reserved words and builtins that never surface as call callees. */
const GO_KEYWORDS: ReadonlySet<string> = new Set([
  'func', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan', 'go', 'select',
  'case', 'switch', 'if', 'else', 'for', 'range', 'return', 'break', 'continue', 'defer',
  'import', 'package', 'fallthrough', 'goto', 'default', 'make', 'new', 'len', 'cap',
  'append', 'copy', 'delete', 'close', 'panic', 'recover', 'print', 'println', 'nil',
  'true', 'false', 'iota', 'string', 'int', 'int8', 'int16', 'int32', 'int64', 'uint',
  'uint8', 'uint16', 'uint32', 'uint64', 'float32', 'float64', 'bool', 'byte', 'rune',
  'error',
])

/** Raw extraction output for one Go file. */
export interface GoExtraction {
  readonly symbols: SymbolRecord[]
  readonly imports: ImportRecord[]
  readonly callEdges: CallEdgeRecord[]
}

/**
 * Parse `text` with the Go grammar and extract symbols, imports, and call
 * edges.
 *
 * @param filePath - workspace-relative file path (used for record ids).
 * @param text - full file text.
 * @returns the extracted records.
 * @throws when the grammar or the parse itself fails; the caller formats and
 * counts the failure.
 */
export async function extractGo(filePath: string, text: string): Promise<GoExtraction> {
  const language = await loadLanguage('go')
  const parser = new Parser()
  parser.setLanguage(language)
  const ctx = new ExtractCtx()
  try {
    const tree = parseWith(parser, text)
    try {
      extractSymbols(tree.rootNode, text, filePath, ctx)
      extractImports(tree.rootNode, filePath, ctx)
      extractCalls(tree.rootNode, text, filePath, ctx)
    } finally {
      tree.delete()
    }
  } finally {
    parser.delete()
  }
  return { symbols: ctx.symbols, imports: ctx.imports, callEdges: ctx.callEdges }
}

/** Assemble a symbol at `node`'s span; callers fill param/return details. */
function makeSymbol(
  site: SymbolSite,
  name: string,
  kind: SymbolKind,
  qname: string,
  container: string | null,
  signature: string | null,
  receiverType: string | null,
): SymbolRecord {
  const { node, source, filePath } = site
  const span = spanOf(source, node.startIndex, node.endIndex)
  return {
    symbolId: edgeId('sym', filePath, span.startLine, span.startCol),
    filePath,
    name,
    kind,
    container,
    startLine: span.startLine,
    endLine: span.endLine,
    startCol: span.startCol,
    endCol: span.endCol,
    signature,
    parserTier: 'tree-sitter',
    parserConfidence: TREE_SITTER_CONFIDENCE,
    qname,
    parentSymbolId: null,
    exportName: null,
    isDefaultExport: false,
    symbolUid: symbolUid(filePath, qname, kind, signature ?? undefined),
    frameworkRole: null,
    receiverType,
    paramTypes: null,
    returnType: null,
    paramCount: null,
  }
}

/** End line override from the declaration body (reference `body.end_position`). */
function applyBodyEndLine(sym: SymbolRecord, node: TsNode, source: string): void {
  const body = node.childForFieldName('body')
  if (body !== null) sym.endLine = positionOf(source, body.endIndex).line
}

function extractSymbols(root: TsNode, source: string, filePath: string, ctx: ExtractCtx): void {
  for (let i = 0; i < root.childCount; i++) {
    const child = childAt(root, i)
    switch (child.type) {
      case 'function_declaration':
        ctx.symbols.push(extractFunction(child, source, filePath))
        break
      case 'method_declaration': {
        // A receiver the grammar cannot type (`func () M() {}` recovery) skips.
        const sym = extractMethod(child, source, filePath)
        if (sym !== null) ctx.symbols.push(sym)
        break
      }
      case 'type_declaration':
        extractTypeDeclaration(child, source, filePath, ctx)
        break
      default:
        break
    }
  }
}

/** Extract a `function_declaration`; top-level Go functions have no receiver. */
function extractFunction(node: TsNode, source: string, filePath: string): SymbolRecord {
  const name = fieldOf(node, 'name').text
  const paramsNode = fieldOf(node, 'parameters')
  const [paramTypes, paramCount] = extractParamTypes(paramsNode)
  const returnType = extractResultType(node)
  const signature = returnType === null
    ? `func ${name}${paramsNode.text}`
    : `func ${name}${paramsNode.text} ${returnType}`
  const sym = makeSymbol({ node, source, filePath }, name, 'function', name, null, signature, null)
  sym.paramTypes = paramTypes
  sym.returnType = returnType
  sym.paramCount = paramCount
  applyBodyEndLine(sym, node, source)
  return sym
}

/** Extract a `method_declaration`: qname `{Recv}.{name}`, container = receiver type. */
function extractMethod(node: TsNode, source: string, filePath: string): SymbolRecord | null {
  const name = fieldOf(node, 'name').text
  const receiverType = extractReceiverType(fieldOf(node, 'receiver'))
  if (receiverType === null) return null
  const paramsNode = fieldOf(node, 'parameters')
  const [paramTypes, paramCount] = extractParamTypes(paramsNode)
  const returnType = extractResultType(node)
  const signature = returnType === null
    ? `func (${receiverType}) ${name}${paramsNode.text}`
    : `func (${receiverType}) ${name}${paramsNode.text} ${returnType}`
  const sym = makeSymbol(
    { node, source, filePath },
    name,
    'method',
    `${receiverType}.${name}`,
    receiverType,
    signature,
    receiverType,
  )
  sym.paramTypes = paramTypes
  sym.returnType = returnType
  sym.paramCount = paramCount
  applyBodyEndLine(sym, node, source)
  return sym
}

/**
 * Receiver type name from a method receiver parameter list, handling both
 * `(r RecvType)` and `(r *RecvType)` (pointer prefix stripped). A receiver
 * the grammar recovered without a parameter declaration yields `null`.
 */
function extractReceiverType(receiverNode: TsNode): string | null {
  for (let i = 0; i < receiverNode.childCount; i++) {
    const child = childAt(receiverNode, i)
    if (child.type === 'parameter_declaration') {
      return fieldOf(child, 'type').text.replace(/^\*+/, '')
    }
  }
  return null
}

function extractTypeDeclaration(node: TsNode, source: string, filePath: string, ctx: ExtractCtx): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = childAt(node, i)
    if (child.type === 'type_spec') {
      ctx.symbols.push(extractTypeSpec(child, source, filePath))
    } else if (child.type === 'type_alias') {
      ctx.symbols.push(extractTypeAlias(child, source, filePath))
    }
  }
}

/** Extract a `type_spec` (`type Foo struct {...}`, `type Bar interface {...}`). */
function extractTypeSpec(node: TsNode, source: string, filePath: string): SymbolRecord {
  const name = fieldOf(node, 'name').text
  const typeNode = fieldOf(node, 'type')
  const kind: SymbolKind = typeNode.type === 'struct_type'
    ? 'class'
    : typeNode.type === 'interface_type'
      ? 'interface'
      : 'type_alias'
  const kindStr = kind === 'class' ? 'struct' : kind === 'interface' ? 'interface' : 'type'
  // Type symbols hash their uid without the signature (reference parity);
  // the record still carries the rendered `type` signature.
  const sym = makeSymbol({ node, source, filePath }, name, kind, name, null, null, null)
  sym.signature = `type ${name} ${kindStr}`
  return sym
}

/** Extract a `type_alias` (`type ID = string`). */
function extractTypeAlias(node: TsNode, source: string, filePath: string): SymbolRecord {
  const name = fieldOf(node, 'name').text
  const sym = makeSymbol({ node, source, filePath }, name, 'type_alias', name, null, null, null)
  sym.signature = `type ${name} = ${fieldOf(node, 'type').text}`
  return sym
}

/**
 * Import declarations at the root only (the shared `collect_root_imports`
 * semantics: no recursion). Grouped declarations descend into their spec list.
 */
function extractImports(root: TsNode, filePath: string, ctx: ExtractCtx): void {
  for (let i = 0; i < root.childCount; i++) {
    const child = childAt(root, i)
    if (child.type !== 'import_declaration') continue
    extractImportDeclaration(child, filePath, ctx)
  }
}

function extractImportDeclaration(node: TsNode, filePath: string, ctx: ExtractCtx): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = childAt(node, i)
    if (child.type === 'import_spec') {
      extractImportSpec(child, filePath, ctx)
    } else if (child.type === 'import_spec_list') {
      for (let j = 0; j < child.childCount; j++) {
        const spec = childAt(child, j)
        if (spec.type === 'import_spec') extractImportSpec(spec, filePath, ctx)
      }
    }
  }
}

/** One `import_spec`: imported name is the path's last `/` segment. */
function extractImportSpec(node: TsNode, filePath: string, ctx: ExtractCtx): void {
  const importPath = stripQuotes(fieldOf(node, 'path').text)
  ctx.imports.push({
    filePath,
    importString: importPath,
    resolvedPath: null,
    importedName: lastSegment(importPath, '/'),
    alias: node.childForFieldName('name')?.text ?? null,
    isNamespace: false,
    isDefault: false,
    isReexport: false,
  })
}

/** The trailing segment of `path` at `separator` (empty path yields `''`). */
function lastSegment(path: string, separator: string): string {
  return path.slice(path.lastIndexOf(separator) + 1)
}

/** Parameter types from a `parameter_list`: joined types and parameter count. */
function extractParamTypes(paramsNode: TsNode): [types: string | null, count: number] {
  const types: string[] = []
  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = childAt(paramsNode, i)
    if (child.type === 'parameter_declaration') {
      // One type may name several parameters (`a, b int` = 2).
      let nameCount = 0
      for (let j = 0; j < child.childCount; j++) {
        if (childAt(child, j).type === 'identifier') nameCount++
      }
      const typeText = fieldOf(child, 'type').text
      for (let n = 0; n < (nameCount === 0 ? 1 : nameCount); n++) types.push(typeText)
    } else if (child.type === 'variadic_parameter_declaration') {
      types.push(`...${fieldOf(child, 'type').text}`)
    }
  }
  return types.length === 0 ? [null, 0] : [types.join(', '), types.length]
}

/** Result (return) type text, `null` when the declaration carries no result. */
function extractResultType(node: TsNode): string | null {
  const resultNode = node.childForFieldName('result')
  return resultNode === null ? null : resultNode.text.trim()
}

/**
 * Calls inside function/method bodies only: each declaration's body is walked
 * for `call_expression` nodes (the reference emits nothing from other
 * contexts).
 */
function extractCalls(root: TsNode, source: string, filePath: string, ctx: ExtractCtx): void {
  for (let i = 0; i < root.childCount; i++) {
    const child = childAt(root, i)
    if (child.type !== 'function_declaration' && child.type !== 'method_declaration') continue
    const caller = findSymbolForDecl(child, source, ctx.symbols)
    const body = child.childForFieldName('body')
    if (body !== null) walkCalls(body, source, filePath, ctx, caller)
  }
}

/** Symbol matching a declaration node by name and start line. */
function findSymbolForDecl(node: TsNode, source: string, symbols: readonly SymbolRecord[]): SymbolRecord | null {
  const line = positionOf(source, node.startIndex).line
  const name = fieldOf(node, 'name').text
  return symbols.find(sym => sym.name === name && sym.startLine === line) ?? null
}

function walkCalls(node: TsNode, source: string, filePath: string, ctx: ExtractCtx, caller: SymbolRecord | null): void {
  if (node.type === 'call_expression') extractSingleCall(node, source, filePath, ctx, caller)
  for (let i = 0; i < node.childCount; i++) {
    walkCalls(childAt(node, i), source, filePath, ctx, caller)
  }
}

/** One `call_expression`: selector calls dispatch dynamically, plain calls directly. */
function extractSingleCall(
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  caller: SymbolRecord | null,
): void {
  const funcNode = fieldOf(node, 'function')
  let callee: string
  let dispatch: DispatchKind
  let receiverExpr: string | null
  if (funcNode.type === 'selector_expression') {
    // obj.Method(...) — the callee is the selector's field, not its text.
    callee = fieldOf(funcNode, 'field').text
    dispatch = 'dynamic'
    receiverExpr = fieldOf(funcNode, 'operand').text
  } else if (funcNode.type === 'identifier') {
    callee = funcNode.text
    dispatch = 'direct'
    receiverExpr = null
  } else {
    // Parenthesized or otherwise complex callee — skipped (reference parity).
    return
  }
  if (GO_KEYWORDS.has(callee)) return

  const argsNode = fieldOf(node, 'arguments')
  const span = spanOf(source, funcNode.startIndex, funcNode.endIndex)
  ctx.callEdges.push({
    edgeId: edgeId('call', filePath, span.startLine, span.startCol),
    filePath,
    callerSymbol: caller?.name ?? null,
    calleeSymbol: callee,
    line: span.startLine,
    startCol: span.startCol,
    endLine: span.startLine,
    endCol: span.endCol,
    callerSymbolUid: caller?.symbolUid ?? null,
    dispatchKind: dispatch,
    callKind: dispatch === 'direct' ? 'direct' : 'member',
    receiverExpr,
    argCount: argsNode.namedChildren.length,
    isOptionalChain: false,
    isAwaited: false,
    isConstructor: false,
    parserTier: 'tree-sitter',
    parserConfidence: TREE_SITTER_CONFIDENCE,
  })
}
