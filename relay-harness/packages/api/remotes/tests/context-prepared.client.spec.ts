/** Client SDK projection of the durable Context Engine history event. */

import { describe, expect, it } from 'vitest'
import type {
  ContextPreparedEventData,
  CoverageRecord,
  Evidence,
} from '../src/client/index.ts'
import type { SessionEvent } from '@relay-harness/rlh-client-connection/client'

/** Compile-time proof that the Client assembly loads the SessionEventMap augmentation. */
function dataOf(event: SessionEvent<'context/prepared'>): ContextPreparedEventData {
  return event.data
}

describe('context/prepared client SDK projection', () => {
  it('exports the trace payload and keeps evidence/coverage types reachable', () => {
    const evidence = null as Evidence | null
    const coverage = null as CoverageRecord | null
    expect([dataOf, evidence, coverage]).toHaveLength(3)
  })
})
