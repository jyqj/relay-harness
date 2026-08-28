/**
 * C/C++ walker: function/struct/enum/typedef declarations (plus C++
 * classes, namespaces, and templates), `#include` imports, and whole-tree
 * call extraction with current-function tracking. Ported from the reference
 * implementation's `c_cpp.rs` at TreeSitter tier; inheritance semantic edges
 * and doc comments (fields this phase's record vocabulary trims) are out of
 * scope. The reference gates C++-only node kinds on an `is_cpp` flag because
 * one parser struct serves both languages; here the grammar selection already
 * decides the node vocabulary (the C grammar never produces `class_specifier`,
 * `namespace_definition`, `new_expression`, ...), so no per-node gate exists.
 * Grammar names follow the loader's `tree-sitter-<language>.wasm` convention
 * (`c`, `cpp`).
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
const C_KEYWORDS: ReadonlySet<string> = new Set([
  'auto', 'break', 'case', 'char', 'const', 'continue', 'default', 'do', 'double',
  'else', 'enum', 'extern', 'float', 'for', 'goto', 'if', 'inline', 'int', 'long',
  'register', 'restrict', 'return', 'short', 'signed', 'sizeof', 'static', 'struct',
  'switch', 'typedef', 'union', 'unsigned', 'void', 'volatile', 'while', '_Bool',
  '_Complex', '_Imaginary', 'class', 'namespace', 'template', 'typename', 'virtual',
  'override', 'final', 'public', 'private', 'protected', 'new', 'delete', 'this',
  'throw', 'try', 'catch', 'operator', 'friend', 'using', 'constexpr', 'nullptr',
  'true', 'false', 'bool', 'dynamic_cast', 'static_cast', 'reinterpret_cast',
  'const_cast', 'typeid', 'decltype', 'noexcept', 'alignof', 'offsetof', 'NULL',
])

/** Raw extraction output for one C or C++ file. */
export interface CCppExtraction {
  readonly symbols: SymbolRecord[]
  readonly imports: ImportRecord[]
  readonly callEdges: CallEdgeRecord[]
}

/**
 * Parse `text` with the C or C++ grammar and extract symbols, imports, and
 * call edges.
 *
 * @param filePath - workspace-relative file path (used for record ids).
 * @param text - full file text.
 * @param language - which grammar to parse with (`c` or `cpp`).
 * @returns the extracted records.
 * @throws when the grammar or the parse itself fails; the caller formats and
 * counts the failure.
 */
export async function extractCCpp(
  filePath: string,
  text: string,
  language: 'c' | 'cpp',
): Promise<CCppExtraction> {
  const grammar = await loadLanguage(language)
  const parser = new Parser()
  parser.setLanguage(grammar)
  const ctx = new ExtractCtx()
  try {
    const tree = parseWith(parser, text)
    try {
      walkSymbols(tree.rootNode, text, filePath, null, ctx)
      extractImports(tree.rootNode, filePath, ctx)
      walkCalls(tree.rootNode, text, filePath, ctx, null)
    } finally {
      tree.delete()
    }
  } finally {
    parser.delete()
  }
  return { symbols: ctx.symbols, imports: ctx.imports, callEdges: ctx.callEdges }
}

/** Name field text, or `null` for an anonymous specifier. */
function nameOf(node: TsNode): string | null {
  return node.childForFieldName('name')?.text ?? null
}

/** Assemble a symbol at `node`'s span; the signature participates in the uid when present. */
function makeSymbol(
  site: SymbolSite,
  name: string,
  kind: SymbolKind,
  qname: string,
  container: string | null,
  signature: string | null,
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
    // C/C++ methods are tracked through the container only (reference parity).
    receiverType: null,
    paramTypes: null,
    returnType: null,
    paramCount: null,
  }
}

/** Container-qualified name (`ns::name`), plain name at top level. */
function qualifyCpp(container: string | null, name: string): string {
  return container === null ? name : `${container}::${name}`
}

function walkSymbols(
  node: TsNode,
  source: string,
  filePath: string,
  container: string | null,
  ctx: ExtractCtx,
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = childAt(node, i)
    switch (child.type) {
      case 'function_definition':
        ctx.symbols.push(extractFunctionDefinition(child, source, filePath, container))
        break
      case 'struct_specifier':
      case 'class_specifier': {
        // Forward declarations carry no body and extract nothing.
        const body = child.childForFieldName('body')
        if (body === null) break
        const sym = extractStructOrClass(child, source, filePath, container)
        if (sym !== null) {
          ctx.symbols.push(sym)
          walkSymbols(body, source, filePath, sym.name, ctx)
        }
        break
      }
      case 'enum_specifier': {
        // Forward declarations carry no body and extract nothing; anonymous
        // enums only surface inside declarations, which skip.
        if (child.childForFieldName('body') === null) break
        ctx.symbols.push(extractEnum(child, source, filePath, container))
        break
      }
      case 'type_definition':
        ctx.symbols.push(extractTypedef(child, source, filePath, container))
        break
      case 'namespace_definition': {
        const sym = extractNamespace(child, source, filePath)
        ctx.symbols.push(sym)
        walkSymbols(fieldOf(child, 'body'), source, filePath, sym.name, ctx)
        break
      }
      // Templates unwrap: the inner declaration extracts with the same rules.
      case 'template_declaration':
        walkSymbols(child, source, filePath, container, ctx)
        break
      // Plain declarations (variable/forward declarations) are skipped.
      default:
        break
    }
  }
}

/** Extract a `function_definition`: kind follows the container, qname joins with `::`. */
function extractFunctionDefinition(
  node: TsNode,
  source: string,
  filePath: string,
  container: string | null,
): SymbolRecord {
  const [name, paramsNode] = declaratorIdentity(fieldOf(node, 'declarator'))
  const typeNode = node.childForFieldName('type')
  // Out-of-class definitions (`G::G(int) {}`) carry no return type.
  const returnType = typeNode?.text ?? null
  const [paramTypes, paramCount] = extractParamTypes(paramsNode)
  const signature = returnType === null ? `${name}${paramsNode.text}` : `${returnType} ${name}${paramsNode.text}`
  const sym = makeSymbol(
    { node, source, filePath },
    name,
    container === null ? 'function' : 'method',
    qualifyCpp(container, name),
    container,
    signature,
  )
  sym.paramTypes = paramTypes
  sym.returnType = returnType
  sym.paramCount = paramCount
  sym.endLine = positionOf(source, fieldOf(node, 'body').endIndex).line
  return sym
}

/**
 * Name and parameter list of a `function_definition`'s declarator. The
 * grammars always hand definitions an outermost `function_declarator` — even
 * for pointers-to-functions and qualified C++ names — so the name sits
 * directly under the declarator's own `declarator` field (the reference's
 * deeper wrapper unwrapping never fires for definitions).
 */
function declaratorIdentity(funcDecl: TsNode): [name: string, paramsNode: TsNode] {
  return [extractDeclaratorName(fieldOf(funcDecl, 'declarator')), fieldOf(funcDecl, 'parameters')]
}

/** Name text from a declarator, taking the last component of C++ qualified names. */
function extractDeclaratorName(node: TsNode): string {
  if (node.type === 'qualified_identifier') return extractDeclaratorName(fieldOf(node, 'name'))
  return node.text
}

/** Extract a `struct_specifier` / `class_specifier` with a body (`null` when anonymous). */
function extractStructOrClass(
  node: TsNode,
  source: string,
  filePath: string,
  container: string | null,
): SymbolRecord | null {
  const name = nameOf(node)
  if (name === null) return null
  const kindStr = node.type === 'class_specifier' ? 'class' : 'struct'
  const sym = makeSymbol({ node, source, filePath }, name, 'class', qualifyCpp(container, name), container, null)
  // Type symbols hash their uid without the signature (reference parity);
  // the record still carries the rendered declaration signature.
  sym.signature = `${kindStr} ${name}`
  return sym
}

/** Extract an `enum_specifier` with a body. */
function extractEnum(node: TsNode, source: string, filePath: string, container: string | null): SymbolRecord {
  const name = fieldOf(node, 'name').text
  const sym = makeSymbol({ node, source, filePath }, name, 'enum', qualifyCpp(container, name), container, null)
  sym.signature = `enum ${name}`
  return sym
}

/** Extract a `type_definition`; the declarator carries the new name. */
function extractTypedef(node: TsNode, source: string, filePath: string, container: string | null): SymbolRecord {
  const name = extractDeclaratorName(fieldOf(node, 'declarator'))
  const sym = makeSymbol(
    { node, source, filePath },
    name,
    'type_alias',
    qualifyCpp(container, name),
    container,
    `typedef ${fieldOf(node, 'type').text} ${name}`,
  )
  return sym
}

/** Extract a C++ `namespace_definition` (container-less, top-level qname). */
function extractNamespace(node: TsNode, source: string, filePath: string): SymbolRecord {
  const name = fieldOf(node, 'name').text
  return makeSymbol({ node, source, filePath }, name, 'namespace', name, null, `namespace ${name}`)
}

/** Parameter types from a `parameter_list`: joined types and parameter count. */
function extractParamTypes(paramsNode: TsNode): [types: string | null, count: number] {
  const types: string[] = []
  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = childAt(paramsNode, i)
    if (child.type === 'parameter_declaration') {
      types.push(fieldOf(child, 'type').text)
    } else if (child.type === 'variadic_parameter') {
      // C-style ellipsis. The C++ grammar's template pack parameters are
      // `variadic_parameter_declaration`s, which contribute nothing here
      // (reference parity).
      types.push('...')
    }
  }
  return types.length === 0 ? [null, 0] : [types.join(', '), types.length]
}

/**
 * `#include` directives at the root only (the shared `collect_root_imports`
 * semantics: no recursion). System includes (`<...>`) ride the
 * `isNamespace` flag — the one column this phase's `ImportRecord` offers for
 * the reference's system/local distinction.
 */
function extractImports(root: TsNode, filePath: string, ctx: ExtractCtx): void {
  for (let i = 0; i < root.childCount; i++) {
    const child = childAt(root, i)
    if (child.type !== 'preproc_include') continue
    // Angle-bracket delimiters on system includes; quotes go through the
    // shared quote stripper.
    const importPath = stripQuotes(fieldOf(child, 'path').text.replace(/^<+/, '').replace(/>+$/, ''))
    ctx.imports.push({
      filePath,
      importString: importPath,
      resolvedPath: null,
      importedName: lastSegment(importPath, '/'),
      alias: null,
      isNamespace: fieldOf(child, 'path').type === 'system_lib_string',
      isDefault: false,
      isReexport: false,
    })
  }
}

/** The trailing segment of `path` at `separator` (empty path yields `''`). */
function lastSegment(path: string, separator: string): string {
  return path.slice(path.lastIndexOf(separator) + 1)
}

/** Whole-tree call walk; `currentFn` tracks the enclosing function definition. */
function walkCalls(
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  currentFn: SymbolRecord | null,
): void {
  let activeFn = currentFn
  if (node.type === 'function_definition') {
    activeFn = findSymbolForNode(node, source, ctx.symbols)
  }
  if (node.type === 'call_expression') {
    extractSingleCall(node, source, filePath, ctx, activeFn)
  } else if (node.type === 'new_expression') {
    extractNewExpression(node, source, filePath, ctx, activeFn)
  }
  for (let i = 0; i < node.childCount; i++) {
    walkCalls(childAt(node, i), source, filePath, ctx, activeFn)
  }
}

/** Symbol matching a function definition node by name and start line. */
function findSymbolForNode(node: TsNode, source: string, symbols: readonly SymbolRecord[]): SymbolRecord | null {
  const [name] = declaratorIdentity(fieldOf(node, 'declarator'))
  const line = positionOf(source, node.startIndex).line
  // Every definition extracts a symbol first, so the lookup always matches.
  /* v8 ignore next: definition and symbol extraction walk the same nodes */
  return symbols.find(sym => sym.name === name && sym.startLine === line) ?? null
}

/** One `call_expression`: member/qualified/template/plain callee shapes. */
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
  if (funcNode.type === 'field_expression') {
    // obj.method() / obj->method() / obj.method<T>()
    callee = calleeNameFromField(fieldOf(funcNode, 'field'))
    dispatch = 'dynamic'
    receiverExpr = fieldOf(funcNode, 'argument').text
  } else if (funcNode.type === 'identifier') {
    callee = funcNode.text
    dispatch = 'direct'
    receiverExpr = null
  } else if (funcNode.type === 'qualified_identifier') {
    // Namespace::func() / Class::staticMethod()
    callee = calleeNameFromQualified(funcNode)
    dispatch = 'direct'
    receiverExpr = null
  } else if (funcNode.type === 'template_function') {
    // Bare generic call: foo<T>(). A qualified generic (`ns::f<T>()`) arrives
    // as a `qualified_identifier` wrapping the template instead, handled above.
    callee = fieldOf(funcNode, 'name').text
    dispatch = 'direct'
    receiverExpr = null
  } else {
    // Parenthesized or otherwise complex callee — skipped (reference parity).
    return
  }
  // Reserved words can never be callee names in a valid parse; the guard
  // mirrors the reference's keyword table.
  /* v8 ignore next: unreachable for grammar-valid callees */
  if (C_KEYWORDS.has(callee)) return

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
    argCount: fieldOf(node, 'arguments').namedChildren.length,
    isOptionalChain: false,
    isAwaited: false,
    isConstructor: false,
    parserTier: 'tree-sitter',
    parserConfidence: TREE_SITTER_CONFIDENCE,
  })
}

/** Bare callee name from a `field_expression` field, template suffix dropped. */
function calleeNameFromField(fieldNode: TsNode): string {
  // A generic member (`peek<int>`) carries its bare name in a `template_method`.
  if (fieldNode.type !== 'template_method') return fieldNode.text
  return fieldOf(fieldNode, 'name').text
}

/** Bare callee name from a `qualified_identifier`, taking the final component. */
function calleeNameFromQualified(node: TsNode): string {
  const nameNode = fieldOf(node, 'name')
  if (nameNode.type === 'identifier' || nameNode.type === 'field_identifier') return nameNode.text
  if (nameNode.type === 'qualified_identifier') return calleeNameFromQualified(nameNode)
  if (nameNode.type === 'template_function' || nameNode.type === 'template_method') {
    return fieldOf(nameNode, 'name').text
  }
  // A qualified type name (e.g. in `new ns::Holder<T>()`): final `::`
  // component with any template suffix stripped.
  const last = node.text.slice(node.text.lastIndexOf('::') + 2)
  return stripGenerics(last).trim()
}

/** Base type text with any generic argument suffix removed (`Foo<T>` → `Foo`). */
function stripGenerics(text: string): string {
  const lt = text.indexOf('<')
  return lt === -1 ? text : text.slice(0, lt)
}

/** C++ `new Foo(...)`: constructor call with qualifier/template suffixes stripped. */
function extractNewExpression(
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  caller: SymbolRecord | null,
): void {
  const typeNode = fieldOf(node, 'type')
  let typeName: string
  if (typeNode.type === 'qualified_identifier' || typeNode.type === 'template_type') {
    // `new ns::Holder<T>()` / `new Holder<T>()` — bare generic name.
    typeName = typeNode.type === 'qualified_identifier'
      ? calleeNameFromQualified(typeNode)
      : fieldOf(typeNode, 'name').text
  } else {
    typeName = stripGenerics(typeNode.text).trim()
  }
  if (typeName.length === 0 || C_KEYWORDS.has(typeName)) return

  // A paren-less `new Foo` has no arguments node; argCount stays null then.
  const argsNode = node.childForFieldName('arguments')
  const span = spanOf(source, node.startIndex, typeNode.endIndex)
  ctx.callEdges.push({
    edgeId: edgeId('call', filePath, span.startLine, span.startCol),
    filePath,
    callerSymbol: caller?.name ?? null,
    calleeSymbol: typeName,
    line: span.startLine,
    startCol: span.startCol,
    endLine: span.startLine,
    endCol: span.endCol,
    callerSymbolUid: caller?.symbolUid ?? null,
    dispatchKind: 'constructor',
    callKind: 'constructor',
    receiverExpr: null,
    argCount: argsNode === null ? null : argsNode.namedChildren.length,
    isOptionalChain: false,
    isAwaited: false,
    isConstructor: true,
    parserTier: 'tree-sitter',
    parserConfidence: TREE_SITTER_CONFIDENCE,
  })
}
