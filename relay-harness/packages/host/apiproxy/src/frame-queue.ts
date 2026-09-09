/**
 * Mux-carrier plumbing: the async frame queue, forwarded-event JSON narrowing,
 * and the session-subscription baseline frame.
 * @module @relay-harness/rlh-host-apiproxy/frame-queue
 */

import { isJsonValue } from '@relay-harness/rlh-session'
import type { JsonValue, Session } from '@relay-harness/rlh-session'
import type { MuxFrame, RpcRequest } from './api/index.ts'
import { frame } from './rpc-envelope.ts'

/**
 * Default byte budget for one subscriber's frame buffer (`muxStreamBufferBytes`
 * config). Single frames are bounded far below this by the session-log's own
 * output limits, so a healthy consumer never approaches it while a stalled one
 * cannot grow past it.
 */
export const DEFAULT_MUX_STREAM_BUFFER_BYTES = 8 * 1024 * 1024

/** One buffered frame and its serialized size, measured once at push time. */
interface FrameQueueEntry<F> { item: F; bytes: number }

/**
 * Simple async queue: core callbacks push, the AsyncIterable pulls; abort/return cleans up.
 *
 * Retention contract: the queue holds frames until they are pulled, up to the
 * constructor's `maxBytes` of serialized JSON. A push that would exceed the
 * budget ends the queue instead of buffering — the frame that crossed the
 * budget is still delivered, then the stream closes. It never drops or
 * truncates individual frames: a silently dropped delta would corrupt the
 * client's incremental fold, while a closed event stream makes the SSE client
 * reconnect and re-baseline. The mux re-open replays only the baseline
 * (subscription, queue, jobs, pending) — events emitted inside the closed
 * window are not resent; the client recovers them through the subscribed
 * frame's tail check and its repairGap tail-page backfill.
 */
export class FrameQueue<F> {
  private buffer: FrameQueueEntry<F>[] = []
  private head = 0
  private waiter: (() => void) | undefined
  private done = false
  private totalBytes = 0

  /**
   * @param maxBytes - serialized-byte ceiling on retained frames; a push that
   * exceeds it ends the queue (see the class retention contract).
   */
  constructor(private readonly maxBytes: number) {}

  /**
   * Enqueue one frame and wake a waiting iterator; frames pushed after `end()`
   * are dropped. A frame that pushes the retained total past `maxBytes` ends
   * the queue.
   * @param item - the frame to enqueue.
   */
  push(item: F): void {
    if (this.done) return
    // The SSE layer serializes the same frame right after this, so this is the
    // one honest measure of the retained value.
    const bytes = Buffer.byteLength(JSON.stringify(item))
    this.buffer.push({ item, bytes })
    this.totalBytes += bytes
    this.waiter?.()
    if (this.totalBytes > this.maxBytes) this.end()
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
        while (this.head < this.buffer.length) {
          const entry = this.buffer[this.head++] as FrameQueueEntry<F>
          this.totalBytes -= entry.bytes
          if (this.head === this.buffer.length) {
            this.buffer = []
            this.head = 0
          }
          yield entry.item
        }
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
