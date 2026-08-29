import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@relay-harness/rlh-llm'
import { Session, SessionId } from '@relay-harness/rlh-session'
import { EvidenceId, SourceId } from '@relay-harness/rlh-context-engine'
import { contextInspectorProjectionDefinition } from '../src/projection.ts'

describe('contextInspector projection', () => {
  it('links admitted user messages and retains rejected/coverage/evidence facts', () => {
    const session = Session.create(SessionId('context-inspector'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const admitted = createUserMessage({ content: [{ type: 'text', text: 'hydrated source context' }], source: { kind: 'user' } })
    const linked = session.append('user/message', admitted, { surfaceOp: 'append' })
    session.append('context/prepared', {
      turn: 1, step: 1, contributions: [
        { contributorId: 'files', messageId: admitted.id, messageEventSeqs: [linked.seq], evidence: [{ evidenceId: EvidenceId('ev:file'), resource: { sourceId: SourceId('files'), key: 'chunk:a', revision: 'h1' }, truncated: false, freshness: 'current', verification: 'verified', domain: { filePath: 'src/a.ts', selectionReason: ['explicit reference'] } }], coverage: { searched: ['src/a.ts'], notSearched: ['vendor'], rationale: 'explicit scope', completeness: 'bounded' } },
        { contributorId: 'code', messageId: 'rewritten' as typeof admitted.id, messageEventSeqs: [], evidence: [], coverage: { searched: ['index'], notSearched: [], completeness: 'best-effort' } },
      ],
    })
    let state = contextInspectorProjectionDefinition.init()
    for (const event of session.events) state = contextInspectorProjectionDefinition.apply(state, event)
    const view = contextInspectorProjectionDefinition.view(state)
    expect(view.traces).toHaveLength(1)
    expect(view.traces[0]).toMatchObject({ admittedContributions: 1, rejectedContributions: 1, evidenceCount: 1 })
    expect(view.traces[0]?.contributions[0]).toMatchObject({ admitted: true, linkedMessages: [{ seq: linked.seq, preview: 'hydrated source context' }] })
    expect(view.traces[0]?.contributions[0]?.evidence[0]).toMatchObject({ whyUsed: ['explicit reference'], path: 'src/a.ts', resource: { key: 'chunk:a' } })
    expect(view.traces[0]?.contributions[1]).toMatchObject({ admitted: false, linkedMessages: [] })
  })
})
