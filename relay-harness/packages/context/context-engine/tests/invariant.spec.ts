import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { createUserMessage } from '@relay-harness/rlh-llm'
import SessionStore, { SessionId } from '@relay-harness/rlh-session'
import InvariantRegistry from '@relay-harness/rlh-invariants'
import { EvidenceId, SourceId, type ContextPreparedEventData } from '@relay-harness/rlh-context-engine'
import * as ContextEngineInvariant from '@relay-harness/rlh-context-engine/invariant'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantRegistry, { enabled: true })
  await ctx.plugin(ContextEngineInvariant)
  return ctx
}

function trace(messageId: string, messageEventSeqs: readonly number[] = [2]): ContextPreparedEventData {
  return {
    turn: 1,
    step: 1,
    contributions: [{
      contributorId: 'files',
      messageId: messageId as ContextPreparedEventData['contributions'][number]['messageId'],
      messageEventSeqs,
      evidence: [{
        evidenceId: EvidenceId('file:one'),
        resource: { sourceId: SourceId('files'), key: 'one', revision: 'r1' },
        truncated: false,
        freshness: 'current',
        verification: 'verified',
      }],
      coverage: { searched: ['one'], notSearched: [], completeness: 'exhaustive' },
    }],
  }
}

describe('context-engine durable trace invariants', () => {
  it('accepts an open-step trace that references its earlier exact user message', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('valid-context-trace'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const message = createUserMessage({ content: [{ type: 'text', text: 'context' }], source: { kind: 'user' } })
    session.append('user/message', message, { surfaceOp: 'append' })

    expect(() => session.append('context/prepared', trace(message.id))).not.toThrow()
  })

  it('rejects a trace outside its named open step', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('closed-context-trace'))
    session.append('turn/start', { turn: 1 })

    expect(() => session.append('context/prepared', trace('missing', [])))
      .toThrow(/without that open step/)
  })

  it('rejects a reference to a non-message seq or a different message id', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('bad-context-link'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const message = createUserMessage({ content: [{ type: 'text', text: 'context' }], source: { kind: 'user' } })
    session.append('user/message', message, { surfaceOp: 'append' })

    expect(() => session.append('context/prepared', trace('other')))
      .toThrow(/names message other/)
    expect(() => session.append('context/prepared', trace(message.id, [1])))
      .toThrow(/outside its owning step/)
  })

  it('rejects previous-step links and a second trace inside the same open step', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('wrong-step-context-link'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const previous = createUserMessage({ content: [{ type: 'text', text: 'previous' }], source: { kind: 'user' } })
    session.append('user/message', previous, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('step/start', { turn: 1, step: 2 })
    const current = createUserMessage({ content: [{ type: 'text', text: 'current' }], source: { kind: 'user' } })
    session.append('user/message', current, { surfaceOp: 'append' })

    expect(() => session.append('context/prepared', {
      ...trace(previous.id, [2]),
      step: 2,
    })).toThrow(/outside its owning step/)
    session.append('context/prepared', { ...trace(current.id, [5]), step: 2 })
    expect(() => session.append('context/prepared', { ...trace(current.id, [5]), step: 2 }))
      .toThrow(/repeats the preparation trace/)
  })
})
