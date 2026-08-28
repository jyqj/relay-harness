/**
 * Import/export extraction for JS/TS — ES `import` statements, `export`
 * clauses and re-exports (including two-step forwarding of imported
 * bindings), deferred export application, and local import bindings.
 * Ported from the reference implementation's `jsts/imports_exports.rs`.
 * @module
 */

import type { Node as TsNode } from 'web-tree-sitter'
import { childAt, fieldOf, firstStringChildText } from '../../shared/cursor.ts'
import type { ExtractCtx, PendingExport } from '../../shared/extract-ctx.ts'
import type { ImportRecord, SymbolRecord } from '../../types.ts'

/**
 * Process an `export_statement`. Returns `isDefault` for the visitor to pass
 * down to exported declarations; re-export imports and pending local exports
 * are recorded on `ctx`.
 * @param node - `export_statement` node.
 * @param ctx - extraction accumulator.
 * @param filePath - workspace-relative file path.
 * @returns whether the statement is an `export default`.
 */
export function visitExport(
  node: TsNode,
  ctx: ExtractCtx,
  filePath: string,
): boolean {
  let isDefault = false
  for (let i = 0; i < node.childCount; i++) {
    if (childAt(node, i).type === 'default') isDefault = true
  }

  // Re-export: export ... from "..."
  const src = firstStringChildText(node)
  if (src !== null) {
    if (hasStarChild(node)) {
      ctx.imports.push({
        filePath,
        importString: src,
        resolvedPath: null,
        importedName: null,
        alias: null,
        isNamespace: true,
        isDefault: false,
        isReexport: true,
      })
      return isDefault
    }
    // export { a as b } from "..."
    for (let i = 0; i < node.childCount; i++) {
      const child = childAt(node, i)
      if (child.type !== 'export_clause') continue
      for (const [imported, exported] of exportSpecifiers(child)) {
        ctx.imports.push({
          filePath,
          importString: src,
          resolvedPath: null,
          importedName: imported,
          alias: exported,
          isNamespace: false,
          isDefault: false,
          isReexport: true,
        })
      }
    }
    return isDefault
  }

  // Local export clause: export { foo, bar as baz }
  for (let i = 0; i < node.childCount; i++) {
    const child = childAt(node, i)
    if (child.type !== 'export_clause') continue
    for (const [localName, exportedName] of exportSpecifiers(child)) {
      const pending: PendingExport = { localName, exportName: exportedName, isDefault: false }
      ctx.pendingExports.push(pending)
    }
    return isDefault
  }

  // export default <identifier>
  if (isDefault) {
    for (let i = 0; i < node.childCount; i++) {
      const child = childAt(node, i)
      if (child.type !== 'identifier') continue
      ctx.pendingExports.push({
        localName: child.text,
        exportName: null,
        isDefault: true,
      })
      break
    }
  }
  return isDefault
}

function hasStarChild(node: TsNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (childAt(node, i).type === '*') return true
  }
  return false
}

/**
 * `(local/imported, exported)` name pairs of an export clause's
 * `export_specifier` children; a bare specifier exports its own name.
 */
function exportSpecifiers(clause: TsNode): Array<[string, string]> {
  const pairs: Array<[string, string]> = []
  for (let i = 0; i < clause.childCount; i++) {
    const spec = childAt(clause, i)
    if (spec.type !== 'export_specifier') continue
    const [localName, exportedName] = specifierNames(spec)
    pairs.push([localName, exportedName ?? localName])
  }
  return pairs
}

/**
 * The `(first, second)` identifier names of one `export_specifier`; the
 * second entry is `null` for a bare specifier that exports its own name.
 */
function specifierNames(spec: TsNode): [string, string | null] {
  const names: string[] = []
  for (let j = 0; j < spec.childCount && names.length < 2; j++) {
    const part = childAt(spec, j)
    if (part.type === 'identifier' || part.type === 'property_identifier') {
      names.push(part.text)
    }
  }
  // The grammar guarantees at least one identifier per specifier; a bare
  // specifier names exactly one.
  const [first = '', second = null] = names
  return [first, second]
}

/**
 * Apply deferred export bindings to symbols. A pending export binds to the
 * top-level symbol of the same local name; when no such symbol exists but an
 * ES import introduced the binding, the import is two-step forwarding and
 * gets marked as a re-export (only the flag — every other field stays as
 * extracted).
 * @param ctx - extraction accumulator holding symbols, imports, and pendings.
 * @returns nothing; symbols and imports are updated in place.
 */
export function applyPendingExports(ctx: ExtractCtx): void {
  if (ctx.pendingExports.length === 0) return
  const nameToSymbol = new Map<string, SymbolRecord>()
  for (const sym of ctx.symbols) {
    if (sym.container === null && !nameToSymbol.has(sym.name)) {
      nameToSymbol.set(sym.name, sym)
    }
  }

  for (const pending of ctx.pendingExports) {
    const sym = nameToSymbol.get(pending.localName)
    if (sym !== undefined) {
      if (pending.isDefault) {
        sym.isDefaultExport = true
        if (sym.exportName === null) sym.exportName = sym.name
      } else {
        // Clause pendings always carry the exported name; only the default
        // case above can carry `null`, so the nullish side is unreachable.
        /* v8 ignore next: unreachable by construction, kept for type totality */
        sym.exportName = pending.exportName ?? sym.name
      }
      continue
    }
    const importRecord = ctx.importBindings.get(pending.localName)
    if (importRecord !== undefined) {
      importRecord.isReexport = true
    }
  }
}

/**
 * Local binding names introduced by an ES `import_statement`: the default
 * import identifier, the `* as ns` namespace alias, and named specifiers
 * (using the `as` alias as the local name when present).
 * @param node - `import_statement` node.
 * @returns the local binding names in clause order.
 */
export function collectImportLocalBindings(node: TsNode): string[] {
  const bindings: string[] = []
  for (let i = 0; i < node.childCount; i++) {
    const child = childAt(node, i)
    if (child.type !== 'import_clause') continue
    for (let j = 0; j < child.childCount; j++) {
      const part = childAt(child, j)
      if (part.type === 'identifier') {
        bindings.push(part.text)
      } else if (part.type === 'namespace_import') {
        for (let k = 0; k < part.childCount; k++) {
          const nsChild = childAt(part, k)
          if (nsChild.type === 'identifier') {
            bindings.push(nsChild.text)
          }
        }
      } else if (part.type === 'named_imports') {
        for (let k = 0; k < part.childCount; k++) {
          const spec = childAt(part, k)
          if (spec.type !== 'import_specifier') continue
          const local = spec.childForFieldName('alias') ?? spec.childForFieldName('name')
          if (local !== null) bindings.push(local.text)
        }
      }
    }
  }
  return bindings
}

/**
 * Extract an ES `import_statement`. The rough classification matches the
 * reference implementation: the imported name is the whole statement text,
 * namespace-ness is a `*` substring test, default-ness a `default` substring
 * test.
 * @param node - `import_statement` node.
 * @param filePath - workspace-relative file path.
 * @returns the import record.
 */
export function extractImport(node: TsNode, filePath: string): ImportRecord {
  // Import statements always carry a source field, including error recovery.
  const src = fieldOf(node, 'source').text.replaceAll(/^['"]+|['"]+$/g, '')
  const text = node.text
  return {
    filePath,
    importString: src,
    resolvedPath: null,
    importedName: text,
    alias: null,
    isNamespace: text.includes('*'),
    isDefault: text.includes('default'),
    isReexport: false,
  }
}
