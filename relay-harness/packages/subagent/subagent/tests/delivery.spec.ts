import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@relay-harness/rlh-llm'
import { Session, SessionId } from '@relay-harness/rlh-session'
import type {} from '../src/index.ts'
import {
  acceptedSubagentDelivery, acceptedSubagentReport, pendingSubagentDeliveries,
  pendingSubagentReports, subagentDeliveryNeedsClaim,
} from '../src/delivery.ts'

function message(text: string) {
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

describe('durable mailbox acknowledgement folds', () => {
  it('claims exact message identities while retaining caller retry receipts across restoration', () => {
    const session = Session.create(SessionId('delivery-fold'))
    const first = message('first'), second = message('second')
    session.append('subagent/delivery-accepted', { version: 1, idempotencyKey: 'first-key', message: first })
    session.append('subagent/delivery-accepted', { version: 1, idempotencyKey: 'second-key', message: second })
    session.append('subagent/delivery-claimed', { version: 1, messageId: second.id })
    expect(pendingSubagentDeliveries(session.events).map(item => item.message.id)).toEqual([first.id])
    expect(subagentDeliveryNeedsClaim(session.events, second.id)).toBe(false)
    session.append('user/message', first, { surfaceOp: 'append' })
    // The model-visible event prevents replay, but its missing explicit receipt
    // still needs repair after a crash between consumption and acknowledgement.
    expect(pendingSubagentDeliveries(session.events)).toEqual([])
    expect(subagentDeliveryNeedsClaim(session.events, first.id)).toBe(true)
    session.append('subagent/delivery-claimed', { version: 1, messageId: first.id })
    const restored = Session.fromRestore(session.id, structuredClone(session.events), structuredClone(session.header))
    expect(subagentDeliveryNeedsClaim(restored.events, first.id)).toBe(false)
    expect(pendingSubagentDeliveries(restored.events)).toEqual([])
    expect(acceptedSubagentDelivery(restored.events, 'first-key')?.message.id).toBe(first.id)
    expect(acceptedSubagentDelivery(restored.events, 'absent')).toBeUndefined()
  })

  it('acknowledges only the delivered report and preserves pending order and delivery mode', () => {
    const session = Session.create(SessionId('report-fold'))
    const first = message('quiet report'), second = message('steering report'), unrelated = message('unrelated')
    session.append('subagent/report-accepted', { version: 1, idempotencyKey: 'quiet', delivery: 'quiet', message: first })
    session.append('subagent/report-accepted', { version: 1, idempotencyKey: 'steering', delivery: 'next-step', message: second })
    session.append('subagent/report-delivered', { version: 1, messageId: unrelated.id })
    expect(pendingSubagentReports(session.events).map(item => item.delivery)).toEqual(['quiet', 'next-step'])
    session.append('subagent/report-delivered', { version: 1, messageId: first.id })
    session.append('subagent/report-delivered', { version: 1, messageId: first.id })
    const restored = Session.fromRestore(session.id, structuredClone(session.events), structuredClone(session.header))
    expect(pendingSubagentReports(restored.events).map(item => item.message.id)).toEqual([second.id])
    expect(acceptedSubagentReport(restored.events, 'quiet')?.message.id).toBe(first.id)
    expect(acceptedSubagentReport(restored.events, 'absent')).toBeUndefined()
  })
})
