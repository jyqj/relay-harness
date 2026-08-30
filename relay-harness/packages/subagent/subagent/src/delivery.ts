/** Durable mailbox events and projection for continuable-subagent delivery. */

import type { MessageId, UserMessage } from '@relay-harness/rlh-llm'
import type { SessionEvent } from '@relay-harness/rlh-session'

/** Current durable mailbox event version. */
export const SUBAGENT_DELIVERY_VERSION = 1

/** One delivery committed before it enters the child inbox. */
export interface SubagentDeliveryAcceptedData {
  readonly version: typeof SUBAGENT_DELIVERY_VERSION
  readonly idempotencyKey: string
  readonly message: UserMessage
}

/** Receipt that the accepted message reached the child's model-visible log. */
export interface SubagentDeliveryClaimedData {
  readonly version: typeof SUBAGENT_DELIVERY_VERSION
  readonly messageId: MessageId
}

/**
 * Fold accepted entries not yet represented by an acknowledgement or user message.
 * @param events - one child's own durable event suffix.
 * @returns pending deliveries in acceptance order.
 */
export function pendingSubagentDeliveries(events: readonly SessionEvent[]): SubagentDeliveryAcceptedData[] {
  const accepted = new Map<MessageId, SubagentDeliveryAcceptedData>()
  for (const event of events) {
    if (event.type === 'subagent/delivery-accepted') {
      accepted.set(event.data.message.id, event.data)
    } else if (event.type === 'subagent/delivery-claimed') {
      accepted.delete(event.data.messageId)
    } else if (event.type === 'user/message') {
      accepted.delete(event.data.id)
    }
  }
  return [...accepted.values()]
}

/**
 * Find the accepted receipt for one caller idempotency key.
 * @param events - one child's own durable event suffix.
 * @param idempotencyKey - caller retry identity.
 * @returns the original accepted delivery, or undefined when the key is unused.
 */
export function acceptedSubagentDelivery(
  events: readonly SessionEvent[],
  idempotencyKey: string,
): SubagentDeliveryAcceptedData | undefined {
  return events.findLast(event => event.type === 'subagent/delivery-accepted'
    && event.data.idempotencyKey === idempotencyKey)?.data as SubagentDeliveryAcceptedData | undefined
}

/**
 * Whether a delivery has an accepted record but no explicit claimed receipt yet.
 * @param events - one child's own durable event suffix.
 * @param messageId - accepted message identity.
 * @returns whether an acknowledgement still needs to be appended.
 */
export function subagentDeliveryNeedsClaim(
  events: readonly SessionEvent[],
  messageId: MessageId,
): boolean {
  let accepted = false
  for (const event of events) {
    if (event.type === 'subagent/delivery-accepted' && event.data.message.id === messageId) accepted = true
    if (event.type === 'subagent/delivery-claimed' && event.data.messageId === messageId) accepted = false
  }
  return accepted
}
