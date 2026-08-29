/**
 * Java walker: recursive class/interface/enum/method/constructor extraction,
 * root-level import declarations, and whole-tree call extraction (calls carry
 * the innermost enclosing method by line). Ported from the reference
 * implementation's `java.rs` at TreeSitter tier; extends/implements/throws/
 * annotation semantic edges, type assignments, and doc comments (fields this
 * phase's record vocabulary trims) are out of scope. The grammar name follows
 * the loader's `tree-sitter-<language>.wasm` convention (`java`).
 * @module
 */

import { Parser } from 'web-tree-sitter'
import type { Node as TsNode } from 'web-tree-sitter'
import { positionOf, spanOf } from '../columns.ts'
import { edgeId, symbolUid } from '../id.ts'
import { loadLanguage, parseWith } from '../loader.ts'
import { childAt, fieldOf } from '../shared/cursor.ts'
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

/** Reserved words and common runtime names that never surface as callees. */
const JAVA_KEYWORDS: ReadonlySet<string> = new Set([
  'abstract', 'assert', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class',
  'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final',
  'finally', 'float', 'for', 'goto', 'if', 'implements', 'import', 'instanceof', 'int',
  'interface', 'long', 'native', 'new', 'package', 'private', 'protected', 'public',
  'return', 'short', 'static', 'strictfp', 'super', 'switch', 'synchronized', 'this',
  'throw', 'throws', 'transient', 'try', 'void', 'volatile', 'while', 'true', 'false',
  'null', 'var', 'yield', 'record', 'sealed', 'permits', 'String', 'Object', 'System',
  'Override',
])

/** Modifier keywords that prefix a class-like signature. */
const MODIFIER_KINDS: ReadonlySet<string> = new Set([
  'public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized',
  'native', 'strictfp', 'default',
])

/** Raw extraction output for one Java file. */
export interface JavaExtraction {
  readonly symbols: SymbolRecord[]
  readonly imports: ImportRecord[]
  readonly callEdges: CallEdgeRecord[]
}

/**
 * Parse `text` with the Java grammar and extract symbols, imports, and call
 * edges.
 *
 * @param filePath - workspace-relative file path (used for record ids).
 * @param text - full file text.
 * @returns the extracted records.
 * @throws when the grammar or the parse itself fails; the caller formats and
 * counts the failure.
 */
export async function extractJava(filePath: string, text: string): Promise<JavaExtraction> {
  const language = await loadLanguage('java')
  const parser = new Parser()
  parser.setLanguage(language)
  const ctx = new ExtractCtx()
  try {
    const tree = parseWith(parser, text)
    try {
      walkForSymbols(tree.rootNode, text, filePath, null, ctx)
      extractImports(tree.rootNode, filePath, ctx)
      walkForCalls(tree.rootNode, text, filePath, ctx)
    } finally {
      tree.delete()
    }
  } finally {
    parser.delete()
  }
  return { symbols: ctx.symbols, imports: ctx.imports, callEdges: ctx.callEdges }
}

/** Assemble a symbol at `node`'s span; every Java symbol carries a signature. */
function makeSymbol(
  site: SymbolSite,
  name: string,
  kind: SymbolKind,
  qname: string,
  container: string | null,
  signature: string,
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
    symbolUid: symbolUid(filePath, qname, kind, signature),
    frameworkRole: null,
    receiverType,
    paramTypes: null,
    returnType: null,
    paramCount: null,
  }
}

/** End line override from the declaration body (`abstract` members have none). */
function applyBodyEndLine(sym: SymbolRecord, node: TsNode, source: string): void {
  const body = node.childForFieldName('body')
  if (body !== null) sym.endLine = positionOf(source, body.endIndex).line
}

function walkForSymbols(
  node: TsNode,
  source: string,
  filePath: string,
  container: string | null,
  ctx: ExtractCtx,
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = childAt(node, i)
    switch (child.type) {
      case 'class_declaration':
      case 'interface_declaration':
      case 'enum_declaration': {
        const kind: SymbolKind = child.type === 'class_declaration'
          ? 'class'
          : child.type === 'interface_declaration'
            ? 'interface'
            : 'enum'
        const sym = extractClassLike(child, source, filePath, kind)
        ctx.symbols.push(sym)
        walkForSymbols(fieldOf(child, 'body'), source, filePath, sym.name, ctx)
        break
      }
      case 'method_declaration': {
        const sym = extractMethod(child, source, filePath, container)
        ctx.symbols.push(sym)
        applyBodyEndLine(sym, child, source)
        break
      }
      case 'constructor_declaration': {
        const sym = extractConstructor(child, source, filePath, container)
        ctx.symbols.push(sym)
        applyBodyEndLine(sym, child, source)
        break
      }
      // Enum constants live directly in the body; declarations sit under
      // `enum_body_declarations` once a constant list is present.
      case 'enum_body_declarations':
        walkForSymbols(child, source, filePath, container, ctx)
        break
      default:
        break
    }
  }
}

/** Class-like declaration: container-less, qname is the bare name, signature carries modifiers. */
function extractClassLike(
  node: TsNode,
  source: string,
  filePath: string,
  kind: SymbolKind,
): SymbolRecord {
  const name = fieldOf(node, 'name').text
  const kindStr = kind === 'class' ? 'class' : kind === 'interface' ? 'interface' : 'enum'
  const modifiers = collectModifiers(node)
  const signature = modifiers.length === 0
    ? `${kindStr} ${name}`
    : `${modifiers.join(' ')} ${kindStr} ${name}`
  return makeSymbol({ node, source, filePath }, name, kind, name, null, signature, null)
}

/** Extract a `method_declaration`: qname `{Class}.{name}`, receiver = container. */
function extractMethod(
  node: TsNode,
  source: string,
  filePath: string,
  container: string | null,
): SymbolRecord {
  const name = fieldOf(node, 'name').text
  const typeNode = fieldOf(node, 'type')
  const retText = typeNode.text
  // The reference drops `void` from the record's return type.
  const returnType = retText === 'void' ? null : retText
  const paramsNode = fieldOf(node, 'parameters')
  const [paramTypes, paramCount] = extractParamTypes(paramsNode)
  let qname = `${container}.${name}`
  let kind: SymbolKind = 'method'
  /* v8 ignore next 3: the grammar only nests methods inside class bodies, so
     the container-less mapping never fires (kept for reference parity). */
  if (container === null) {
    qname = name
    kind = 'function'
  }
  const sym = makeSymbol(
    { node, source, filePath },
    name,
    kind,
    qname,
    container,
    `${retText} ${name}${paramsNode.text}`,
    container,
  )
  sym.paramTypes = paramTypes
  sym.returnType = returnType
  sym.paramCount = paramCount
  return sym
}

/** Extract a `constructor_declaration` (kind `method`, no return type). */function extractConstructor(
  node: TsNode,
  source: string,
  filePath: string,
  container: string | null,
): SymbolRecord {
  const name = fieldOf(node, 'name').text
  const paramsNode = fieldOf(node, 'parameters')
  const [paramTypes, paramCount] = extractParamTypes(paramsNode)
  let qname = `${container}.${name}`
  /* v8 ignore next 3: constructors only appear inside class bodies, so the
     container-less mapping never fires (kept for reference parity). */
  if (container === null) {
    qname = name
  }
  const sym = makeSymbol(
    { node, source, filePath },
    name,
    'method',
    qname,
    container,
    `${name}${paramsNode.text}`,
    container,
  )
  sym.paramTypes = paramTypes
  sym.paramCount = paramCount
  return sym
}

/** Modifier keyword texts from the declaration's `modifiers` children. */
function collectModifiers(node: TsNode): string[] {
  const modifiers: string[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = childAt(node, i)
    if (child.type !== 'modifiers') continue
    for (let j = 0; j < child.childCount; j++) {
      const modifier = childAt(child, j)
      if (MODIFIER_KINDS.has(modifier.type)) modifiers.push(modifier.text)
    }
  }
  return modifiers
}

/** Parameter types from `formal_parameters`: joined types and parameter count. */
function extractParamTypes(paramsNode: TsNode): [types: string | null, count: number] {
  const types: string[] = []
  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = childAt(paramsNode, i)
    if (child.type !== 'formal_parameter' && child.type !== 'spread_parameter') continue
    // A spread parameter carries no `type` field, so the reference (and this
    // walker) contributes nothing for it.
    const typeNode = child.childForFieldName('type')
    if (typeNode === null) continue
    types.push(typeNode.text)
  }
  return types.length === 0 ? [null, 0] : [types.join(', '), types.length]
}

/**
 * Import declarations at the root only (the shared `collect_root_imports`
 * semantics: no recursion); `import static` keeps its prefix in the specifier.
 */
function extractImports(root: TsNode, filePath: string, ctx: ExtractCtx): void {
  for (let i = 0; i < root.childCount; i++) {
    const child = childAt(root, i)
    if (child.type !== 'import_declaration') continue
    const isStatic = child.text.includes('static ')
    const importPath = findImportPath(child)
    // Error recovery always leaves at least a zero-width identifier under the
    // declaration, so the lookup never comes up empty in practice.
    /* v8 ignore next: recovery shapes keep a path node (see findImportPath). */
    if (importPath === null) continue
    ctx.imports.push({
      filePath,
      importString: isStatic ? `static ${importPath}` : importPath,
      resolvedPath: null,
      importedName: lastSegment(importPath, '.'),
      alias: null,
      isNamespace: false,
      isDefault: false,
      isReexport: false,
    })
  }
}

/** The trailing segment of `path` at `separator` (empty path yields `''`). */
function lastSegment(path: string, separator: string): string {
  return path.slice(path.lastIndexOf(separator) + 1)
}

/**
 * The import path: the declaration's direct `scoped_identifier`/`identifier`
 * child. Wildcard asterisks are siblings of the qualified path, not parents.
 */
function findImportPath(node: TsNode): string | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = childAt(node, i)
    if (child.type === 'scoped_identifier' || child.type === 'identifier') return child.text
  }
  /* v8 ignore next: recovery shapes keep a path node (see caller) */
  return null
}

/** Whole-tree call walk: invocations and constructor calls, anywhere. */
function walkForCalls(node: TsNode, source: string, filePath: string, ctx: ExtractCtx): void {
  if (node.type === 'method_invocation') {
    extractMethodInvocation(node, source, filePath, ctx)
  } else if (node.type === 'object_creation_expression') {
    extractObjectCreation(node, source, filePath, ctx)
  }
  for (let i = 0; i < node.childCount; i++) {
    walkForCalls(childAt(node, i), source, filePath, ctx)
  }
}

/** One `method_invocation`; positions come from the callee name node. */
function extractMethodInvocation(
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
): void {
  const nameNode = fieldOf(node, 'name')
  const callee = nameNode.text
  // Reserved words can never be invocation names in a valid parse; the guard
  // mirrors the reference's keyword table.
  /* v8 ignore next: unreachable for grammar-valid invocations */
  if (JAVA_KEYWORDS.has(callee)) return
  const receiverExpr = node.childForFieldName('object')?.text ?? null
  const dispatch: DispatchKind = receiverExpr === null ? 'direct' : 'dynamic'
  const span = spanOf(source, nameNode.startIndex, nameNode.endIndex)
  const caller = findEnclosingMethod(ctx.symbols, span.startLine)
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

/** `new Foo(...)`: constructor call with the generic suffix stripped. */
function extractObjectCreation(
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
): void {
  const typeNode = fieldOf(node, 'type')
  const typeName = stripGenerics(typeNode.text)
  // Primitives have no constructors, so a keyword type never reaches here;
  // the guard mirrors the reference's keyword table.
  /* v8 ignore next: unreachable for grammar-valid creations */
  if (JAVA_KEYWORDS.has(typeName)) return
  const span = spanOf(source, node.startIndex, typeNode.endIndex)
  const caller = findEnclosingMethod(ctx.symbols, span.startLine)
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
    argCount: fieldOf(node, 'arguments').namedChildren.length,
    isOptionalChain: false,
    isAwaited: false,
    isConstructor: true,
    parserTier: 'tree-sitter',
    parserConfidence: TREE_SITTER_CONFIDENCE,
  })
}

/** Base type text with any generic argument suffix removed (`ArrayList<String>` → `ArrayList`). */
function stripGenerics(text: string): string {
  const lt = text.indexOf('<')
  return lt === -1 ? text : text.slice(0, lt)
}

/** The function/method whose span contains `line`, or `null` outside all of them. */
function findEnclosingMethod(symbols: readonly SymbolRecord[], line: number): SymbolRecord | null {
  for (const sym of symbols) {
    if (sym.kind !== 'function' && sym.kind !== 'method') continue
    if (sym.startLine <= line && sym.endLine >= line) return sym
  }
  return null
}
