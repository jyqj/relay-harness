/**
 * Rust walker: a declaration pass over the root's children extracts symbols
 * and `use` imports, then an AST pass extracts call edges from function and
 * method bodies. Ported from the reference implementation's `rust.rs`
 * (`extract_symbols`, `parse_with_timeout`); semantic edges, env-access data
 * flow, HTTP calls, and identifier refs are out of scope for this phase.
 * @module
 */

import { Parser } from 'web-tree-sitter'
import { ExtractCtx } from '../../shared/extract-ctx.ts'
import { loadLanguage, parseWith } from '../../loader.ts'
import type { CallEdgeRecord, ImportRecord, LiteralRecord, SymbolRecord } from '../../types.ts'
import { extractCalls } from './calls.ts'
import { visitNode } from './symbols.ts'

/** Raw extraction output for one Rust file. */
export interface RustExtraction {
  readonly symbols: SymbolRecord[]
  readonly imports: ImportRecord[]
  readonly callEdges: CallEdgeRecord[]
  readonly literals: LiteralRecord[]
}

/**
 * Parse `text` with the Rust grammar and extract symbols, `use` imports, and
 * the call edges found inside function/method bodies.
 *
 * @param filePath - workspace-relative file path (used for record ids).
 * @param text - full file text.
 * @returns the extracted records.
 * @throws when the grammar or the parse itself fails; the caller formats and
 * counts the failure.
 */
export async function extractRust(filePath: string, text: string): Promise<RustExtraction> {
  const language = await loadLanguage('rust')
  const parser = new Parser()
  parser.setLanguage(language)
  const ctx = new ExtractCtx()
  try {
    const tree = parseWith(parser, text)
    try {
      // Declaration pass: the walk starts at the root's children and never
      // enters function bodies, so only top-level and `impl` items register.
      for (const child of tree.rootNode.children) {
        visitNode(child, text, filePath, ctx, null)
      }
      return {
        symbols: ctx.symbols,
        imports: ctx.imports,
        callEdges: extractCalls(tree.rootNode, text, filePath, ctx.symbols),
        literals: [],
      }
    } finally {
      tree.delete()
    }
  } finally {
    parser.delete()
  }
}
