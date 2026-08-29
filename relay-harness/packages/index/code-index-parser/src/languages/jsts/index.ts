/**
 * JS/TS walker: top-level AST traversal, class bodies with decorator
 * handling, and expression-tree walking for calls and literals. Ported from
 * the reference implementation's `jsts/visitor.rs`; route/framework edges,
 * HTTP calls, broker calls, and dispatch sites are out of scope for this
 * phase.
 * @module
 */

import type { Node as TsNode } from 'web-tree-sitter'
import { Parser } from 'web-tree-sitter'
import { mergeCallEdges } from '../../shared/call-merge.ts'
import { ExtractCtx } from '../../shared/extract-ctx.ts'
import { childAt, fieldOf } from '../../shared/cursor.ts'
import { loadLanguage, parseWith } from '../../loader.ts'
import type { SupportedLanguage } from '../../registry.ts'
import { qualify } from '../../shared/identifiers.ts'
import type { CallEdgeRecord, ImportRecord, LiteralRecord, SymbolRecord } from '../../types.ts'
import { applyPendingExports, collectImportLocalBindings, extractImport, visitExport } from './imports.ts'
import { visitCallExpression, visitNewExpression } from './calls.ts'
import { extractRegexCalls, addLiteral, isIndexableLiteral } from './extras.ts'
import {
  extractClass,
  extractFunction,
  extractMethod,
  extractVariableDeclarations,
  makeSymbol,
  statementBlockOf,
} from './symbols.ts'
import { classifyFrameworkRole } from './roles.ts'
import { NESTJS_DECORATORS } from './constants.ts'

/**
 * The grammar that parses a supported language (`jsx` rides JavaScript).
 * @param language - supported language name.
 * @returns the grammar to load.
 */
export function grammarFor(language: SupportedLanguage): JstsGrammar {
  switch (language) {
    case 'javascript':
    case 'jsx':
      return 'javascript'
    case 'typescript':
      return 'typescript'
    default:
      return 'tsx'
  }
}

/** Grammar names loadable for the JS/TS family. */
export type JstsGrammar = 'javascript' | 'typescript' | 'tsx'

/** Raw extraction output for one JS/TS file. */
export interface JstsExtraction {
  readonly symbols: SymbolRecord[]
  readonly imports: ImportRecord[]
  readonly callEdges: CallEdgeRecord[]
  readonly literals: LiteralRecord[]
}

/**
 * Parse `text` with the JS/TS grammar and extract symbols, imports, call
 * edges (AST + regex fallback merged), and literals.
 *
 * @param filePath - workspace-relative file path (used for record ids).
 * @param text - full file text.
 * @param grammar - which grammar to parse with.
 * @returns the extracted records.
 * @throws when the grammar or the parse itself fails; the caller formats and
 * counts the failure.
 */
export async function extractJsts(
  filePath: string,
  text: string,
  grammar: JstsGrammar,
): Promise<JstsExtraction> {
  const language = await loadLanguage(grammar)
  const parser = new Parser()
  parser.setLanguage(language)
  const ctx = new ExtractCtx()
  try {
    const tree = parseWith(parser, text)
    try {
      visitNode(tree.rootNode, text, filePath, ctx, null, false, false)
      applyPendingExports(ctx)
    } finally {
      tree.delete()
    }
  } finally {
    parser.delete()
  }

  // Deduplicate the visitor's body-walk overlap by position: the explicit
  // body walk and the generic child walk can reach the same call site.
  const seen = new Set<string>()
  const callEdges = ctx.callEdges.filter((edge) => {
    const key = `${edge.line}:${edge.startCol}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return {
    symbols: ctx.symbols,
    imports: ctx.imports,
    callEdges: mergeCallEdges(callEdges, extractRegexCalls(text, filePath, ctx.symbols)),
    literals: ctx.literals,
  }
}

/**
 * Top-level walk. `container` is the enclosing declaration name, `inExport`
 * whether the node sits under an `export_statement`, `isDefaultExport`
 * whether that export is `default`.
 */
function visitNode(
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  container: string | null,
  inExport: boolean,
  isDefaultExport: boolean,
): void {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration': {
      const prevUid = ctx.currentSymbolUid
      ctx.currentSymbolUid = null
      const sym = extractFunction(node, source, filePath, container)
      sym.frameworkRole = classifyFrameworkRole(sym.name, sym.kind, container)
      if (inExport) {
        sym.exportName = sym.name
        sym.isDefaultExport = isDefaultExport
      }
      ctx.currentSymbolUid = sym.symbolUid
      ctx.symbols.push(sym)
      // Visit the body for calls — the function name is the container inside.
      const body = fieldOf(node, 'body')
      visitExpressionTree(body, source, filePath, ctx, sym.name)
      visitChildren(node, source, filePath, ctx, sym.name)
      ctx.currentSymbolUid = prevUid
      return
    }
    case 'class_declaration': {
      const sym = extractClass(node, source, filePath)
      sym.frameworkRole = classifyFrameworkRole(sym.name, sym.kind, null)
      if (inExport) {
        sym.exportName = sym.name
        sym.isDefaultExport = isDefaultExport
      }
      ctx.symbols.push(sym)
      const body = fieldOf(node, 'body')
      visitClassBody(body, source, filePath, ctx, sym.name)
      return // children already visited
    }
    case 'method_definition': {
      const prevUid = ctx.currentSymbolUid
      ctx.currentSymbolUid = null
      const sym = extractMethod(node, source, filePath, container)
      sym.frameworkRole = classifyFrameworkRole(sym.name, sym.kind, container)
      ctx.currentSymbolUid = sym.symbolUid
      ctx.symbols.push(sym)
      visitExpressionTree(fieldOf(node, 'body'), source, filePath, ctx, sym.name)
      visitChildren(node, source, filePath, ctx, sym.name)
      ctx.currentSymbolUid = prevUid
      return
    }
    case 'lexical_declaration':
    case 'variable_declaration': {
      extractVariableDeclarations(
        node,
        source,
        filePath,
        ctx,
        container,
        inExport,
        isDefaultExport,
        (value) => {
          visitExpressionTree(value, source, filePath, ctx, container)
        },
      )
      break
    }
    case 'export_statement': {
      const isDefault = visitExport(node, ctx, filePath)
      for (let i = 0; i < node.childCount; i++) {
        const child = childAt(node, i)
        if (SKIP_EXPORT_CHILDREN.has(child.type)) continue
        visitNode(child, source, filePath, ctx, container, true, isDefault)
      }
      return
    }
    case 'import_statement': {
      const imp = extractImport(node, filePath)
      for (const binding of collectImportLocalBindings(node)) {
        if (!ctx.importBindings.has(binding)) ctx.importBindings.set(binding, imp)
      }
      ctx.imports.push(imp)
      return
    }
    case 'expression_statement': {
      // Visit expression children for call extraction.
      for (let i = 0; i < node.childCount; i++) {
        visitExpressionTree(childAt(node, i), source, filePath, ctx, container)
      }
      return
    }
    default:
      break
  }
  visitChildren(node, source, filePath, ctx, container)
}

/** Anonymous export-statement tokens that carry no extractable declaration. */
const SKIP_EXPORT_CHILDREN: ReadonlySet<string> = new Set([
  'export',
  'default',
  'string',
  'export_clause',
  ';',
  '{',
  '}',
  ',',
  'from',
  '*',
])

/**
 * Decorator name without its `@` prefix and argument list (`@Get('/x')` →
 * `get`), lowercased for table lookup.
 */
function decoratorName(text: string): string {
  const name = text.replace(/^@+/, '')
  const paren = name.indexOf('(')
  return (paren === -1 ? name : name.slice(0, paren)).trim().toLowerCase()
}

function visitChildren(
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  container: string | null,
): void {
  for (let i = 0; i < node.childCount; i++) {
    visitNode(childAt(node, i), source, filePath, ctx, container, false, false)
  }
}

/**
 * Class body walk with decorator support: NestJS method decorators mark the
 * method as a route handler, field definitions carrying arrow functions
 * become methods.
 */
function visitClassBody(
  body: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  className: string,
): void {
  let pendingDecorators: TsNode[] = []
  for (let i = 0; i < body.childCount; i++) {
    const member = childAt(body, i)
    if (member.type === 'decorator') {
      pendingDecorators.push(member)
      continue
    }
    const decorators = pendingDecorators
    pendingDecorators = []

    if (member.type === 'method_definition') {
      const sym = extractMethod(member, source, filePath, className)
      // NestJS route decorators: @Get, @Post, ... → route_handler role.
      const decName = decorators.map(decorator => decoratorName(decorator.text))
        .find(name => NESTJS_DECORATORS.has(name))
      sym.frameworkRole = decName !== undefined
        ? 'route_handler'
        : classifyFrameworkRole(sym.name, sym.kind, className)
      ctx.symbols.push(sym)
      const prevUid = ctx.currentSymbolUid
      ctx.currentSymbolUid = sym.symbolUid
      visitExpressionTree(fieldOf(member, 'body'), source, filePath, ctx, className)
      ctx.currentSymbolUid = prevUid
    } else if (member.type === 'field_definition') {
      visitFieldDefinition(member, source, filePath, ctx, className)
    }
  }
}

/** Field definitions: arrow-function values become methods; other values are walked for calls. */
function visitFieldDefinition(
  member: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  className: string,
): void {
  // Field definitions carry their name either as the `name` field or as a
  // bare property identifier child, depending on the grammar version.
  const nameNode = member.childForFieldName('name')
    ?? member.namedChildren.find(child => child.type === 'property_identifier')
    ?? null
  if (nameNode === null) return
  const name = nameNode.text
  let hasFunction = false
  for (let i = 0; i < member.childCount; i++) {
    const child = childAt(member, i)
    if (child.type === 'arrow_function' || child.type === 'function_expression') {
      hasFunction = true
      const params = fieldOf(child, 'parameters').text
      const sym = makeSymbol(
        { node: member, source, filePath },
        name,
        'method',
        qualify(className, name),
        className,
        `${name}${params}`,
      )
      sym.frameworkRole = classifyFrameworkRole(name, 'method', className)
      const fieldSymUid = sym.symbolUid
      ctx.symbols.push(sym)
      const block = statementBlockOf(child)
      if (block !== null) {
        const prevUid = ctx.currentSymbolUid
        ctx.currentSymbolUid = fieldSymUid
        visitExpressionTree(block, source, filePath, ctx, className)
        ctx.currentSymbolUid = prevUid
      }
      break
    }
  }
  if (hasFunction) return
  // Non-function field — still visit the value for calls.
  for (let i = 0; i < member.childCount; i++) {
    const child = childAt(member, i)
    if (child.type === 'property_identifier' || child.type === '=' || child.type === ';') continue
    visitExpressionTree(child, source, filePath, ctx, className)
  }
}

/**
 * Expression-tree walk — extracts call edges and literals, descending
 * through awaits, JSX, and nested functions (which get their own caller
 * context when named).
 */
function visitExpressionTree(
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  container: string | null,
): void {
  switch (node.type) {
    case 'call_expression': {
      visitCallExpression(node, source, filePath, ctx, container, false)
      // Every call expression carries an arguments node.
      const args = fieldOf(node, 'arguments')
      {
        for (let i = 0; i < args.childCount; i++) {
          const child = childAt(args, i)
          if (child.type === '(' || child.type === ')' || child.type === ',') continue
          visitExpressionTree(child, source, filePath, ctx, container)
        }
      }
      return
    }
    case 'new_expression': {
      visitNewExpression(node, source, filePath, ctx, container)
      return
    }
    case 'await_expression': {
      for (let i = 0; i < node.childCount; i++) {
        const child = childAt(node, i)
        if (child.type === 'await') continue
        if (child.type === 'call_expression') {
          visitCallExpression(child, source, filePath, ctx, container, true)
        } else {
          visitExpressionTree(child, source, filePath, ctx, container)
        }
      }
      return
    }
    case 'string': {
      const value = node.text.replaceAll(/^['"`]+|['"`]+$/g, '')
      if (isIndexableLiteral(value)) addLiteral(value, node, source, filePath, ctx, container)
      return
    }
    case 'template_string': {
      const value = node.text.replaceAll(/^`+|`+$/g, '')
      if (isIndexableLiteral(value)) addLiteral(value, node, source, filePath, ctx, container)
      return
    }
    // JSX containers: descend so nested strings/calls/tags are still found.
    case 'jsx_opening_element':
    case 'jsx_self_closing_element':
    case 'jsx_element':
    // Named function expressions passed as callbacks set up caller context.
    case 'function_expression':
    case 'function': {
      visitFunctionLike(node, source, filePath, ctx, container)
      return
    }
    default: {
      for (let i = 0; i < node.childCount; i++) {
        visitExpressionTree(childAt(node, i), source, filePath, ctx, container)
      }
    }
  }
}

/**
 * Named function expressions passed as callbacks establish their own caller
 * context; anonymous ones are plain recursion. JSX containers just descend.
 */
function visitFunctionLike(
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  container: string | null,
): void {
  if (node.type === 'jsx_opening_element' || node.type === 'jsx_self_closing_element' || node.type === 'jsx_element') {
    for (let i = 0; i < node.childCount; i++) {
      visitExpressionTree(childAt(node, i), source, filePath, ctx, container)
    }
    return
  }

  const nameNode = node.childForFieldName('name')
  const funcName = nameNode?.text ?? ''
  if (funcName.length > 0) {
    const existing = ctx.symbols.find(sym => sym.name === funcName && sym.filePath === filePath)
    if (existing === undefined) {
      const sym = makeSymbol(
        { node, source, filePath },
        funcName,
        'function',
        funcName,
        container,
        null,
      )
      const prevUid = ctx.currentSymbolUid
      ctx.currentSymbolUid = sym.symbolUid
      ctx.symbols.push(sym)
      visitExpressionTree(fieldOf(node, 'body'), source, filePath, ctx, funcName)
      ctx.currentSymbolUid = prevUid
      return
    }
    // Already registered — adopt its uid context and visit the body.
    const prevUid = ctx.currentSymbolUid
    ctx.currentSymbolUid = existing.symbolUid
    visitExpressionTree(fieldOf(node, 'body'), source, filePath, ctx, funcName)
    ctx.currentSymbolUid = prevUid
    return
  }
  // Anonymous function: plain recursion.
  for (let i = 0; i < node.childCount; i++) {
    visitExpressionTree(childAt(node, i), source, filePath, ctx, container)
  }
}
