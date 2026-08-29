/**
 * Symbol extraction for JS/TS — functions, classes, methods, variable
 * declarations (including CommonJS `require()` imports), and TS param/return
 * type info. Ported from the reference implementation's `jsts/symbols.rs`;
 * React state-setter dispatch sites are out of scope for this phase.
 * @module
 */

import type { Node as TsNode } from 'web-tree-sitter'
import { spanOf } from '../../columns.ts'
import { edgeId, symbolUid } from '../../id.ts'
import { qualify } from '../../shared/identifiers.ts'
import type { ExtractCtx } from '../../shared/extract-ctx.ts'
import { childAt, childByKind, fieldOf, nthArgNode, stripQuotes } from '../../shared/cursor.ts'
import type { ImportRecord, SymbolKind, SymbolRecord } from '../../types.ts'
import { classifyFrameworkRole } from './roles.ts'

/** Parsed-source thread-through for node position and text resolution. */
export interface SymbolSite {
  readonly node: TsNode
  readonly source: string
  readonly filePath: string
}

/**
 * Build a `SymbolRecord` at `node`'s span. The positional `symbolId` and the
 * semantic `symbolUid` follow the reference implementation (`edge_id("sym")`
 * and `symbol_uid()`); export/default/framework fields are filled by callers
 * or deferred export application.
 * @param site - node, source text, and file path.
 * @param name - declared short name.
 * @param kind - symbol kind.
 * @param qname - qualified name.
 * @param container - enclosing declaration name, or `null`.
 * @param signature - rendered signature for the uid, or `null`.
 * @returns the symbol record at the node's span.
 */
export function makeSymbol(
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
    parserTier: 'semantic',
    parserConfidence: 0.85,
    qname,
    parentSymbolId: null,
    exportName: null,
    isDefaultExport: false,
    symbolUid: symbolUid(filePath, qname, kind, signature ?? undefined),
    frameworkRole: null,
    receiverType: container,
    paramTypes: null,
    returnType: null,
    paramCount: null,
  }
}

/**
 * Extract a `function_declaration` / `generator_function_declaration` (or a
 * nested plain `function`): functions at top level, methods inside a
 * container, matching the reference behavior.
 * @param node - declaration node.
 * @param source - full source text.
 * @param filePath - workspace-relative file path.
 * @param container - enclosing declaration name, or `null`.
 * @returns the symbol record.
 */
export function extractFunction(
  node: TsNode,
  source: string,
  filePath: string,
  container: string | null,
): SymbolRecord {
  // The grammar guarantees a name and parameter list on declarations.
  const name = fieldOf(node, 'name').text
  const paramsNode = fieldOf(node, 'parameters')
  const params = paramsNode.text
  const [paramTypes, paramCount] = extractTsParamInfo(paramsNode)
  const sym = makeSymbol(
    { node, source, filePath },
    name,
    container === null ? 'function' : 'method',
    qualify(container, name),
    container,
    `function ${name}${params}`,
  )
  sym.paramTypes = paramTypes
  sym.returnType = returnTypeOf(node)
  sym.paramCount = paramCount
  return sym
}

/**
 * Extract a `class_declaration`.
 * @param node - declaration node.
 * @param source - full source text.
 * @param filePath - workspace-relative file path.
 * @returns the symbol record.
 */
export function extractClass(node: TsNode, source: string, filePath: string): SymbolRecord {
  const name = fieldOf(node, 'name').text
  return makeSymbol(
    { node, source, filePath },
    name,
    'class',
    name,
    null,
    `class ${name}`,
  )
}

/**
 * Extract a `method_definition`.
 * @param node - definition node.
 * @param source - full source text.
 * @param filePath - workspace-relative file path.
 * @param container - enclosing class name, or `null`.
 * @returns the symbol record.
 */
export function extractMethod(
  node: TsNode,
  source: string,
  filePath: string,
  container: string | null,
): SymbolRecord {
  const name = fieldOf(node, 'name').text
  const [paramTypes, paramCount] = extractTsParamInfo(fieldOf(node, 'parameters'))
  const sym = makeSymbol(
    { node, source, filePath },
    name,
    'method',
    qualify(container, name),
    container,
    null,
  )
  sym.paramTypes = paramTypes
  sym.returnType = returnTypeOf(node)
  sym.paramCount = paramCount
  return sym
}

/** Return-type annotation text (`: Foo` → `Foo`), `null` when absent or empty. */
function returnTypeOf(node: TsNode): string | null {
  const field = node.childForFieldName('return_type')
  if (field === null) return null
  // The annotation always carries a type expression; strip its leading colon.
  return field.text.trim().replace(/^:/, '').trim()
}

/**
 * TypeScript parameter info from a parameters node: the declared parameter
 * count and comma-joined annotated types. Plain JS parameters yield a count
 * with no types.
 * @param paramsNode - `formal_parameters` node.
 * @returns the joined annotated types (or `null`) and the parameter count.
 */
export function extractTsParamInfo(
  paramsNode: TsNode,
): [types: string | null, count: number] {
  const types: string[] = []
  let count = 0
  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = childAt(paramsNode, i)
    switch (child.type) {
      case 'required_parameter':
      case 'optional_parameter':
      case 'rest_parameter': {
        count++
        const typeField = child.childForFieldName('type')
        if (typeField !== null) {
          types.push(typeField.text.trim().replace(/^:/, '').trim())
        }
        break
      }
      case 'identifier':
      case 'assignment_pattern':
      case 'object_pattern':
      case 'array_pattern':
        count++
        break
      default:
        break
    }
  }
  return [types.length === 0 ? null : types.join(', '), count]
}

/**
 * Extract `variable_declarator` children of a `lexical_declaration` /
 * `variable_declaration`: CommonJS `require()` imports, arrow/function
 * values as functions, everything else as variables. `visitValue` walks each
 * declarator's RHS for call extraction — top-level declarations are only
 * reached through this callback, never through the call-extraction walk.
 * @param node - `lexical_declaration` / `variable_declaration` node.
 * @param source - full source text.
 * @param filePath - workspace-relative file path.
 * @param ctx - extraction accumulator.
 * @param container - enclosing declaration name, or `null`.
 * @param inExport - whether the declaration sits under an `export_statement`.
 * @param isDefaultExport - whether that export is `default`.
 * @param visitValue - callback walking a declarator's RHS for calls.
 * @returns nothing; records land on `ctx`.
 */
export function extractVariableDeclarations(
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  container: string | null,
  inExport: boolean,
  isDefaultExport: boolean,
  visitValue: (value: TsNode) => void,
): void {
  for (let i = 0; i < node.childCount; i++) {
    const child = childAt(node, i)
    if (child.type !== 'variable_declarator') continue
    extractRequireImports(child, filePath, ctx)
    // Declarators always carry their name field, even error-recovered ones.
    const nameNode = fieldOf(child, 'name')
    const valueNode = child.childForFieldName('value')
    // Destructured declarations produce no per-binding symbol, but their RHS
    // is still visited for calls (reference behavior).
    if (nameNode.type === 'array_pattern') {
      if (valueNode !== null) visitValue(valueNode)
      continue
    }
    const name = nameNode.text
    const kind: SymbolKind = valueNode?.type === 'arrow_function'
      || valueNode?.type === 'function'
      || valueNode?.type === 'function_expression'
      ? 'function'
      : 'variable'
    const sym = makeSymbol(
      { node, source, filePath },
      name,
      kind,
      qualify(container, name),
      container,
      null,
    )
    sym.frameworkRole = classifyFrameworkRole(name, kind, container)
    if (inExport) {
      sym.exportName = name
      sym.isDefaultExport = isDefaultExport
    }
    ctx.symbols.push(sym)
    // Visit the RHS for calls.
    if (valueNode !== null) visitValue(valueNode)
  }
}

/**
 * CommonJS `require()` import extraction from one declarator:
 * `const X = require('mod')` (namespace/default) and
 * `const { A, B } = require('./mod')` (per-binding, with alias support).
 */
function extractRequireImports(
  declarator: TsNode,
  filePath: string,
  ctx: ExtractCtx,
): void {
  const valueNode = declarator.childForFieldName('value')
  if (valueNode?.type !== 'call_expression') return
  if (childAt(valueNode, 0).text !== 'require') return
  const firstArg = nthArgNode(valueNode, 0)
  if (firstArg === null || firstArg.type !== 'string') return
  const src = stripQuotes(firstArg.text)
  // Valueless declarators cannot reach here; named declarators always
  // carry the name node.
  const nameNode = fieldOf(declarator, 'name')

  if (nameNode.type === 'object_pattern') {
    for (const prop of nameNode.namedChildren) {
      // Object-pattern bindings always use the ..._pattern identifier type.
      if (prop.type === 'shorthand_property_identifier_pattern') {
        ctx.imports.push(makeImport(filePath, src, prop.text, null))
      } else if (prop.type === 'pair_pattern' || prop.type === 'pair') {
        ctx.imports.push(makeImport(filePath, src, fieldOf(prop, 'key').text, fieldOf(prop, 'value').text))
      }
    }
    return
  }
  // const X = require('mod') — default/namespace import.
  ctx.imports.push({
    filePath,
    importString: src,
    resolvedPath: null,
    importedName: nameNode.text,
    alias: null,
    isNamespace: true,
    isDefault: true,
    isReexport: false,
  })
}

function makeImport(
  filePath: string,
  src: string,
  importedName: string,
  alias: string | null,
): ImportRecord {
  return {
    filePath,
    importString: src,
    resolvedPath: null,
    importedName,
    alias,
    isNamespace: false,
    isDefault: false,
    isReexport: false,
  }
}

/**
 * First `statement_block` descendant child of `node` (function/method body).
 * @param node - declaration or definition node.
 * @returns the body block, or `null`.
 */
export function statementBlockOf(node: TsNode): TsNode | null {
  return childByKind(node, 'statement_block')
}
