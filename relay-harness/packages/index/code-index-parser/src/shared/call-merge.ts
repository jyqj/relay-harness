/**
 * Merge of AST-extracted and regex-fallback call edges. The regex fallback
 * carries receiver/scope context loss, so AST entries win: a fallback edge is
 * dropped when an AST edge already exists at the same `(line, startCol)`.
 * @module
 */

import type { CallEdgeRecord } from '../types.ts'

/**
 * Append `fallback` entries not already present in `ast` by (line, startCol);
 * the input arrays are not mutated.
 * @param ast - AST-extracted edges, which win every duplicate.
 * @param fallback - regex-fallback edges, appended in order.
 * @returns the merged edge list.
 */
export function mergeCallEdges(
  ast: readonly CallEdgeRecord[],
  fallback: readonly CallEdgeRecord[],
): CallEdgeRecord[] {
  const seen = new Set(ast.map(edge => `${edge.line}:${edge.startCol}`))
  const merged = [...ast]
  for (const edge of fallback) {
    const key = `${edge.line}:${edge.startCol}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(edge)
  }
  return merged
}
