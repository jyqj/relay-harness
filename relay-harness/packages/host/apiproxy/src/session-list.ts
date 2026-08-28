/**
 * Session-list projections: exact metadata folds for attached sessions,
 * size-gated cold blank probes, and the SessionSummary rows both serve.
 * @module @relay-harness/rlh-host-apiproxy/session-list
 */

import { stat } from 'node:fs/promises'
import type { Context } from '@relay-harness/cordis'
import type { Session, SessionEvent, SessionHeader, SessionId, SessionOrigin } from '@relay-harness/rlh-session'
import type { SessionPersistence } from '@relay-harness/rlh-session-persistence'
import { resolveSessionPreset } from '@relay-harness/rlh-agent-presets'
import type { SessionListMetadata, SessionSummary } from './api/index.ts'

/** Default maximum artifact size eligible for one cold blankness read. */
export const DEFAULT_COLD_BLANK_PROBE_MAX_BYTES = 1024

/**
 * Whether the session's conversation has started: no turn has run yet (a
 * turn is one model-loop execution). Standalone plugin events — command
 * lifecycle records, plan/mode, titles, goals — never open a turn, so
 * running `/plan` or `/goal` on a fresh session keeps it blank
 * (list-hidden, reusable).
 * @param session - the attached session to test.
 * @returns whether no turn has started in the conversation.
 */
export function sessionBlank(session: Session): boolean {
  return !session.events.some(event => event.type === 'turn/start')
}

/**
 * Advance the Session-list hint projection by one committed event.
 * @param state - the projection state before the event.
 * @param event - the newly committed event.
 * @returns the advanced state, or the same object when nothing changed.
 */
export function applySessionListMetadata(state: SessionListMetadata, event: SessionEvent): SessionListMetadata {
  const blank = state.blank && event.type !== 'turn/start'
  const lastPromptAt = event.type === 'user/message' && event.data.source.kind === 'user'
    ? event.time
    : state.lastPromptAt
  return blank === state.blank && lastPromptAt === state.lastPromptAt
    ? state
    : { blank, lastPromptAt }
}

/**
 * Fold exact list metadata for an attached Session.
 * @param events - the session's committed events, oldest first.
 * @returns the folded blankness and last-prompt state.
 */
export function sessionListMetadata(events: readonly SessionEvent[]): SessionListMetadata {
  let state: SessionListMetadata = { blank: true, lastPromptAt: null }
  for (const event of events) state = applySessionListMetadata(state, event)
  return state
}

/** Sort by creation or latest human prompt, whichever is newer. */
function sessionListUpdatedAt(header: SessionHeader, metadata: SessionListMetadata | undefined): number {
  return Math.max(header.createdAt, metadata?.lastPromptAt ?? 0)
}

/**
 * Shared Session-header projection for list baselines and creation frames.
 * @param header - the session's durable header.
 * @param events - the session's events; the preset resolves from the log when present.
 * @returns the optional identity fields, unset keys omitted.
 */
export function sessionListFields(header: SessionHeader, events: readonly SessionEvent[] = []): {
  parentSessionId?: SessionId
  seedLength?: number
  origin?: SessionOrigin
  cwd?: string
  agentPreset?: string
} {
  // The preset comes from the log, not the header: a session that switched
  // while blank ran its turns under the newer composition, and a picker
  // showing the creation-time value would contradict what the model saw.
  const agentPreset = resolveSessionPreset({ header, events })
  return {
    ...header.parentSession === undefined ? {} : { parentSessionId: header.parentSession },
    ...header.seedLength === undefined ? {} : { seedLength: header.seedLength },
    ...header.origin === undefined ? {} : { origin: header.origin },
    ...header.cwd === undefined ? {} : { cwd: header.cwd },
    ...agentPreset === undefined ? {} : { agentPreset },
  }
}

/**
 * SessionSummary projection for attached (in-memory) sessions.
 * @param session - the in-memory session to project.
 * @param running - whether a turn is currently executing.
 * @returns the list row for the session.
 */
export function summarize(session: Session, running: boolean): SessionSummary {
  const metadata = sessionListMetadata(session.events)
  return {
    sessionId: session.id,
    updatedAt: sessionListUpdatedAt(session.header, metadata),
    running,
    blank: metadata.blank,
    ...sessionListFields(session.header, session.events),
  }
}

/**
 * Verify a possibly blank cold Session only when its physical artifact passes
 * the configured per-Session size check. A stale `blank: true`, an
 * absent cache row, a large or location-less artifact, and read failures all
 * resolve to visible (`false`); listing must never hide a conversation on a
 * cache hint or an unavailable optimization.
 */
async function probeColdSessionMetadata(
  ctx: Context,
  persistence: SessionPersistence,
  meta: SessionHeader,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<SessionListMetadata | undefined> {
  if (maxBytes === 0) return undefined
  signal?.throwIfAborted()
  const location = persistence.locate(meta)
  if (location === undefined) return undefined
  signal?.throwIfAborted()
  let size: number
  try {
    size = (await stat(location.path)).size
  } catch {
    signal?.throwIfAborted()
    return undefined
  }
  if (size > maxBytes) return undefined
  try {
    const { events } = await persistence.readFrom(meta.id, 0, signal)
    signal?.throwIfAborted()
    return sessionListMetadata(events)
  } catch (error) {
    signal?.throwIfAborted()
    ctx.logger.warn(`session.list: blank probe for "${meta.id}" failed (serving it as visible): ${String(error)}`)
    return undefined
  }
}

/**
 * SessionSummary projection for a cold persisted Session.
 * @param ctx - the host context, used for probe failure logging.
 * @param persistence - the store locating and reading the cold artifact.
 * @param meta - the session's durable header.
 * @param metadata - the cached list metadata, when one exists.
 * @param blankProbeMaxBytes - artifact size ceiling for the blank probe; 0 disables probing.
 * @param signal - aborts the probe read.
 * @returns the list row for the cold session, never running.
 */
export async function summarizeCold(
  ctx: Context,
  persistence: SessionPersistence,
  meta: SessionHeader,
  metadata: SessionListMetadata | undefined,
  blankProbeMaxBytes: number,
  signal?: AbortSignal,
): Promise<SessionSummary> {
  const probed = metadata?.blank === false
    ? undefined
    : await probeColdSessionMetadata(ctx, persistence, meta, blankProbeMaxBytes, signal)
  return {
    sessionId: meta.id,
    updatedAt: sessionListUpdatedAt(meta, probed ?? metadata),
    running: false,
    blank: metadata?.blank === false ? false : probed?.blank ?? false,
    // Header-only: reading the log for a blank-window preset switch would
    // defeat the same index read, and attaching the session replaces this row
    // with `summarize()`, which resolves the switch from the events.
    ...sessionListFields(meta),
  }
}
