/**
 * Import path resolution — maps an import string to a project-relative file
 * path. Supports Node.js relative specifiers (`./x`, `../y`) and Python
 * dotted modules; bare module specifiers are unresolvable by design.
 * Ported from the reference implementation's `import_resolver.rs`.
 * @module
 */

import { existsSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'

/** Extension probe order for extensionless relative specifiers. */
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const

/**
 * Resolve `importString` from `fromFile` to a path relative to `projectRoot`,
 * or `null` when it points outside the project (or at a bare module).
 * @param projectRoot - workspace root directory.
 * @param fromFile - workspace-relative path of the importing file.
 * @param importString - module specifier as written.
 * @returns the resolved project-relative path, or `null`.
 */
export function resolveImport(
  projectRoot: string,
  fromFile: string,
  importString: string,
): string | null {
  // Python dotted imports resolve from the project root:
  // "from foo.bar import baz" → foo/bar.py or foo/bar/__init__.py
  if (
    !importString.startsWith('.')
    && !importString.startsWith('/')
    && !importString.includes('/')
    && fromFile.endsWith('.py')
  ) {
    return resolvePythonImport(projectRoot, importString)
  }

  // JS/TS relative imports: "./foo", "../bar"
  if (importString.startsWith('.')) {
    return resolveJsRelative(projectRoot, fromFile, importString)
  }

  // Bare module import (node_modules) — not resolvable to a project file.
  return null
}

function resolvePythonImport(projectRoot: string, importString: string): string | null {
  // "import foo.bar" / "from foo.bar import baz" — keep the module path only.
  const stripped = importString.replace(/^(?:from|import)\s+/, '')
  // A degenerate keyword-only specifier strips to the empty string.
  const modulePath = /^\S+/.exec(stripped)?.[0] ?? ''
  if (modulePath === '') return null

  const relPath = modulePath.split('.').join('/')
  if (existsSync(join(projectRoot, `${relPath}.py`))) {
    return `${relPath}.py`
  }
  if (existsSync(join(projectRoot, relPath, '__init__.py'))) {
    return `${relPath}/__init__.py`
  }
  return null
}

function resolveJsRelative(
  projectRoot: string,
  fromFile: string,
  importString: string,
): string | null {
  const fromDir = posix.dirname(fromFile)
  const target = `${fromDir}/${importString}`

  // Normalize `.`/`..` segments. A `..` with nothing left to pop escapes the
  // project root: returning null is correct — silently dropping it would
  // collapse `../../../etc` to `etc` and forge a bogus intra-project edge.
  const normalized: string[] = []
  for (const component of target.split('/')) {
    if (component === '..') {
      if (normalized.pop() === undefined) return null
    } else if (component !== '.' && component !== '') {
      normalized.push(component)
    }
  }
  const base = normalized.join('/')
  if (base === '') return null

  for (const ext of EXTENSIONS) {
    if (existsSync(join(projectRoot, base + ext))) return base + ext
  }
  for (const ext of EXTENSIONS) {
    if (existsSync(join(projectRoot, base, `index${ext}`))) return `${base}/index${ext}`
  }
  // Exact match (already carries an extension).
  if (existsSync(join(projectRoot, base)) && statSync(join(projectRoot, base)).isFile()) {
    return base
  }
  return null
}
