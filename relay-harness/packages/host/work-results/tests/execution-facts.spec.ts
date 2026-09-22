import { describe, expect, it } from 'vitest'
import { SessionId } from '@relay-harness/rlh-session'
import { executionRelationship, executionRecovery } from '../src/execution-facts.ts'

const work = SessionId('work-root')
const peer = SessionId('peer-parent')

describe('execution relationship derivation', () => {
  it('marks the plain Work root as owned and separates control from adjacency', () => {
    expect(executionRelationship({ workSessionId: work, sessionId: work }, true))
      .toEqual({ kind: 'owned', controlLink: true })
  })

  it('names the fork origin of a Work whose own root was forked from a parent', () => {
    expect(executionRelationship({ workSessionId: work, sessionId: work, parentSessionId: peer }, false))
      .toEqual({ kind: 'forked-from', peerSessionId: peer, controlLink: false })
  })

  it('names the delegation origin of a Work whose own root is a subagent Session', () => {
    expect(executionRelationship({ workSessionId: work, sessionId: work, parentSessionId: peer, origin: 'subagent' }, true))
      .toEqual({ kind: 'delegated', peerSessionId: peer, controlLink: true })
  })

  it('splits one-shot delegations from continuable report channels among children', () => {
    const child = { workSessionId: work, sessionId: SessionId('child'), parentSessionId: work }
    expect(executionRelationship({ ...child, mode: 'one-shot' }, false))
      .toEqual({ kind: 'delegated', peerSessionId: work, controlLink: false })
    expect(executionRelationship({ ...child, mode: 'continuable' }, true))
      .toEqual({ kind: 'reports-to', peerSessionId: work, controlLink: true })
    // An unclassified diagnostic is still a delegation by its durable origin header, never a control grant.
    expect(executionRelationship(child, false))
      .toEqual({ kind: 'delegated', peerSessionId: work, controlLink: false })
  })
})

describe('execution recovery derivation', () => {
  it('promises persisted history and explicit resume for an ordinary Session and unknown for a delegated one', () => {
    expect(executionRecovery({ evidence: 'session', resident: true }))
      .toEqual({ history: 'persisted', resume: 'explicit', control: 'resident' })
    expect(executionRecovery({ evidence: 'session', resident: false, origin: 'subagent' }))
      .toEqual({ history: 'persisted', resume: 'unknown', control: 'none' })
  })

  it('keeps an unclassified child and a one-shot child away from resume claims', () => {
    expect(executionRecovery({ evidence: 'subagent', resident: false }))
      .toEqual({ history: 'unknown', resume: 'unknown', control: 'none' })
    expect(executionRecovery({ evidence: 'subagent', resident: false, mode: 'one-shot' }))
      .toEqual({ history: 'persisted', resume: 'unavailable', control: 'none' })
  })

  it('reports a continuable descriptor as an explicit resume path and a live child as resident', () => {
    expect(executionRecovery({ evidence: 'subagent', resident: false, mode: 'continuable' }))
      .toEqual({ history: 'persisted', resume: 'explicit', control: 'none' })
    expect(executionRecovery({ evidence: 'subagent', resident: true, mode: 'continuable' }))
      .toEqual({ history: 'persisted', resume: 'explicit', control: 'resident' })
  })

  it('keeps local Job history in-process, never resumable, and controllable only while running', () => {
    expect(executionRecovery({ evidence: 'job', resident: true }))
      .toEqual({ history: 'in-process', resume: 'unavailable', control: 'resident' })
    expect(executionRecovery({ evidence: 'job', resident: false }))
      .toEqual({ history: 'in-process', resume: 'unavailable', control: 'none' })
  })
})
