/**
 * Import extraction for Python — `import x[.y][ as alias]` and
 * `from M import a[, b as c][ *]` statements. Ported from the reference
 * implementation's `python/mod.rs` (`extract_import_statement`,
 * `extract_import_from_statement`); broker-import bookkeeping rides with the
 * deferred broker phase.
 * @module
 */

import type { Node as TsNode } from 'web-tree-sitter'
import { fieldOf } from '../../shared/cursor.ts'
import type { ImportRecord } from '../../types.ts'

/**
 * Extract an `import_statement`. Every plain or aliased import is a namespace
 * record (`importedName: '*'`) whose alias is the alias when given and the
 * first dotted segment otherwise; a statement the grammar recovers no names
 * from falls back to one raw-text record.
 * @param node - `import_statement` node.
 * @param filePath - workspace-relative file path.
 * @returns the import records in clause order (never empty).
 */
export function extractImportStatement(node: TsNode, filePath: string): ImportRecord[] {
  const imports: ImportRecord[] = []
  for (const child of node.children) {
    if (child.type === 'dotted_name') {
      const name = child.text
      imports.push(makeImport(filePath, name, '*', firstSegment(name), true))
    } else if (child.type === 'aliased_import') {
      const name = fieldOf(child, 'name')
      const alias = fieldOf(child, 'alias')
      imports.push(makeImport(filePath, name.text, '*', alias.text, true))
    }
  }
  /* v8 ignore next: the grammar recovers a nameless `import` as an ERROR
     node, so every real statement yields at least one record and the
     raw-text fallback is unreachable with the vendored grammar. */
  if (imports.length === 0) imports.push(makeImport(filePath, node.text, null, null, true))
  return imports
}

/**
 * Extract an `import_from_statement`. The module path joins the relative-dot
 * prefix (`..core`) with the module name; each imported name becomes its own
 * record whose alias defaults to the name itself, and a `*` import is a
 * namespace record. An unparseable clause falls back to one raw-text record.
 * @param node - `import_from_statement` node.
 * @param filePath - workspace-relative file path.
 * @returns the import records in clause order (never empty).
 */
export function extractImportFromStatement(node: TsNode, filePath: string): ImportRecord[] {
  const imports: ImportRecord[] = []
  let modulePath = ''
  let foundFrom = false
  let foundImport = false
  for (const child of node.children) {
    if (child.type === 'from') {
      foundFrom = true
      continue
    }
    if (child.type === 'import') {
      foundImport = true
      continue
    }
    if (foundFrom && !foundImport) {
      // Between `from` and `import` the grammar places only a relative_import
      // node (`.`, `..core`) or the dotted module name; the kind check is the
      // reference's and has no reachable false side.
      /* v8 ignore next */
      if (child.type === 'relative_import' || child.type === 'dotted_name') {
        modulePath += child.text
      }
      continue
    }
    if (child.type === 'dotted_name') {
      imports.push(makeImport(filePath, modulePath, child.text, child.text, false))
    } else if (child.type === 'aliased_import') {
      const name = fieldOf(child, 'name')
      const alias = fieldOf(child, 'alias')
      imports.push(makeImport(filePath, modulePath, name.text, alias.text, false))
    } else if (child.type === 'wildcard_import') {
      imports.push(makeImport(filePath, modulePath, '*', null, true))
    }
  }
  /* v8 ignore next: the grammar recovers a clause without names as an ERROR
     node, so every real statement yields at least one record and the
     raw-text fallback is unreachable with the vendored grammar. */
  if (imports.length === 0) imports.push(makeImport(filePath, node.text, null, null, false))
  return imports
}

function makeImport(
  filePath: string,
  importString: string,
  importedName: string | null,
  alias: string | null,
  isNamespace: boolean,
): ImportRecord {
  return {
    filePath,
    importString,
    resolvedPath: null,
    importedName,
    alias,
    isNamespace,
    isDefault: false,
    isReexport: false,
  }
}

/** First dotted segment of a module path (`pkg.mod` → `pkg`). */
function firstSegment(dottedName: string): string {
  const dot = dottedName.indexOf('.')
  return dot === -1 ? dottedName : dottedName.slice(0, dot)
}
