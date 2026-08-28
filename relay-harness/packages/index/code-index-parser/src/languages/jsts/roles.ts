/**
 * Framework role classification from naming conventions, ported from the
 * reference implementation (`jsts/mod.rs` `classify_framework_role`): React
 * hooks, React components, middleware, NestJS controllers and services.
 * @module
 */

import type { SymbolKind } from '../../types.ts'

/** A char is cased-uppercase (`1` is not, unlike a naive `toUpperCase` compare). */
function isUpper(c: string): boolean {
  const upper = c.toUpperCase()
  const lower = c.toLowerCase()
  return lower !== upper && c === upper
}

/** True when every character is cased-uppercase or `_` (`ABC`, `MY_CONST`). */
function allUpperOrUnderscore(name: string): boolean {
  for (let i = 0; i < name.length; i++) {
    const c = name.charAt(i)
    if (!isUpper(c) && c !== '_') return false
  }
  return true
}

/**
 * Classify a symbol's framework role by name conventions:
 * `useXxx` functions are hooks, PascalCase top-level functions are
 * components, names containing "middleware" are middleware, and classes
 * containing "controller"/"service" are controllers/services.
 * @param name - declared short name.
 * @param kind - symbol kind.
 * @param container - enclosing declaration name, or `null`.
 * @returns the framework role, or `null` when nothing matches.
 */
export function classifyFrameworkRole(
  name: string,
  kind: SymbolKind,
  container: string | null,
): string | null {
  const lower = name.toLowerCase()

  // React hooks: useXxx — "use" prefix with an uppercase 4th character.
  if (name.startsWith('use') && name.length > 3 && isUpper(name.charAt(3))) {
    return 'hook'
  }

  // React components: PascalCase top-level functions (not ALL_CAPS).
  if (kind === 'function' && container === null) {
    const first = name[0]
    if (first !== undefined && isUpper(first) && !allUpperOrUnderscore(name)) {
      return 'component'
    }
  }

  if ((kind === 'function' || kind === 'method') && lower.includes('middleware')) {
    return 'middleware'
  }
  if (kind === 'class' && lower.includes('controller')) {
    return 'controller'
  }
  if (kind === 'class' && lower.includes('service')) {
    return 'service'
  }
  return null
}
