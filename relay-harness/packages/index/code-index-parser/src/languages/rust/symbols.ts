/**
 * Symbol extraction for Rust — `function_item`, `struct_item` (class),
 * `enum_item`, `trait_item` (interface), `impl_item` containers, and
 * `use_declaration` imports. Ported from the reference implementation's
 * `rust.rs` (`visit_node`, `extract_function`, `extract_named_item`,
 * `extract_import`); semantic edges and env-access data flow are out of
 * scope for this phase.
 * @module
 */

import type { Node as TsNode } from 'web-tree-sitter'
import { fieldOf } from '../../shared/cursor.ts'
import { makeSymbol } from '../jsts/symbols.ts'
import { qualify } from '../../shared/identifiers.ts'
import type { ExtractCtx } from '../../shared/extract-ctx.ts'
import type { ImportRecord, SymbolKind, SymbolRecord } from '../../types.ts'

/**
 * `impl` block's type name, read from the node text with the reference's
 * pattern: the type after `for` when the block implements a trait
 * (`impl Display for Point` → `Point`), otherwise the first type
 * (`impl Point` → `Point`). The greedy optional `for` group decides which —
 * the pattern must stay a consuming match starting at `impl` for the same
 * preference order to apply.
 * @param node - `impl_item` node.
 * @returns the container type name, or `null` when the pattern finds none.
 */
export function implContainerName(node: TsNode): string | null {
  const implType = IMPL_TYPE_RE.exec(node.text)?.[1]
  // An `impl_item` the grammar accepts always names a type, so the no-match
  // arm mirrors the reference's `captures` chain without a reachable input.
  /* v8 ignore next */
  if (implType === undefined) return null
  return implType
}

/** Reference `IMPL_TYPE_RE`, verbatim. */
const IMPL_TYPE_RE = /impl(?:\s*<[^>]+>)?(?:\s+[^\{]+?\s+for\s+)?\s*([A-Za-z_][A-Za-z0-9_]*)/

/**
 * Rust symbol walk. Only declaration nodes dispatch: functions take the
 * `impl` type as container, `impl_item`/`declaration_list` recurse into their
 * members, `use_declaration` yields an import, and everything else is
 * ignored — trait bodies and struct fields produce no symbols (reference
 * behavior: the walk starts at the root's children and never enters bodies).
 * @param node - current AST node.
 * @param source - full source text.
 * @param filePath - workspace-relative file path.
 * @param ctx - extraction accumulator.
 * @param container - enclosing `impl` type name, or `null`.
 * @returns nothing; records land on `ctx`.
 */
export function visitNode(
  node: TsNode,
  source: string,
  filePath: string,
  ctx: ExtractCtx,
  container: string | null,
): void {
  switch (node.type) {
    case 'function_item':
      ctx.symbols.push(extractFunction(node, source, filePath, container))
      return
    case 'struct_item':
      ctx.symbols.push(extractNamedItem(node, source, filePath, 'class', 'struct'))
      return
    case 'enum_item':
      ctx.symbols.push(extractNamedItem(node, source, filePath, 'enum', 'enum'))
      return
    case 'trait_item':
      ctx.symbols.push(extractNamedItem(node, source, filePath, 'interface', 'trait'))
      return
    case 'impl_item': {
      const implContainer = implContainerName(node)
      for (const child of node.children) {
        visitNode(child, source, filePath, ctx, implContainer)
      }
      return
    }
    case 'declaration_list': {
      for (const child of node.children) {
        visitNode(child, source, filePath, ctx, container)
      }
      return
    }
    case 'use_declaration':
      ctx.imports.push(extractUseImport(node, filePath))
      return
    default:
      return
  }
}

/**
 * Extract a `function_item`: `function` at top level, `method` under an
 * `impl` type, with the `fn name(parameters)` signature hashed into the uid.
 * @param node - `function_item` node.
 * @param source - full source text.
 * @param filePath - workspace-relative file path.
 * @param container - enclosing `impl` type name, or `null`.
 * @returns the symbol record.
 */
export function extractFunction(
  node: TsNode,
  source: string,
  filePath: string,
  container: string | null,
): SymbolRecord {
  const name = fieldOf(node, 'name').text
  const paramsNode = fieldOf(node, 'parameters')
  const qname = qualify(container, name)
  const kind: SymbolKind = container === null ? 'function' : 'method'
  const [paramTypes, paramCount] = extractRustParamInfo(paramsNode)
  const sym = makeSymbol(
    { node, source, filePath },
    name,
    kind,
    qname,
    container,
    `fn ${name}${paramsNode.text}`,
  )
  sym.paramTypes = paramTypes
  sym.returnType = node.childForFieldName('return_type')?.text.trim() ?? null
  sym.paramCount = paramCount
  return sym
}

/**
 * Parameter info from a Rust parameters node: the `type` field of each
 * `parameter` child, comma-joined. `self_parameter` children never count, and
 * so the count equals the number of recovered types (an untyped parameter is
 * not counted) — the reference's `extract_rust_param_info`.
 * @param paramsNode - `parameters` node.
 * @returns the joined types (or `null`) and the count.
 */
export function extractRustParamInfo(paramsNode: TsNode): [types: string | null, count: number] {
  const types: string[] = []
  for (const child of paramsNode.children) {
    if (child.type !== 'parameter') continue
    types.push(fieldOf(child, 'type').text.trim())
  }
  return [types.length === 0 ? null : types.join(', '), types.length]
}

/**
 * Extract a named declaration (`struct_item`, `enum_item`, `trait_item`) as
 * a top-level record whose signature is `"<keyword> <name>"`.
 * @param node - declaration node.
 * @param source - full source text.
 * @param filePath - workspace-relative file path.
 * @param kind - record kind for the declaration.
 * @param keyword - declaration keyword as written in source.
 * @returns the symbol record.
 */
export function extractNamedItem(
  node: TsNode,
  source: string,
  filePath: string,
  kind: SymbolKind,
  keyword: string,
): SymbolRecord {
  const name = fieldOf(node, 'name').text
  return makeSymbol({ node, source, filePath }, name, kind, name, null, `${keyword} ${name}`)
}

/**
 * Extract a `use_declaration`. The import string comes from the grammar's
 * `argument` field (the use tree itself), so a visibility modifier never
 * leaks into it; `pub`/`pub(...)` `use` marks the record as a re-export —
 * the file forwards part of another module's export surface.
 * @param node - `use_declaration` node.
 * @param filePath - workspace-relative file path.
 * @returns the import record.
 */
export function extractUseImport(node: TsNode, filePath: string): ImportRecord {
  let isReexport = false
  for (const child of node.children) {
    if (child.type === 'visibility_modifier') isReexport = true
  }
  return {
    filePath,
    importString: fieldOf(node, 'argument').text.trim(),
    resolvedPath: null,
    importedName: null,
    alias: null,
    isNamespace: false,
    isDefault: false,
    isReexport,
  }
}
