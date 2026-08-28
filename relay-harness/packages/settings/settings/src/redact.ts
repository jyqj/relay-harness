/**
 * Structural secret redaction for settings values. `role('secret')` fields are
 * removed from a value before it crosses a wire boundary; a sidecar records
 * each schema-declared secret position and whether it currently holds a value,
 * so a configuration surface can render a write-only input without ever
 * receiving the secret itself.
 * @module @relay-harness/rlh-settings/redact
 */

import type z from '@relay-harness/schemastery'

/**
 * Minimal structural view of a live schemastery node. Only the relations the
 * redactor walks are named; everything else on the instance is ignored.
 */
interface SchemaNode {
  type?: string
  meta?: { role?: unknown }
  /** `object` properties, keyed by property name. */
  dict?: Record<string, SchemaNode>
  /** `dict`/`array` element schema. */
  inner?: SchemaNode
  /** `union`/`intersect` member schemas. */
  list?: SchemaNode[]
}

/** One schema-declared secret position inside a redacted value. */
export interface RedactedSecret {
  /** Path from the section root to the removed field (concrete dict keys and array indexes included). */
  path: string[]
  /** Whether the field held a value before redaction. */
  set: boolean
}

/** A value with every `role('secret')` field removed, plus the removal record. */
export interface RedactedValue {
  /** Detached copy of the input with secret fields absent. */
  value: unknown
  /**
   * Every reachable secret position: object properties always (even unset, so
   * a form knows the slot exists), dict entries and array items only where the
   * value has them.
   */
  secrets: RedactedSecret[]
}

/** Whether a value is a plain data object the walker may recurse into. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether any schema node reachable from `node` through child relations
 * (`dict`, `inner`, `list`) declares `role('secret')`. Used on containers the
 * value walker does not traverse (unions, intersections, transforms): when a
 * secret hides inside one, redaction cannot prove the value safe.
 * @param node - subtree root to scan.
 * @returns whether a secret declaration exists in the subtree.
 */
function declaresSecret(node: SchemaNode | undefined): boolean {
  if (node === undefined) return false
  if (node.meta?.role === 'secret') return true
  if (node.dict !== undefined) {
    for (const child of Object.values(node.dict)) {
      if (declaresSecret(child)) return true
    }
  }
  if (node.list !== undefined) {
    for (const child of node.list) {
      if (declaresSecret(child)) return true
    }
  }
  return declaresSecret(node.inner)
}

function walk(node: SchemaNode | undefined, value: unknown, path: string[], secrets: RedactedSecret[]): unknown {
  if (node === undefined) return value
  if (node.meta?.role === 'secret') {
    secrets.push({ path, set: value !== undefined })
    return undefined
  }
  switch (node.type) {
    case 'object': {
      const properties = node.dict ?? {}
      const source = isRecord(value) ? value : undefined
      const rebuilt: Record<string, unknown> = {}
      if (source !== undefined) {
        for (const [key, entry] of Object.entries(source)) {
          if (key in properties) continue
          rebuilt[key] = entry
        }
      }
      for (const [key, child] of Object.entries(properties)) {
        const stripped = walk(child, source?.[key], [...path, key], secrets)
        if (stripped !== undefined) rebuilt[key] = stripped
      }
      return source === undefined && Object.keys(rebuilt).length === 0 ? value : rebuilt
    }
    case 'dict': {
      if (!isRecord(value)) return value
      const rebuilt: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        const stripped = walk(node.inner, entry, [...path, key], secrets)
        if (stripped !== undefined) rebuilt[key] = stripped
      }
      return rebuilt
    }
    case 'array': {
      if (!Array.isArray(value)) return value
      return value.map((entry, index) => walk(node.inner, entry, [...path, String(index)], secrets))
    }
    default:
      // A union, intersection, or transform is not traversed, so a secret
      // declared inside one cannot be stripped. Refuse the whole redaction
      // instead of emitting an unredacted value with an empty record.
      if (declaresSecret(node)) {
        throw new Error(`refusing to redact a value whose schema declares a secret inside a ${node.type} node at ${path.length > 0 ? path.join('.') : '<root>'}`)
      }
      return value
  }
}

/**
 * Remove every `role('secret')` field a schema declares from a value. The
 * walker follows `object`, `dict`, and `array` containers; a secret must be
 * declared directly on a field reachable through those containers. A secret
 * declared inside a union, intersection, or transform cannot be stripped, so
 * the call throws instead of returning an unredacted value. The input is
 * never mutated.
 * @param schema - live schemastery schema describing the value.
 * @param value - the value to strip; `undefined` yields an empty record with
 *   object-property secret slots still enumerated.
 * @returns the stripped detached value and the ordered secret positions.
 * @throws when the schema declares a secret reachable only through a union,
 *   intersection, or transform.
 */
export function redactSecrets(schema: z<never>, value: unknown): RedactedValue {
  const secrets: RedactedSecret[] = []
  const stripped = walk(schema, value, [], secrets)
  return { value: stripped, secrets }
}
