/**
 * web-tree-sitter runtime and grammar-wasm loading. `Parser.init()` and every
 * `Language.load()` are memoized: the WASM runtime is process-global, and a
 * grammar file is immutable, so both load exactly once. A failed grammar load
 * never poisons the cache — the next call for the same language retries.
 * @module
 */

import { readFileSync } from 'node:fs'
import { Language, Parser } from 'web-tree-sitter'
import type { Language as TsLanguage, Parser as TsParser, Tree as TsTree } from 'web-tree-sitter'
import type { SupportedLanguage } from './registry.ts'

let initPromise: Promise<void> | null = null

/**
 * Initialize the web-tree-sitter WASM runtime once per process.
 * @returns a promise that resolves once the runtime is ready.
 */
export function initParser(): Promise<void> {
  initPromise ??= Parser.init()
  return initPromise
}

const languages = new Map<SupportedLanguage, Promise<TsLanguage>>()

/**
 * Load (and memoize) the vendored grammar for `language`.
 *
 * Failures are isolated per language: the error is rethrown formatted as
 * `"tree-sitter-<language>.wasm: <message>"` and nothing is cached, so a
 * transient failure does not permanently poison the language.
 *
 * @param language - one of the vendored grammar languages.
 * @returns the memoized load promise resolving to the grammar.
 * @throws with the formatted file-prefixed message when the wasm file is
 * missing or not a loadable grammar.
 */
export function loadLanguage(language: SupportedLanguage): Promise<TsLanguage> {
  const pending = languages.get(language)
  if (pending !== undefined) return pending
  const load = (async () => {
    await initParser()
    const file = `tree-sitter-${language}.wasm`
    try {
      return await Language.load(readFileSync(grammarUrl(file)))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${file}: ${message}`)
    }
  })()
  languages.set(language, load)
  // A rejected promise must not poison the memo: drop it so the next caller
  // retries with a fresh load.
  load.catch(() => {
    if (languages.get(language) === load) languages.delete(language)
  })
  return load
}

/**
 * Parse `text` with an initialized parser. A plain-string parse always
 * yields a tree — possibly one made entirely of ERROR nodes.
 * @param parser - parser with a language assigned.
 * @param text - full file text.
 * @returns the syntax tree.
 * @throws when the runtime returns no tree (a runtime-contract violation).
 */
export function parseWith(parser: TsParser, text: string): TsTree {
  const tree = parser.parse(text)
  if (tree === null) throw new Error('tree-sitter parse failed')
  return tree
}

/** Resolve a vendored grammar file next to the compiled package layout. */
function grammarUrl(file: string): URL {
  return new URL(`../resources/grammars/${file}`, import.meta.url)
}

/**
 * Test seam: drop all memoized language loads (never needed in production).
 * @returns nothing.
 */
export function resetLanguageCache(): void {
  languages.clear()
}
