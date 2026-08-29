/**
 * AST cursor helpers over web-tree-sitter nodes. All traversals include
 * anonymous children (`node.children`), matching the reference
 * implementation's `node.children(&mut cursor)` / `count_args` semantics.
 * @module
 */

import type { Node as TsNode } from 'web-tree-sitter'

const PUNCTUATION = new Set(['(', ')', ','])

/**
 * Child at a bounded index: callers always pass an index under
 * `node.childCount`, so a `null` means a walker/grammar contract violation.
 * @param node - parent AST node.
 * @param index - child position, `0 <= index < node.childCount`.
 * @returns the child node.
 * @throws when the index is out of the node's child range.
 */
export function childAt(node: TsNode, index: number): TsNode {
  const child = node.child(index)
  if (child === null) throw new Error(`node '${node.type}' has no child at index ${index}`)
  return child
}

/**
 * Named-field child whose presence the grammar guarantees at the call site.
 * @param node - AST node.
 * @param name - field name.
 * @returns the field node.
 * @throws when the node has no such field (walker/grammar contract violation).
 */
export function fieldOf(node: TsNode, name: string): TsNode {
  const field = node.childForFieldName(name)
  if (field === null) throw new Error(`node '${node.type}' has no field '${name}'`)
  return field
}

/**
 * First direct child (named or anonymous) with `kind`.
 * @param node - parent AST node.
 * @param kind - child node type to find.
 * @returns the first matching child, or `null`.
 */
export function childByKind(node: TsNode, kind: string): TsNode | null {
  for (let i = 0; i < node.childCount; i++) {
    const child = childAt(node, i)
    if (child.type === kind) return child
  }
  return null
}

/**
 * Direct children with punctuation tokens (`(`, `)`, `,`) removed.
 * @param node - parent AST node.
 * @returns the non-punctuation children in order.
 */
export function argumentLikeChildren(node: TsNode): TsNode[] {
  const children: TsNode[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = childAt(node, i)
    if (!PUNCTUATION.has(child.type)) children.push(child)
  }
  return children
}

/**
 * Non-punctuation argument count of a call expression (0 without an `arguments` node).
 * @param callNode - `call_expression` node.
 * @returns the argument count.
 */
export function countArgs(callNode: TsNode): number {
  const args = childByKind(callNode, 'arguments')
  return args === null ? 0 : argumentLikeChildren(args).length
}

/**
 * Nth non-punctuation argument of a call expression (0-based).
 * @param callNode - `call_expression` node.
 * @param n - 0-based argument position.
 * @returns the argument node, or `null`.
 */
export function nthArgNode(callNode: TsNode, n: number): TsNode | null {
  const args = childByKind(callNode, 'arguments')
  if (args === null) return null
  return argumentLikeChildren(args)[n] ?? null
}

/**
 * First `string` child of a node (the module specifier of an import/export),
 * with its quote delimiters stripped.
 * @param node - parent AST node.
 * @returns the stripped string text, or `null`.
 */
export function firstStringChildText(node: TsNode): string | null {
  const child = childByKind(node, 'string')
  return child === null ? null : stripQuotes(child.text)
}

/**
 * Strip one layer of quote delimiters (`'`, `"`, or backticks) from both ends.
 * @param text - possibly quoted text.
 * @returns the text without its quote delimiters.
 */
export function stripQuotes(text: string): string {
  return text.replaceAll(/^['"`]+|['"`]+$/g, '')
}
