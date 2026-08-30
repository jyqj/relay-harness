/**
 * Newline-delimited JSON-RPC 2.0 over byte streams. Frames with `id` and
 * `method` are requests, `id` alone is a response, and `method` alone is a
 * notification. Malformed lines are ignored; handler failures become error frames.
 *
 * @module @relay-harness/rlh-sdk-protocol/transport
 */

import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

type JsonRpcId = string | number
type RequestHandler = (method: string, params: Record<string, unknown>) => Promise<unknown>
type NotificationHandler = (method: string, params: Record<string, unknown>) => void

/** Default bound for one newline-delimited JSON-RPC frame (64 MiB). */
export const DEFAULT_JSON_RPC_MAX_FRAME_BYTES = 64 * 1024 * 1024
/** Default aggregate bound: one maximum frame plus its newline delimiter. */
export const DEFAULT_JSON_RPC_MAX_QUEUED_WRITE_BYTES = 64 * 1024 * 1024 + 1

/** Resource limits for one line transport. */
export interface JsonRpcLineTransportOptions {
  /** Maximum UTF-8 bytes in one inbound or outbound frame. */
  maxFrameBytes?: number
  /** Maximum UTF-8 bytes retained across unsettled output writes. */
  maxQueuedWriteBytes?: number
}

/** A peer or caller attempted to send one frame above the configured limit. */
export class JsonRpcFrameTooLargeError extends Error {
  /**
   * @param bytes - observed frame bytes.
   * @param limit - configured maximum frame bytes.
   */
  constructor(readonly bytes: number, readonly limit: number) {
    super(`JSON-RPC frame exceeds ${limit} bytes (${bytes})`)
    this.name = 'JsonRpcFrameTooLargeError'
  }
}

/** Outbound writes exceeded the configured unsettled-byte budget. */
export class JsonRpcWriteQueueOverflowError extends Error {
  /**
   * @param bytes - aggregate bytes the new frame would retain.
   * @param limit - configured maximum unsettled bytes.
   */
  constructor(readonly bytes: number, readonly limit: number) {
    super(`JSON-RPC write queue exceeds ${limit} bytes (${bytes})`)
    this.name = 'JsonRpcWriteQueueOverflowError'
  }
}

/** A JSON-RPC error response, preserving the wire `code` and optional `data`. */
export class JsonRpcResponseError extends Error {
  /**
   * @param code - the wire error code, or `undefined` when the peer sent none.
   * @param message - the wire error message.
   * @param data - the optional structured error payload, verbatim.
   */
  constructor(readonly code: number | undefined, message: string, readonly data?: unknown) {
    super(message)
    this.name = 'JsonRpcResponseError'
  }
}

/**
 * Outbound request and notification surface used by the runtime server and
 * SDK clients.
 */
export interface JsonRpcTransportPeer {
  /**
   * Send a request and await its response.
   * @param method - the JSON-RPC method name.
   * @param params - the request parameters object.
   * @returns the result; rejects with {@link JsonRpcResponseError} on an error
   * response, and with a plain `Error` on a write failure or closure.
   */
  request(method: string, params: object): Promise<unknown>
  /**
   * Send a notification; omitted params produce no `params` member.
   * @param method - the JSON-RPC method name.
   * @param params - the optional notification parameters object.
   */
  notify(method: string, params?: object): void
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/**
 * Line-delimited endpoint over caller-owned streams. {@link start} attaches
 * listeners; {@link close} detaches them and rejects pending requests without
 * destroying the streams. Missing request handlers return `-32601`; handler
 * failures return `-32603`. Notifications without a handler are dropped.
 */
export class JsonRpcLineTransport implements JsonRpcTransportPeer {
  private buffer = ''
  private bufferBytes = 0
  private readonly decoder = new StringDecoder('utf8')
  private started = false
  private requestHandler: RequestHandler | undefined
  private notificationHandler: NotificationHandler | undefined
  private failureHandler: ((error: Error) => void) | undefined
  private readonly pending = new Map<JsonRpcId, PendingRequest>()
  private readonly maxFrameBytes: number
  private readonly maxQueuedWriteBytes: number
  private unsettledWriteBytes = 0
  private failure: Error | undefined
  private observableFailure = false

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    options: JsonRpcLineTransportOptions = {},
  ) {
    this.maxFrameBytes = positiveLimit(
      options.maxFrameBytes,
      DEFAULT_JSON_RPC_MAX_FRAME_BYTES,
      'maxFrameBytes',
    )
    this.maxQueuedWriteBytes = positiveLimit(
      options.maxQueuedWriteBytes,
      DEFAULT_JSON_RPC_MAX_QUEUED_WRITE_BYTES,
      'maxQueuedWriteBytes',
    )
  }

  /** Attach the input listeners and begin reading frames. Idempotent. */
  start(): void {
    if (this.started) return
    this.started = true
    this.input.on('data', this.onData)
    this.input.on('error', this.onInputError)
    this.input.on('end', this.onInputEnd)
  }

  /**
   * Detach listeners and reject pending requests. Safe before {@link start}.
   */
  close(): void {
    this.input.off('data', this.onData)
    this.input.off('error', this.onInputError)
    this.input.off('end', this.onInputEnd)
    this.failPending(new Error('JSON-RPC transport closed'))
  }

  /**
   * Observe terminal input/output failures, including resource-limit refusal.
   * @param handler - replaces the prior failure observer.
   */
  onFailure(handler: (error: Error) => void): void {
    this.failureHandler = handler
    if (this.failure !== undefined && this.observableFailure) handler(this.failure)
  }

  /**
   * Install the request handler, replacing any prior handler.
   * @param handler - resolves to the response `result`; a rejection becomes a
   * `-32603` error response carrying the message.
   */
  onRequest(handler: RequestHandler): void {
    this.requestHandler = handler
  }

  /**
   * Install the notification handler, replacing any prior handler.
   * @param handler - invoked per notification with the method and normalized
   * params object.
   */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler
  }

  /**
   * Send a request and await its response.
   * @param method - the JSON-RPC method name.
   * @param params - the request parameters object.
   * @param signal - optional abandonment signal: aborting removes the pending
   * entry (no state is retained for a response that may never come) and
   * rejects with the signal's reason.
   * @returns the result; rejects per {@link JsonRpcTransportPeer.request}.
   */
  request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    const id = `req_${randomUUID().replaceAll('-', '')}`
    const message = { jsonrpc: '2.0', id, method, params }
    return new Promise((resolve, reject) => {
      let detach = (): void => {}
      if (signal !== undefined) {
        if (signal.aborted) {
          reject(abortError(signal.reason))
          return
        }
        const onAbort = (): void => {
          this.pending.delete(id)
          reject(abortError(signal.reason))
        }
        signal.addEventListener('abort', onAbort, { once: true })
        detach = () => { signal.removeEventListener('abort', onAbort) }
      }
      this.pending.set(id, {
        resolve: (value) => {
          detach()
          resolve(value)
        },
        reject: (error) => {
          detach()
          reject(error)
        },
      })
      try {
        this.write(message)
      } catch (error) {
        this.pending.delete(id)
        detach()
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  notify(method: string, params?: object): void {
    this.write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params })
  }

  /**
   * Wait for prior frame write callbacks. The empty barrier emits no bytes.
   * @returns a promise that settles with the output write callback.
   */
  flush(): Promise<void> {
    if (this.failure !== undefined) return Promise.reject(this.failure)
    return new Promise<void>((resolve, reject) => {
      try {
        this.output.write('', (error) => {
          if (error) {
            const failure = normalizeError(error)
            this.fail(failure)
            reject(failure)
          } else resolve()
        })
      } catch (error) {
        const failure = normalizeError(error)
        this.fail(failure)
        reject(failure)
      }
    })
  }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.failure !== undefined) return
    this.bufferBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength
    this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    if (!this.drainLines()) return
    if (this.bufferBytes > this.maxFrameBytes) {
      this.fail(new JsonRpcFrameTooLargeError(this.bufferBytes, this.maxFrameBytes))
    }
  }

  private drainLines(): boolean {
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const rawLine = this.buffer.slice(0, newline)
      const lineBytes = Buffer.byteLength(rawLine, 'utf8')
      if (lineBytes > this.maxFrameBytes) {
        this.fail(new JsonRpcFrameTooLargeError(lineBytes, this.maxFrameBytes))
        return false
      }
      const consumed = this.buffer.slice(0, newline + 1)
      const line = rawLine.trim()
      this.buffer = this.buffer.slice(newline + 1)
      this.bufferBytes = Math.max(0, this.bufferBytes - Buffer.byteLength(consumed, 'utf8'))
      if (!line) continue
      void this.handleLine(line).catch((error: unknown) => { this.fail(normalizeError(error)) })
    }
    return true
  }

  private readonly onInputError = (error: Error): void => {
    this.fail(error)
  }

  private readonly onInputEnd = (): void => {
    if (this.failure !== undefined) return
    this.buffer += this.decoder.end()
    if (!this.drainLines()) return
    if (this.bufferBytes > this.maxFrameBytes) {
      this.fail(new JsonRpcFrameTooLargeError(this.bufferBytes, this.maxFrameBytes))
      return
    }
    this.fail(new Error('JSON-RPC input closed'), false)
  }

  private async handleLine(line: string): Promise<void> {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      // Only JSON syntax errors reach this catch; malformed peer lines are ignored.
      return
    }
    if (!message || typeof message !== 'object') return
    const frame = message as Record<string, unknown>
    const id = frame.id
    const method = frame.method
    if ((typeof id === 'string' || typeof id === 'number') && typeof method === 'string') {
      await this.handleIncomingRequest(id, method, objectParams(frame.params))
      return
    }
    if (typeof id === 'string' || typeof id === 'number') {
      this.handleIncomingResponse(id, frame)
      return
    }
    if (typeof method === 'string') {
      this.notificationHandler?.(method, objectParams(frame.params))
    }
  }

  private async handleIncomingRequest(id: JsonRpcId, method: string, params: Record<string, unknown>): Promise<void> {
    const handler = this.requestHandler
    if (!handler) {
      this.writeError(id, -32601, `method not found: ${method}`)
      return
    }
    try {
      const result = await handler(method, params)
      this.write({ jsonrpc: '2.0', id, result })
    } catch (error) {
      this.writeError(id, -32603, error instanceof Error ? error.message : String(error))
    }
  }

  private handleIncomingResponse(id: JsonRpcId, frame: Record<string, unknown>): void {
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    if (frame.error && typeof frame.error === 'object') {
      const error = frame.error as Record<string, unknown>
      pending.reject(new JsonRpcResponseError(
        typeof error.code === 'number' ? error.code : undefined,
        typeof error.message === 'string' ? error.message : 'JSON-RPC error',
        error.data,
      ))
      return
    }
    pending.resolve(frame.result)
  }

  private writeError(id: JsonRpcId, code: number, message: string): void {
    this.write({ jsonrpc: '2.0', id, error: { code, message } })
  }

  private write(message: Record<string, unknown>): void {
    if (this.failure !== undefined) throw this.failure
    const frame = `${JSON.stringify(message)}\n`
    const bytes = Buffer.byteLength(frame, 'utf8')
    if (bytes - 1 > this.maxFrameBytes) throw new JsonRpcFrameTooLargeError(bytes - 1, this.maxFrameBytes)
    const retained = this.unsettledWriteBytes + bytes
    if (retained > this.maxQueuedWriteBytes) {
      throw new JsonRpcWriteQueueOverflowError(retained, this.maxQueuedWriteBytes)
    }
    this.unsettledWriteBytes = retained
    try {
      this.output.write(frame, (error) => {
        this.unsettledWriteBytes = Math.max(0, this.unsettledWriteBytes - bytes)
        if (error) this.fail(normalizeError(error))
      })
    } catch (error) {
      this.unsettledWriteBytes = Math.max(0, this.unsettledWriteBytes - bytes)
      throw normalizeError(error)
    }
  }

  private fail(error: Error, observable = true): void {
    if (this.failure !== undefined) return
    this.failure = error
    this.observableFailure = observable
    this.input.off('data', this.onData)
    this.input.off('error', this.onInputError)
    this.input.off('end', this.onInputEnd)
    this.failPending(error)
    if (observable) this.failureHandler?.(error)
  }

  private failPending(error: Error): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const waiter of pending) waiter.reject(error)
  }
}

/** Normalize JSON-RPC `params` to a plain object (arrays and scalars collapse to `{}`). */
function objectParams(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {}
}

/** Normalize an abort reason into the rejection Error (a non-Error reason is stringified). */
function abortError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(`JSON-RPC request aborted: ${String(reason)}`)
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError(`JSON-RPC ${name} must be a positive safe integer`)
  }
  return resolved
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
