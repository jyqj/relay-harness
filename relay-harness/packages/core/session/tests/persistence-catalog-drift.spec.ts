/** Drift guard: the generated persistence catalog and the generated known-event set stay 1:1. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { KNOWN_SESSION_EVENT_TYPES } from '../src/known-event-types.ts'

const catalog = readFileSync(
  fileURLToPath(new URL('../../../../docs/persistence-catalog.md', import.meta.url)),
  'utf8',
)

/** The per-event section headings the generator emits under `## Events`. */
const catalogEventTypes = [...catalog.matchAll(/^#### `([^`]+)` — (?:surface|log-only)$/gm)]
  .map(match => match[1]!)

describe('persistence catalog ↔ known event types', () => {
  it('lists exactly the event types the persistence reader accepts, in both directions', () => {
    const known = [...KNOWN_SESSION_EVENT_TYPES]
    expect([...catalogEventTypes].sort()).toEqual([...known].sort())
    expect(new Set(catalogEventTypes).size).toBe(catalogEventTypes.length)
  })
})
