import { describe, expect, it } from 'vitest'
import {
  Session, SessionId, assertSessionPersistenceFence,
  captureSessionPersistenceFence, installSessionPersistenceFence,
} from '../src/index.ts'

describe('deferred persistence ownership', () => {
  it('refuses source-log growth after the ownership registration is retired', () => {
    const session = Session.create(SessionId('retired-source'))
    const uninstall = installSessionPersistenceFence(session, { token: 'owner', assertCurrent: () => {} })
    session.append('turn/start', { turn: 1 })
    uninstall()
    expect(() => session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })).toThrow(/retired/)
    expect(session.events).toHaveLength(1)
  })

  it('retains the exact captured proof after its Session registration is retired', () => {
    const session = Session.create(SessionId('captured-fence'))
    expect(captureSessionPersistenceFence(session)).toBeUndefined()
    let current = true
    const proof = {
      token: 'old-owner',
      assertCurrent: () => { if (!current) throw new Error('old owner lost') },
    }
    const uninstall = installSessionPersistenceFence(session, proof)
    const captured = captureSessionPersistenceFence(session)
    expect(captured).toBe(proof)
    captured?.assertCurrent()
    uninstall()
    current = false
    expect(captureSessionPersistenceFence(session)).toBe(proof)
    expect(() => { assertSessionPersistenceFence(session) }).toThrow(/retired/)
    expect(() => captured?.assertCurrent()).toThrow('old owner lost')

    const successor = { token: 'new-owner', assertCurrent: () => {} }
    expect(() => installSessionPersistenceFence(session, successor)).toThrow(/already has a persistence fence/)
    uninstall()
    expect(captureSessionPersistenceFence(session)).toBe(proof)
    expect(() => captured?.assertCurrent()).toThrow('old owner lost')
  })
})
