import { describe, expect, it } from 'vitest'
import {
  CallId,
  createToolResultMessage,
  createUserMessage,
} from '@relay-harness/rlh-llm'
import { Session, SessionId } from '@relay-harness/rlh-session'
import { collectExtractionSources } from '../src/sources.ts'

function sessionWithRoute(): Session {
  const id = SessionId('extract-source')
  const session = Session.create(id, [], { version: 0, id, createdAt: 1, cwd: '/workspace', agentPreset: 'standard' })
  session.append('request/header', {
    header: { config: { provider: 'main', model: 'main' } },
    reason: 'initial',
  })
  return session
}

function appendResult(
  session: Session,
  seq: { turn: number; step: number },
  name: string,
  text: string,
  isError = false,
): void {
  const callId = CallId(`call-${name}-${session.events.length}`)
  const call = session.append('tool/call', { ...seq, callId, name, arguments: '{}' })
  session.append('tool/result', {
    ...seq,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError }),
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
}

const config = {
  verifiedToolNames: new Set(['bash', 'read']),
  maxSourceChars: 1_000,
  maxInputChars: 10_000,
}

describe('completed-turn extraction sources', () => {
  it('keeps direct user and successful results while excluding derived, failed, reasoning, and secret sources', () => {
    const session = sessionWithRoute()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'Remember that the codename is cobalt.' }],
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      source: { kind: 'plugin', plugin: 'prior-memory', form: 'recall' },
      content: [{ type: 'text', text: 'derived memory echo' }],
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'api_key = abcdefghijklmnop' }],
    }), { surfaceOp: 'append' })
    appendResult(session, { turn: 1, step: 1 }, 'bash', 'tests passed')
    appendResult(session, { turn: 1, step: 1 }, 'read', 'failed read', true)
    appendResult(session, { turn: 1, step: 1 }, 'web_search', 'external release note')
    appendResult(session, { turn: 1, step: 1 }, 'memory_search', 'old memory')
    const callId = CallId('reasoning-result')
    const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({ callId, content: [{ type: 'reasoning', text: 'private' }], isError: false }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const collected = collectExtractionSources(session, 1, config)

    expect(collected?.route).toEqual({ provider: 'main', model: 'main' })
    expect(collected?.sourceHash).toMatch(/^[0-9a-f]{64}$/)
    expect(collected?.sources.map(source => [source.kind, source.toolName, source.text, source.evidence.verification]))
      .toEqual([
        ['user', undefined, 'Remember that the codename is cobalt.', 'user-statement'],
        ['tool-result', 'bash', 'tests passed', 'successful-tool-result'],
        ['tool-result', 'web_search', 'external release note', 'external-observation'],
      ])
  })

  it('uses an explicit route and prioritizes user evidence under a complete input budget', () => {
    const session = sessionWithRoute()
    session.append('turn/start', { turn: 2 })
    appendResult(session, { turn: 2, step: 1 }, 'web_search', 'x'.repeat(200))
    session.append('user/message', createUserMessage({
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'User fact survives.' }],
    }), { surfaceOp: 'append' })
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const collected = collectExtractionSources(session, 2, {
      provider: 'extract',
      model: 'extract',
      verifiedToolNames: new Set(),
      maxSourceChars: 100,
      maxInputChars: 1_600,
    })
    expect(collected?.route).toEqual({ provider: 'extract', model: 'extract' })
    expect(collected?.sources.some(source => source.kind === 'user')).toBe(true)
    const external = collected?.sources.find(source => source.toolName === 'web_search')
    expect(external?.text).toBe('x'.repeat(100))
    expect(external?.evidence.excerpt).toBe('x'.repeat(100))
  })

  it('returns no work without a closed turn, eligible source, or route', () => {
    const noTurn = sessionWithRoute()
    expect(collectExtractionSources(noTurn, 1, config)).toBeUndefined()
    const id = SessionId('no-route')
    const noRoute = Session.create(id)
    noRoute.append('turn/start', { turn: 1 })
    noRoute.append('user/message', createUserMessage({
      source: { kind: 'user' }, content: [{ type: 'text', text: 'fact' }],
    }), { surfaceOp: 'append' })
    noRoute.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(collectExtractionSources(noRoute, 1, config)).toBeUndefined()
  })
})
