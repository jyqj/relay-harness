/**
 * Identifier vocabulary shared by the JS/TS walker: the reserved-word table
 * (transcribed from the reference implementation's `JS_KEYWORDS`) and
 * qualified-name construction.
 * @module
 */

/**
 * Reserved words and literal keywords that must never surface as call
 * callees or references.
 */
export const JS_KEYWORDS: ReadonlySet<string> = new Set([
  'function',
  'return',
  'if',
  'else',
  'for',
  'while',
  'switch',
  'case',
  'break',
  'continue',
  'throw',
  'try',
  'catch',
  'finally',
  'const',
  'let',
  'var',
  'class',
  'new',
  'import',
  'export',
  'default',
  'extends',
  'async',
  'await',
  'typeof',
  'instanceof',
  'this',
  'super',
  'delete',
  'void',
  'in',
  'of',
  'with',
  'debugger',
  'yield',
  'do',
  'true',
  'false',
  'null',
  'undefined',
])

/**
 * Qualified name: `"{container}.{name}"` at top level, plain `name` otherwise.
 * @param container - enclosing declaration name, or `null` at top level.
 * @param name - declared short name.
 * @returns the qualified name.
 */
export function qualify(container: string | null, name: string): string {
  return container === null ? name : `${container}.${name}`
}
