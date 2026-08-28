/**
 * Unary-RPC envelope micro-helpers shared by every api-proxy handler: ok/err
 * result wrapping, frame minting, live abort reads, and message-boundary
 * pagination.
 * @module @relay-harness/rlh-host-apiproxy/rpc-envelope
 */

import { randomUUID } from 'node:crypto'
import { isAppendSurfaceEvent } from '@relay-harness/rlh-session'
import type { SessionEvent } from '@relay-harness/rlh-session'
import type { RpcError, RpcRequest, RpcResponse } from './api/rpc.ts'
import { RpcId } from './api/rpc.ts'

/** Conversation message event types (the pagination counting unit). */
export const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])

/**
 * Read live abort state across awaits without treating it as synchronously
 * immutable.
 * @param signal - the abort signal to read.
 * @returns whether the signal is currently aborted.
 */
export function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * Message-boundary pagination: count maxMessages append-origin messages
 * backwards from the window tail. Replacement copies never entered the
 * conversation a reader sees — they restate a shadowed range for the model
 * alone — so they consume no quota; the page stays one contiguous raw range,
 * which keeps a compaction's log-only `compaction/summary` record on the same page as its
 * replacement. The cut is the starting seq of the oldest message group (chunks
 * group via sourceEventSeqs — never cut mid-message). The tail page naturally
 * includes the in-progress partial.
 * @param events - the durable events to page.
 * @param beforeSeq - exclusive upper seq bound; undefined pages from the newest event.
 * @param maxMessages - message budget counted backwards from the window tail.
 * @returns the contiguous event page and whether older events remain.
 */
export function paginate(
  events: readonly SessionEvent[],
  beforeSeq: number | undefined,
  maxMessages: number,
): { events: SessionEvent[]; hasMore: boolean } {
  const window = beforeSeq === undefined ? [...events] : events.filter(event => event.seq < beforeSeq)
  let count = 0
  let cut = 0
  for (let i = window.length - 1; i >= 0; i--) {
    const event = window[i] as SessionEvent
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    count++
    const sources = (event as { sourceEventSeqs?: number[] }).sourceEventSeqs
    let groupStart = event.seq
    if (sources !== undefined) {
      for (const source of sources) {
        if (source < groupStart) groupStart = source
      }
    }
    if (count >= maxMessages) {
      cut = groupStart
      break
    }
  }
  const page = window.filter(event => event.seq >= cut)
  return { events: page, hasMore: cut > 0 }
}

/**
 * Wrap an ok result echoing the request's rpcId.
 * @param request - the request whose rpcId the response echoes.
 * @param value - the successful result value.
 * @returns the ok-wrapped response.
 */
export function ok<T>(request: RpcRequest<unknown>, value: T): RpcResponse<T> {
  return { rpcId: request.rpcId, result: { ok: true, value } }
}

/**
 * Wrap an error result echoing the request's rpcId.
 * @param request - the request whose rpcId the response echoes.
 * @param error - the failure to deliver.
 * @returns the error-wrapped response.
 */
export function err<T>(request: RpcRequest<unknown>, error: RpcError): RpcResponse<T> {
  return { rpcId: request.rpcId, result: { ok: false, error } }
}

/**
 * Mint a server-initiated frame with a fresh rpcId.
 * @param payload - the mux event to carry.
 * @returns the framed request.
 */
export function frame<F>(payload: F): RpcRequest<F> {
  return { rpcId: RpcId(randomUUID()), payload }
}
