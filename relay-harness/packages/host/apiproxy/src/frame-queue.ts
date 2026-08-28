/**
 * Mux-carrier plumbing: the async frame queue, forwarded-event JSON narrowing,
 * and the session-subscription baseline frame.
 * @module @relay-harness/rlh-host-apiproxy/frame-queue
 */

import { isJsonValue } from '@relay-harness/rlh-session'
import type { JsonValue, Session } from '@relay-harness/rlh-session'
import type { MuxFrame, RpcRequest } from './api/index.ts'
import { frame } from './rpc-envelope.ts'

/** Simple async queue: core callbacks push, the AsyncIterable pulls; abort/return cleans up. */
export class FrameQueue<F> {
  private buffer: F[] = []
  private waiter: (() => void) | undefined
  private done = false

  /**
   * Enqueue one frame and wake a waiting iterator; frames pushed after `end()`
   * are dropped.
   * @param item - the frame to enqueue.
   */
  push(item: F): void {
    if (this.done) return
    this.buffer.push(item)
    this.waiter?.()
  }

  /** Mark the queue finished: buffered frames still drain, later pushes are dropped. */
  end(): void {
    this.done = true
    this.waiter?.()
  }

  /**
   * Drain buffered frames, then wait per frame until pushed or ended; abort or
   * early return always removes the abort listener and runs `cleanup`.
   * @param signal - aborting ends the iteration after the buffer drains.
   * @param cleanup - teardown run once when the generator finishes or is abandoned.
   * @returns an async generator yielding frames in push order.
   */
  async *iterate(signal: AbortSignal, cleanup: () => void): AsyncGenerator<F> {
    const onAbort = (): void => { this.end() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (true) {
        while (this.buffer.length > 0) yield this.buffer.shift() as F
        if (this.done || signal.aborted) return
        await new Promise<void>((resolve) => { this.waiter = resolve })
        this.waiter = undefined
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      cleanup()
    }
  }
}


/**
 * Narrow one allowlisted host event's argument list to the JSON values the
 * wrapper frame carries. A rejected argument is an allowlist mistake (the
 * forwarded path applies no projection), not hostile input, so it throws rather
 * than degrading to a lossy frame. The throw surfaces where the forwarding
 * listener runs, so the emitter's own listener containment logs it and drops
 * that frame — loud in the Host log, not at load or at the emit. Every
 * currently allowlisted event has a statically JSON-safe payload, so a
 * type-legal `ctx.emit` cannot reach the rejection branch.
 * @param event - forwarded host event name, named in the failure.
 * @param args - the emitter's argument list.
 * @returns the same arguments typed as JSON values.
 */
export function assertJsonArgs(event: string, args: readonly unknown[]): JsonValue[] {
  for (const [index, arg] of args.entries()) {
    if (!isJsonValue(arg)) {
      throw new Error(`forwarded host event "${event}" argument ${index} is not lossless JSON data`)
    }
  }
  return args as JsonValue[]
}

/**
 * Queue the subscription baseline frame.
 * @param queue - the mux carrier's frame queue.
 * @param session - the session the subscriber attaches to.
 */
export function subscribeSession(queue: FrameQueue<RpcRequest<MuxFrame>>, session: Session): void {
  queue.push(frame({ type: 'session/subscribed', sessionId: session.id, lastSeq: session.seq - 1 }))
}
