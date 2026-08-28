/**
 * Symbol extraction for Python — `function_definition` /
 * `class_definition` records and the parameter-table parse. Ported from the
 * reference implementation's `python/mod.rs` (`extract_function`,
 * `extract_class`, `extract_python_param_types`); route edges, semantic
 * edges, and diagnostics are out of scope for this phase.
 * @module
 */

import type { Node as TsNode } from 'web-tree-sitter'
import { fieldOf } from '../../shared/cursor.ts'
import { symbolUid } from '../../id.ts'
import { qualify } from '../../shared/identifiers.ts'
import { makeSymbol } from '../jsts/symbols.ts'
import type { SymbolKind, SymbolRecord } from '../../types.ts'

/**
 * Extract a `function_definition`, or a `decorated_definition` wrapping one
 * (decorators never block extraction; the record spans the whole decorated
 * definition, matching the reference). Inside a class body the function is a
 * `method` qualified under the class.
 *
 * The uid hashes the raw parameter text (parens included), not the rendered
 * signature — the reference implementation's quirk, kept verbatim.
 * @param node - `function_definition` or `decorated_definition` node.
 * @param source - full source text.
 * @param filePath - workspace-relative file path.
 * @param container - enclosing class name, or `null`.
 * @returns the symbol record.
 */
export function extractFunction(
  node: TsNode,
  source: string,
  filePath: string,
  container: string | null,
): SymbolRecord {
  const funcNode = node.type === 'decorated_definition' ? fieldOf(node, 'definition') : node
  const name = fieldOf(funcNode, 'name').text
  const params = fieldOf(funcNode, 'parameters').text
  const returnTypeNode = funcNode.childForFieldName('return_type')
  const returnType = returnTypeNode?.text ?? null
  const signature = returnType === null
    ? `def ${name}${params}`
    : `def ${name}${params} -> ${returnType}`
  const [paramTypes, paramCount] = extractPythonParamTypes(params)
  const kind: SymbolKind = container === null ? 'function' : 'method'
  const qname = qualify(container, name)
  // `makeSymbol` hashes the rendered signature; the reference hashes the raw
  // `params` text, so the uid is overwritten to keep that identity.
  const sym = makeSymbol({ node, source, filePath }, name, kind, qname, container, signature)
  sym.symbolUid = symbolUid(filePath, qname, kind, params)
  sym.paramTypes = paramTypes
  sym.returnType = returnType
  sym.paramCount = paramCount
  return sym
}

/**
 * Extract a `class_definition`; the superclass list, when present, rides the
 * signature (`class Dog(Animal)`). The uid hashes without the signature, as
 * in the reference.
 * @param node - `class_definition` node.
 * @param source - full source text.
 * @param filePath - workspace-relative file path.
 * @returns the symbol record.
 */
export function extractClass(node: TsNode, source: string, filePath: string): SymbolRecord {
  const name = fieldOf(node, 'name').text
  const superclasses = node.childForFieldName('superclasses')?.text ?? null
  const signature = superclasses === null ? `class ${name}` : `class ${name}${superclasses}`
  const sym = makeSymbol({ node, source, filePath }, name, 'class', name, null, signature)
  sym.symbolUid = symbolUid(filePath, name, 'class')
  return sym
}

/**
 * Parameter table from the parenthesized parameter text: annotated types
 * comma-joined, and a count that skips `self`/`cls`, bare `*`/`/`, and
 * `*args`/`**kwargs`. Surrounding parens are stripped before parsing; text
 * the grammar recovered without them passes through unchanged (reference
 * `strip_prefix`/`strip_suffix` fallback).
 * @param params - parameter text as written, parens included.
 * @returns the joined annotated types (or `null`) and the counted parameters.
 */
export function extractPythonParamTypes(params: string): [types: string | null, count: number] {
  const inner = params.replace(/^\((.*)\)$/, '$1')
  const types: string[] = []
  let count = 0
  for (const raw of splitRespectingBrackets(inner, ',')) {
    const param = raw.trim()
    if (param === '' || param === 'self' || param === 'cls' || param === '*' || param === '/') continue
    if (param.startsWith('*')) continue
    count += 1
    // The annotation starts at the first top-level `:` (bracketed defaults
    // like `Dict[str, int]` never trigger it), and ends at the first
    // top-level `=`, dropping any bracketed default value.
    const colonPos = topLevelIndexOf(param, ':')
    if (colonPos === -1) continue
    const typePart = param.slice(colonPos + 1)
    const eqPos = topLevelIndexOf(typePart.trim(), '=')
    const typeName = (eqPos === -1 ? typePart : typePart.slice(0, eqPos)).trim()
    // The grammar only places a colon on annotated parameters, so the empty
    // type name never occurs on real source; the guard is the reference's.
    /* v8 ignore next */
    if (typeName !== '') types.push(typeName)
  }
  return [types.length === 0 ? null : types.join(', '), count]
}

/**
 * Split `text` at every top-level `delimiter`, skipping delimiters inside
 * `[]`, `()`, or `{}` (reference `split_respecting_brackets`).
 * @param text - text to split.
 * @param delimiter - single-character delimiter.
 * @returns the split parts in order.
 */
function splitRespectingBrackets(text: string, delimiter: string): string[] {
  const parts: string[] = []
  let rest = text
  let pos = topLevelIndexOf(rest, delimiter)
  while (pos !== -1) {
    parts.push(rest.slice(0, pos))
    rest = rest.slice(pos + delimiter.length)
    pos = topLevelIndexOf(rest, delimiter)
  }
  parts.push(rest)
  return parts
}

/**
 * Position of the first `delimiter` outside `[]`, `(){}` brackets, or `-1`
 * (the reference's `find_colon_outside_brackets`, generalized to the `=`
 * default separator).
 * @param text - text to scan.
 * @param delimiter - single-character delimiter.
 * @returns the 0-based position, or `-1`.
 */
function topLevelIndexOf(text: string, delimiter: string): number {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '[' || ch === '(' || ch === '{') depth += 1
    else if (ch === ']' || ch === ')' || ch === '}') depth -= 1
    else if (ch === delimiter && depth === 0) return i
  }
  return -1
}
