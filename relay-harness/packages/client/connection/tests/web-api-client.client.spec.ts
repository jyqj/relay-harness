/**
 * WebApiClient.readWebSocket: the browser's only wire parser. Malformed JSON
 * and schema-invalid frames are dropped (console.error) while the stream
 * survives; abort tears the socket down in both CONNECTING and OPEN; a server
 * close before open ends the stream cleanly.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcMessage } from '../src/client/api.ts'
import type { SessionId } from '../src/client/api.ts'
import { WebApiClient } from '../src/client/web-api-client.ts'

type Win = { location?: { hostname: string; search: string; origin?: string } }
type WebSocketGlobal = { WebSocket?: typeof WebSocket }

const SID = 'fk-c1' as SessionId

const originalWebSocket = globalThis.WebSocket
const sockets: StubWebSocket[] = []

/** Manually driven socket: tests fire open/close/receive, no auto-open. */
class StubWebSocket extends EventTarget {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readyState = StubWebSocket.CONNECTING

  constructor(url: string | URL) {
    super()
    this.url = String(url)
    sockets.push(this)
  }

  open(): void {
    this.readyState = StubWebSocket.OPEN
    this.dispatchEvent(new Event('open'))
  }

  close(): void {
    if (this.readyState === StubWebSocket.CLOSED) return
    this.readyState = StubWebSocket.CLOSED
    this.dispatchEvent(new Event('close'))
  }

  receive(data: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data }))
  }
}

function muxRequest(rpcId: string, lastSeq = 0): string {
  return JSON.stringify({
    type: 'server-request',
    rpcId,
    method: 'session/subscribed',
    payload: { type: 'session/subscribed', sessionId: SID, lastSeq },
  })
}

afterEach(() => {
  delete (globalThis as Win).location
  sockets.length = 0
  if (originalWebSocket === undefined) delete (globalThis as WebSocketGlobal).WebSocket
  else globalThis.WebSocket = originalWebSocket
})

function start(): { client: WebApiClient; abort: AbortController; envelopes: RpcMessage[] } {
  ;(globalThis as Win).location = {
    hostname: 'localhost', search: '', origin: 'http://localhost:3080',
  }
  ;(globalThis as WebSocketGlobal).WebSocket = StubWebSocket as unknown as typeof WebSocket
  const client = new WebApiClient()
  const envelopes: RpcMessage[] = []
  client.subscribeEnvelopes((batch) => { envelopes.push(...batch) })
  return { client, abort: new AbortController(), envelopes }
}

describe('WebApiClient.readWebSocket', () => {
  it('survives a malformed JSON frame and yields the next valid one', async () => {
    const { client, abort, envelopes } = start()
    const iterator = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    sockets[0]!.open()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    sockets[0]!.receive('{"type":"server-request",')
    sockets[0]!.receive(muxRequest('after-garbage', 3))
    await expect(pending).resolves.toMatchObject({
      value: { rpcId: 'after-garbage', payload: { type: 'session/subscribed', lastSeq: 3 } },
    })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(envelopes.map(m => (m as { rpcId: string }).rpcId)).toEqual(['after-garbage'])
    abort.abort()
    errorSpy.mockRestore()
  })

  it('drops a schema-invalid frame and yields the subsequent valid one', async () => {
    const { client, abort, envelopes } = start()
    const iterator = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    sockets[0]!.open()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // Well-formed JSON whose payload fails muxFrameSchema (unknown frame tag).
    sockets[0]!.receive(JSON.stringify({
      type: 'server-request',
      rpcId: 'bad-payload',
      method: 'session/subscribed',
      payload: { type: 'session/unknown-tag', sessionId: SID },
    }))
    sockets[0]!.receive(muxRequest('after-invalid', 1))
    await expect(pending).resolves.toMatchObject({
      value: { rpcId: 'after-invalid', payload: { type: 'session/subscribed', lastSeq: 1 } },
    })
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(envelopes.map(m => (m as { rpcId: string }).rpcId)).toEqual(['after-invalid'])
    abort.abort()
    errorSpy.mockRestore()
  })

  it('closes the socket and ends the stream when aborted during CONNECTING', async () => {
    const { client, abort } = start()
    const iterator = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    expect(sockets[0]?.readyState).toBe(StubWebSocket.CONNECTING)
    abort.abort()
    await expect(pending).resolves.toMatchObject({ done: true })
    expect(sockets[0]?.readyState).toBe(StubWebSocket.CLOSED)
  })

  it('closes the socket and ends the stream when aborted during OPEN', async () => {
    const { client, abort } = start()
    let opened = 0
    const iterator = client.events.mux({}, abort.signal, () => { opened++ })[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    sockets[0]!.open()
    expect(opened).toBe(1)
    abort.abort()
    await expect(pending).resolves.toMatchObject({ done: true })
    expect(sockets[0]?.readyState).toBe(StubWebSocket.CLOSED)
  })

  it('ends the stream when the server closes before opening', async () => {
    const { client, abort } = start()
    let opened = 0
    const iterator = client.events.mux({}, abort.signal, () => { opened++ })[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => { expect(sockets).toHaveLength(1) })
    sockets[0]!.close()
    await expect(pending).resolves.toMatchObject({ done: true })
    expect(opened).toBe(0)
    expect(sockets[0]?.readyState).toBe(StubWebSocket.CLOSED)
  })
})
