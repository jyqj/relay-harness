import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { CallId, createToolResultMessage, createUserMessage } from '@relay-harness/rlh-llm'
import SessionStore, { Session, SessionId } from '@relay-harness/rlh-session'
import SessionProjectionRegistry from '@relay-harness/rlh-session-projection'
import { deliverablesProjection } from '../src/projection.ts'

let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined })

async function harness() {
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(Object.assign((inner: Context) => { inner.sessionProjections.register(deliverablesProjection) }, { inject: ['sessionProjections'] }))
  return ctx
}

function result(session: Session, paths?: readonly string[], isError = false) {
  const callId = CallId(`call-${session.seq}`)
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'write', arguments: '{}' })
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'done' }], isError }),
    ...paths === undefined ? {} : { producedFiles: paths },
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
}

describe('durable whole-session deliverables', () => {
  it('rebuilds early outputs from the restored log without depending on the last history page', async () => {
    const host = await harness()
    const session = host.sessions.create(SessionId('whole-inventory'))
    result(session, ['first.md', 'first.md'])
    for (let i = 0; i < 75; i++) {
      session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `later ${i}` }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    }
    const restored = Session.fromRestore(session.id, structuredClone(session.events), structuredClone(session.header))
    expect(restored.events.slice(-50).some(event => event.type === 'tool/result')).toBe(false)
    expect(host.sessionProjections.snapshot(restored).values.deliverables).toEqual({ paths: ['first.md'], unindexedResults: 0 })
  })

  it('distinguishes uncaptured legacy success from captured empty and ignores failed calls', async () => {
    const host = await harness()
    const session = host.sessions.create(SessionId('mixed'))
    result(session)
    result(session, [])
    result(session, ['failed.md'], true)
    result(session, ['done.md'])
    result(session, ['done.md'])
    expect(host.sessionProjections.snapshot(session).values.deliverables).toEqual({ paths: ['done.md'], unindexedResults: 1 })
    const changes: unknown[] = []
    const off = host.sessionProjections.onChanged((_session, key, value) => { if (key === 'deliverables') changes.push(value) })
    result(session, [])
    for (let i = 0; i < 100; i++) session.append('turn/start', { turn: i + 1 })
    expect(changes).toEqual([])
    off()
  })
})
