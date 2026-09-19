/** Revision-bound passive pagination over the actual Session event envelope. */
import { Context } from '@relay-harness/cordis'
import { createUserMessage } from '@relay-harness/rlh-llm'
import SessionStore, { SessionId } from '@relay-harness/rlh-session'
import { expect, it } from 'vitest'
import { readWorkHistory } from '../src/work-view.ts'

it('keeps older pages on the observed prefix across appends and rejects a replaced prefix', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('passive-history'))
    const add = (text: string) => session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' })
    add('first')
    add('second')
    const page = readWorkHistory(session.id, session.events, { sessionId: session.id, limit: 1 }, 5, 100)
    expect(page.rows.map(row => row.text)).toEqual(['second'])
    add('newer')
    const older = readWorkHistory(session.id, session.events, { sessionId: session.id, snapshot: page.snapshot, beforeSeq: page.nextBeforeSeq ?? 0 }, 5, 100)
    expect(older.rows.map(row => row.text)).toEqual(['first'])
    expect(older.snapshot).toEqual(page.snapshot)
    const replaced = [...structuredClone(session.events)]
    const first = replaced[0]
    if (first?.type !== 'user/message') throw new Error('fixture missing user message')
    replaced[0] = { ...first, data: { ...first.data, content: [{ type: 'text', text: 'replaced' }] } }
    expect(() => readWorkHistory(session.id, replaced, { sessionId: session.id, snapshot: page.snapshot }, 5, 100)).toThrow('observation changed')
    expect(() => readWorkHistory(SessionId('other'), session.events, { sessionId: SessionId('other'), snapshot: page.snapshot }, 5, 100)).toThrow('observation changed')
    expect(() => readWorkHistory(session.id, session.events, { sessionId: session.id, beforeSeq: -1 }, 5, 100)).toThrow('invalid history')
  } finally { await ctx.fiber.dispose() }
})
