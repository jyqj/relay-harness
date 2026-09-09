import { describe, expect, it } from 'vitest'
import { CallId, createToolResultMessage } from '@relay-harness/rlh-llm'
import { Session, SessionId, type SessionEvent } from '@relay-harness/rlh-session'

function resultData(producedFiles: unknown, isError = false) {
  return {
    turn: 1, step: 1, producedFiles,
    message: createToolResultMessage({ callId: CallId('c1'), content: [{ type: 'text', text: 'done' }], isError }),
  }
}

describe('durable produced-file capture', () => {
  it('snapshots and restores captured paths without putting them in model content', () => {
    const session = Session.create(SessionId('captured'))
    const paths = ['output.md']
    const data = resultData(paths) as SessionEvent<'tool/result'>['data']
    session.append('tool/result', data, { surfaceOp: 'append' })
    paths.push('later.md')
    const restored = Session.fromRestore(session.id, structuredClone(session.events), structuredClone(session.header))
    const event = restored.events[0]
    expect(event?.type).toBe('tool/result')
    if (event?.type !== 'tool/result') throw new Error('result missing')
    expect(event.data.producedFiles).toEqual(['output.md'])
    expect(event.data.message.content[0].content).toEqual([{ type: 'text', text: 'done' }])
    expect(Object.isFrozen(event.data.producedFiles)).toBe(true)
  })

  it.each([null, 'path.md', [42], { path: 'file.md' }])('rejects malformed durable capture %s when restoring untrusted log data', (paths) => {
    const session = Session.create(SessionId('malformed'))
    const data = resultData(paths) as SessionEvent<'tool/result'>['data']
    const seed = [{ type: 'tool/result', seq: 0, time: 0, data, surfaceOp: 'append' }] as SessionEvent[]
    expect(() => Session.fromRestore(session.id, seed, structuredClone(session.header))).toThrow(/producedFiles/)
    expect(session.events).toHaveLength(0)
  })

  it('rejects a failed result carrying successful mutation capture', () => {
    const session = Session.create(SessionId('failed'))
    const seed = [{ type: 'tool/result', seq: 0, time: 0, data: resultData(['not-produced.md'], true), surfaceOp: 'append' }] as SessionEvent[]
    expect(() => Session.fromRestore(session.id, seed, structuredClone(session.header))).toThrow(/successful/)
  })
})
