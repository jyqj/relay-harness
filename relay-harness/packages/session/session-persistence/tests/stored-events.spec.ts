import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@relay-harness/rlh-llm'
import { Session, SessionId } from '@relay-harness/rlh-session'
import { adoptStoredEvents, snapshotStoredEvents } from '../src/stored-events.ts'

function storedPrompt() {
  const session = Session.create(SessionId('stored-event-ownership'))
  session.append('user/message', createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'preserve identity' }],
  }), { surfaceOp: 'append' })
  return { id: session.id, events: [...structuredClone(session.events)] }
}

describe('stored event normalization ownership', () => {
  it('snapshots a borrowed result without mutating or freezing its source', () => {
    const { id, events } = storedPrompt()
    const before = structuredClone(events)
    const normalized = snapshotStoredEvents(events, id)
    expect(normalized).not.toBe(events)
    expect(normalized[0]).not.toBe(events[0])
    expect(events).toEqual(before)
    expect(Object.isFrozen(events[0])).toBe(false)
    expect(Object.isFrozen(normalized[0]?.data)).toBe(true)
    expect(normalized).toEqual(events)
  })

  it('adopts the exclusive backend array while producing the same durable interpretation', () => {
    const { id, events } = storedPrompt()
    const expected = snapshotStoredEvents(events, id)
    const adopted = adoptStoredEvents(events, id)
    expect(adopted).toBe(events)
    expect(adopted).toEqual(expected)
    expect(Object.isFrozen(adopted[0]?.data)).toBe(true)
  })
})
