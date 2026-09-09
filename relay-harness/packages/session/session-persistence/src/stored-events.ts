/** Stored-event vocabulary normalization, independent of backend and live-session lifetimes. */
import { adoptSessionEvent, snapshotSessionEvent } from '@relay-harness/rlh-session'
import type { SessionEvent, SessionId } from '@relay-harness/rlh-session'

/**
 * Reject events from an obsolete v0 vocabulary that this build cannot replay.
 * @param events - stored or incoming events to classify.
 * @param id - session identity used in refusal diagnostics.
 */
export function assertSupportedEvents(events: readonly SessionEvent[], id: SessionId): void {
  const legacyType: string = 'request/header-delta'
  const legacy = events.find(event => event.type === legacyType)
  if (legacy !== undefined) {
    throw new Error(`session "${id}" contains unsupported legacy request/header-delta event at seq ${legacy.seq}`)
  }
  const legacyModeType: string = 'mode/set'
  const legacyMode = events.find(event => event.type === legacyModeType)
  if (legacyMode !== undefined) {
    throw new Error(`session "${id}" contains unsupported legacy mode/set event at seq ${legacyMode.seq}`)
  }
  const fallback = events.find(event => event.type === 'request/header'
    && (event.data as { reason?: string }).reason === 'fallback')
  if (fallback !== undefined) {
    throw new Error(`session "${id}" contains unsupported legacy request/header reason "fallback" at seq ${fallback.seq}`)
  }
}

/** Return an object record without widening arrays into message payloads. */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Whether a record contains every required key and no key outside the optional extension set. */
function hasOnlyKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = [...required, ...optional]
  return Object.keys(record).every(key => allowed.includes(key))
    && required.every(key => Object.hasOwn(record, key))
}

type PersistedMessageId = SessionEvent<'user/message'>['data']['id']

/** Mint the stable import identity for a message persisted before identities existed. */
function legacyMessageId(id: SessionId, seq: number): PersistedMessageId {
  return `legacy-message:${id}:${seq}` as PersistedMessageId
}

/** Read a replacement target while leaving malformed surface metadata to the session validator. */
function replacementStart(event: SessionEvent): number | undefined {
  const op = asRecord((event as SessionEvent & { surfaceOp?: unknown }).surfaceOp)
  return op?.['op'] === 'replace' && typeof op['start'] === 'number'
    ? op['start']
    : undefined
}

/**
 * Whether one suffix event needs facts available only from the preceding stored prefix.
 * @param event - one stored suffix event before normalization.
 * @returns whether independent suffix normalization would lose prefix-owned identity.
 */
export function needsLegacyPrefix(event: SessionEvent): boolean {
  const data = asRecord(event.data)
  const legacySteeringType: string = 'steering/message'
  if (event.type === legacySteeringType) return true
  if (data === undefined) return false
  switch (event.type) {
    case 'user/message':
      return !Object.hasOwn(data, 'id') && Object.hasOwn(data, 'content')
    case 'assistant/message':
      return !Object.hasOwn(data, 'message') && Object.hasOwn(data, 'content')
    case 'tool/result':
      return !Object.hasOwn(data, 'message') && Object.hasOwn(data, 'callId')
    default:
      return false
  }
}

/** Upgrade the removed steering surface event into its current user-message equivalent. */
function migrateLegacySteeringEvent(event: SessionEvent, id: SessionId): SessionEvent {
  const legacyType: string = 'steering/message'
  if (event.type !== legacyType) return event
  const data = asRecord(event.data)
  if (data === undefined) {
    throw new Error(`session "${id}" contains malformed pre-react-loop steering/message at seq ${event.seq}`)
  }
  const wrapped = asRecord(data['message'])
  if (wrapped !== undefined && Number.isSafeInteger(data['turn'])
    && hasOnlyKeys(data, ['turn', 'message'])) {
    return { ...event, type: 'user/message', data: wrapped } as SessionEvent
  }
  if (!Number.isSafeInteger(data['turn']) || !hasOnlyKeys(data, ['turn', 'content', 'source'])) {
    throw new Error(`session "${id}" contains malformed pre-react-loop steering/message at seq ${event.seq}`)
  }
  const { turn: _turn, ...message } = data
  return {
    ...event,
    type: 'user/message',
    data: {
      ...message,
      id: legacyMessageId(id, event.seq),
      role: 'user',
    },
  } as SessionEvent
}

/** Remove the obsolete trigger after verifying the complete old turn-start envelope. */
function migrateLegacyTurnStartEvent(event: SessionEvent, id: SessionId): SessionEvent {
  if (event.type !== 'turn/start') return event
  const data = asRecord(event.data)
  if (data === undefined || !Object.hasOwn(data, 'trigger')) return event
  const trigger = asRecord(data['trigger'])
  if (!Number.isSafeInteger(data['turn']) || (data['turn'] as number) < 1
    || !hasOnlyKeys(data, ['turn', 'trigger'])
    || trigger === undefined || typeof trigger['kind'] !== 'string' || trigger['kind'].length === 0) {
    throw new Error(`session "${id}" contains malformed pre-react-loop turn/start at seq ${event.seq}`)
  }
  return { ...event, data: { turn: data['turn'] } } as SessionEvent
}

/** Upgrade an obsolete turn ending while preserving the latest-master envelope. */
function migrateLegacyTurnEndEvent(event: SessionEvent, id: SessionId): SessionEvent {
  if (event.type !== 'turn/end') return event
  const data = asRecord(event.data)
  /* v8 ignore next -- a non-record current envelope cannot match a legacy shape. */
  if (data === undefined) return event
  const malformed = (): never => {
    throw new Error(`session "${id}" contains malformed pre-react-loop turn/end at seq ${event.seq}`)
  }
  const reason = asRecord(data['reason'])
  if (!Number.isSafeInteger(data['turn']) || (data['turn'] as number) < 1
    || !hasOnlyKeys(data, ['turn', 'reason'])
    || reason === undefined || typeof reason['kind'] !== 'string') return malformed()

  let currentReason: Record<string, unknown> | undefined
  switch (reason['kind']) {
    case 'completed':
    case 'blocked':
    case 'max-tokens':
    case 'interrupted':
      if (!hasOnlyKeys(reason, ['kind'])) return malformed()
      return event
    case 'aborted':
      if (Object.hasOwn(reason, 'reason')) return event
      if (!hasOnlyKeys(reason, ['kind'])) return malformed()
      currentReason = { kind: 'aborted', reason: { kind: 'legacy' } }
      break
    case 'disposed':
      if (!hasOnlyKeys(reason, ['kind'])) return malformed()
      currentReason = { kind: 'aborted', reason: { kind: 'disposed' } }
      break
    case 'error': {
      if (Object.hasOwn(reason, 'error')) return event
      if (!Number.isSafeInteger(reason['step']) || (reason['step'] as number) < 0) return malformed()
      const failure = asRecord(reason['failure'])
      if (failure !== undefined && hasOnlyKeys(reason, ['kind', 'step', 'failure'])
        && hasOnlyKeys(failure, ['message', 'code'], ['status', 'providerRetryAfterMs', 'requestId'])
        && typeof failure['message'] === 'string' && typeof failure['code'] === 'string'
        && (failure['status'] === undefined || typeof failure['status'] === 'number')
        && (failure['providerRetryAfterMs'] === undefined || typeof failure['providerRetryAfterMs'] === 'number')
        && (failure['requestId'] === undefined || typeof failure['requestId'] === 'string')) {
        currentReason = { kind: 'error', error: failure }
        break
      }
      const messageKeys = reason['code'] === undefined
        ? ['kind', 'step', 'message']
        : ['kind', 'step', 'message', 'code']
      if (!hasOnlyKeys(reason, messageKeys)
        || typeof reason['message'] !== 'string'
        || (reason['code'] !== undefined && typeof reason['code'] !== 'string')) return malformed()
      currentReason = {
        kind: 'error',
        error: {
          message: reason['message'],
          code: typeof reason['code'] === 'string' ? reason['code'] : 'UNKNOWN',
        },
      }
      break
    }
    default:
      return event
  }

  return {
    ...event,
    data: {
      ...data,
      reason: currentReason,
    },
  } as SessionEvent
}

/**
 * Upgrade one pre-identity message event into the current wrapper shape.
 * Current-looking malformed events remain untouched so validation rejects them
 * instead of disguising corruption as legacy data.
 */
function migrateLegacyMessageEvent(
  event: SessionEvent,
  id: SessionId,
  messageIds: ReadonlyMap<number, PersistedMessageId>,
): SessionEvent {
  const data = asRecord(event.data)
  if (data === undefined) return event
  switch (event.type) {
    case 'user/message': {
      if (Object.hasOwn(data, 'id') || Object.hasOwn(data, 'role')
        || Object.hasOwn(data, 'message')
        || !Object.hasOwn(data, 'content') || !Object.hasOwn(data, 'source')) return event
      return {
        ...event,
        data: {
          ...data,
          id: legacyMessageId(id, event.seq),
          role: 'user',
        },
      } as SessionEvent
    }
    case 'assistant/message': {
      if (Object.hasOwn(data, 'message')
        || !Object.hasOwn(data, 'content') || !Object.hasOwn(data, 'provenance')) return event
      const { content, provenance, ...eventData } = data
      return {
        ...event,
        data: {
          ...eventData,
          message: {
            id: legacyMessageId(id, event.seq),
            role: 'assistant',
            content,
            source: {
              ...asRecord(provenance),
              kind: 'model',
            },
          },
        },
      } as SessionEvent
    }
    case 'tool/result': {
      if (Object.hasOwn(data, 'message')
        || !Object.hasOwn(data, 'callId') || !Object.hasOwn(data, 'content')
        || !Object.hasOwn(data, 'isError')) return event
      const { callId, content, isError, ...eventData } = data
      const inheritedId = replacementStart(event)
      return {
        ...event,
        data: {
          ...eventData,
          message: {
            id: inheritedId === undefined
              ? legacyMessageId(id, event.seq)
              : messageIds.get(inheritedId),
            role: 'user',
            content: [{
              type: 'tool-result',
              toolCallId: callId,
              content,
              isError,
            }],
            source: {
              kind: 'tool',
              callId,
            },
          },
        },
      } as SessionEvent
    }
    default:
      return event
  }
}

/** Read the identified message carried by one validated current event. */
function eventMessageId(event: SessionEvent): PersistedMessageId | undefined {
  const data = asRecord(event.data)
  const message = event.type === 'user/message' ? data : asRecord(data?.['message'])
  return typeof message?.['id'] === 'string' ? message['id'] as PersistedMessageId : undefined
}

/**
 * Materialize stored events as upgraded, validated snapshots with immutable messages.
 * @param events - borrowed stored events; the input remains unchanged.
 * @param id - session identity used by diagnostics and legacy message identities.
 * @returns newly allocated, normalized event snapshots.
 */
export function snapshotStoredEvents(events: readonly SessionEvent[], id: SessionId): SessionEvent[] {
  assertSupportedEvents(events, id)
  const messageIds = new Map<number, PersistedMessageId>()
  return events.map((event) => {
    const migratedStart = migrateLegacyTurnStartEvent(event, id)
    const migratedTurn = migrateLegacyTurnEndEvent(migratedStart, id)
    const migratedSteering = migrateLegacySteeringEvent(migratedTurn, id)
    const snapshot = snapshotSessionEvent(migrateLegacyMessageEvent(migratedSteering, id, messageIds))
    const messageId = eventMessageId(snapshot)
    if (messageId !== undefined) messageIds.set(snapshot.seq, messageId)
    return snapshot
  })
}

/**
 * Upgrade and validate an exclusively owned backend result without copying its array.
 * @param events - exclusive backend result whose entries may be replaced and whose identified messages are frozen.
 * @param id - session identity used by diagnostics and legacy message identities.
 * @returns the same array, containing normalized events with immutable identified messages.
 */
export function adoptStoredEvents(events: SessionEvent[], id: SessionId): SessionEvent[] {
  assertSupportedEvents(events, id)
  const messageIds = new Map<number, PersistedMessageId>()
  for (const [index, event] of events.entries()) {
    const migratedStart = migrateLegacyTurnStartEvent(event, id)
    const migratedTurn = migrateLegacyTurnEndEvent(migratedStart, id)
    const migratedSteering = migrateLegacySteeringEvent(migratedTurn, id)
    const adopted = adoptSessionEvent(migrateLegacyMessageEvent(migratedSteering, id, messageIds))
    events[index] = adopted
    const messageId = eventMessageId(adopted)
    if (messageId !== undefined) messageIds.set(adopted.seq, messageId)
  }
  return events
}
