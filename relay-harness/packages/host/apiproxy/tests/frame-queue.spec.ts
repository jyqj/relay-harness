/**
 * The mux frame queue's retention contract: bounded per-subscriber buffering,
 * overflow as a clean stream end (never a dropped or truncated frame), and
 * order-preserving drain.
 */

import { describe, expect, it } from 'vitest'
import { assertJsonArgs, DEFAULT_MUX_STREAM_BUFFER_BYTES, FrameQueue } from '../src/frame-queue.ts'

describe('FrameQueue', () => {
  it('rejects forwarded arguments that JSON serialization would silently discard', () => {
    const values = ['valid', undefined]
    expect(() => assertJsonArgs('test/lossy-forward', values))
      .toThrow('forwarded host event "test/lossy-forward" argument 1 is not lossless JSON data')
  })
  it('ends the iteration when a frame pushes retention past the byte budget', async () => {
    const queue = new FrameQueue<{ text: string }>(64)
    let cleanups = 0
    const abort = new AbortController()
    const iterator = queue.iterate(abort.signal, () => { cleanups += 1 })[Symbol.asyncIterator]()

    queue.push({ text: 'first' })
    const first = await iterator.next()
    expect(first.done).toBe(false)

    // The oversized frame itself is still delivered; the queue then ends
    // rather than buffering without bound.
    queue.push({ text: 'x'.repeat(128) })
    const delivered = await iterator.next()
    expect(delivered.done).toBe(false)
    const after = await iterator.next()
    expect(after.done).toBe(true)

    queue.push({ text: 'after-end' })
    expect(cleanups).toBe(1)
  })

  it('measures multibyte frames by UTF-8 bytes, not code units', async () => {
    // Four CJK characters are 12 UTF-8 bytes but only 4 code units: a code-unit
    // measure would let this frame through a 10-byte budget.
    const queue = new FrameQueue<{ text: string }>(10)
    const abort = new AbortController()
    const iterator = queue.iterate(abort.signal, () => {})[Symbol.asyncIterator]()

    queue.push({ text: '中中中中' })
    const first = await iterator.next()
    expect(first.done).toBe(false)
    const after = await iterator.next()
    expect(after.done).toBe(true)
    abort.abort()
    await iterator.next()
  })

  it('holds at the exact budget and ends only when it is exceeded', async () => {
    const frame = (n: number): { n: number } => ({ n })
    const budget = Buffer.byteLength(JSON.stringify(frame(0)))
    const queue = new FrameQueue<ReturnType<typeof frame>>(budget)
    const abort = new AbortController()
    const iterator = queue.iterate(abort.signal, () => {})[Symbol.asyncIterator]()

    queue.push(frame(0))
    const first = await iterator.next()
    expect(first.done).toBe(false)
    // Drained fully before the next push, so the total is at — not over — the
    // budget again, and the queue stays open.
    queue.push(frame(1))
    const second = await iterator.next()
    expect(second.done).toBe(false)
    abort.abort()
    await iterator.next()
  })

  it('drains frames in push order and keeps accepting pushes after a full drain', async () => {
    const queue = new FrameQueue<{ n: number }>(1024 * 1024)
    const abort = new AbortController()
    const iterator = queue.iterate(abort.signal, () => {})[Symbol.asyncIterator]()
    const seen: number[] = []

    for (let n = 0; n < 24; n += 1) {
      queue.push({ n })
      const next = await iterator.next()
      if (next.done) throw new Error('queue ended early')
      seen.push(next.value.n)
    }
    // A burst buffered while nobody pulls still drains in order.
    for (let n = 24; n < 32; n += 1) queue.push({ n })
    for (let n = 24; n < 32; n += 1) {
      const next = await iterator.next()
      if (next.done) throw new Error('queue ended early')
      seen.push(next.value.n)
    }
    abort.abort()
    await iterator.next()
    expect(seen).toEqual(Array.from({ length: 32 }, (_, index) => index))
  })

  it('defaults the subscriber budget to a positive integer', () => {
    expect(Number.isSafeInteger(DEFAULT_MUX_STREAM_BUFFER_BYTES)).toBe(true)
    expect(DEFAULT_MUX_STREAM_BUFFER_BYTES).toBeGreaterThan(0)
  })
})
