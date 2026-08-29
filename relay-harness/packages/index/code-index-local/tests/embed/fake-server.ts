/**
 * Deterministic local embeddings endpoint for the embed suites.
 *
 * `node:http` server bound to `127.0.0.1:0`; vectors are derived from the
 * SHA-256 of each input text, so the same text always yields the same unit
 * vector and suites can assert exact stored bytes. A per-request behavior
 * script replays the provider failure modes the client must classify:
 * auth refusal, HTTP errors, non-JSON bodies, lying Content-Length, redirects,
 * and slow responses that outlive a deadline.
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'

/** One scripted behavior for the next request the fake endpoint receives. */
type FakeEmbedBehavior =
  /** Refuse the credential (default when the header is missing). */
  | 'unauthorized'
  /** Answer HTTP 500 with a JSON error body. */
  | 'http-error'
  /** Answer HTTP 500 with a plain-text (non-JSON) body. */
  | 'http-error-plain'
  /** Answer valid JSON but declare a Content-Length above the read ceiling. */
  | 'lying-content-length'
  /** Answer with a 302 redirect to another path. */
  | 'redirect'
  /** Delay the response long enough for a short deadline to fire. */
  | 'slow'
  /** Answer 200 with a JSON body that is not an embeddings reply. */
  | 'not-embeddings'
  /** Answer 200 with fewer embedding records than inputs. */
  | 'short-data'
  /** Answer 200 with an embeddings reply whose vectors have the wrong dim. */
  | 'wrong-dim'
  /** Answer 200 with a 200 text/plain body that is not JSON at all. */
  | 'non-json-2xx'
  /** Answer 200 with a valid embeddings reply. */
  | 'ok'

/** A started fake endpoint. */
export interface FakeEmbedServer {
  /** Base URL the client should be pointed at. */
  readonly url: string
  /** Requests received so far: method, path, auth header, parsed body. */
  readonly requests: Array<{ method: string; path: string; authorization?: string | undefined; body?: unknown }>
  /** Stop the server; resolves once closed. */
  close(): Promise<void>
}

/** Scripted server config: dimension of generated vectors and behavior queue. */
export interface FakeEmbedServerOptions {
  /** Vector dimension of generated embeddings (default 16). */
  readonly dim?: number
  /** Behaviors consumed in order; the last one repeats once the script ends. */
  readonly behaviors?: readonly FakeEmbedBehavior[]
}

/**
 * Start one fake embeddings endpoint.
 * @param options - dimension and the behavior script to replay.
 * @returns the running server; the caller owns `close()`.
 */
export async function startFakeEmbedServer(options: FakeEmbedServerOptions = {}): Promise<FakeEmbedServer> {
  const dim = options.dim ?? 16
  const behaviors = [...(options.behaviors ?? ['ok'])]
  const requests: FakeEmbedServer['requests'][number][] = []
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = ''
    request.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8')
    })
    request.on('end', () => {
      const path = request.url ?? ''
      const body = raw.length > 0 ? (JSON.parse(raw) as unknown) : undefined
      requests.push({
        method: request.method ?? '',
        path,
        authorization: request.headers.authorization,
        body,
      })
      const behavior = behaviors.length > 1 ? behaviors.shift() : behaviors[0]
      if (request.method !== 'POST' || path !== '/embeddings') {
        replyJson(response, 404, { error: { message: 'not found' } })
        return
      }
      const payload = body as { model?: unknown; input?: unknown } | undefined
      const inputs = Array.isArray(payload?.input)
        && payload.input.every((text): text is string => typeof text === 'string')
        ? payload.input
        : undefined
      if (typeof payload?.model !== 'string' || payload.model.length === 0 || inputs === undefined) {
        replyJson(response, 400, { error: { message: 'model and input (string array) are required' } })
        return
      }
      const auth = request.headers.authorization ?? ''
      if (!auth.startsWith('Bearer ') || auth.slice('Bearer '.length).length === 0) {
        replyJson(response, 401, { error: { message: 'missing bearer credential' } })
        return
      }
      switch (behavior) {
        case 'unauthorized':
          replyJson(response, 401, { error: { message: 'invalid api key' } })
          return
        case 'http-error':
          replyJson(response, 500, { error: { message: 'embedding backend exploded' } })
          return
        case 'http-error-plain':
          response.writeHead(500, { 'content-type': 'text/plain' })
          response.end('backend exploded, no json here')
          return
        case 'lying-content-length':
          // Valid small body; the declared length is what the client must catch.
          response.writeHead(200, { 'content-type': 'application/json', 'content-length': String(5 * 1024 * 1024) })
          response.end(JSON.stringify(embeddingsReply(inputs, dim)))
          return
        case 'redirect':
          response.writeHead(302, { location: '/elsewhere' })
          response.end()
          return
        case 'slow':
          setTimeout(() => {
            replyJson(response, 200, embeddingsReply(inputs, dim))
          }, 2_000)
          return
        case 'not-embeddings':
          replyJson(response, 200, { object: 'list', data: 'not-a-list' })
          return
        case 'short-data':
          replyJson(response, 200, embeddingsReply(inputs.slice(0, -1), dim))
          return
        case 'wrong-dim':
          replyJson(response, 200, {
            data: inputs.map(text => ({ embedding: vectorFor(text, dim + 1) })),
            usage: { prompt_tokens: 1 },
          })
          return
        case 'non-json-2xx':
          response.writeHead(200, { 'content-type': 'text/plain' })
          response.end('<html>not json</html>')
          return
        default:
          replyJson(response, 200, embeddingsReply(inputs, dim))
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fake embed server did not bind a port')
  let closed = false
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    // Idempotent: suites close in-test and again in afterEach sweeps.
    close: () => new Promise<void>((resolvePromise, rejectPromise) => {
      if (closed) {
        resolvePromise()
        return
      }
      closed = true
      server.close((error) => {
        if (error === undefined) resolvePromise()
        else rejectPromise(error)
      })
    }),
  }
}

/** Send one JSON reply with the given status. */
function replyJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

/** Assemble one valid embeddings reply for the inputs. */
function embeddingsReply(inputs: readonly string[], dim: number): unknown {
  return {
    object: 'list',
    data: inputs.map(text => ({ object: 'embedding', index: 0, embedding: vectorFor(text, dim) })),
    model: 'fake-embed',
    usage: { prompt_tokens: inputs.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0) },
  }
}

/**
 * The deterministic unit vector for one text: seed a xorshift32 generator
 * with the first four digest bytes, then normalize to unit length.
 */
function vectorFor(text: string, dim: number): number[] {
  const digest = createHash('sha256').update(text).digest()
  let state = digest.readUInt32LE(0)
  const next = (): number => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x1_0000_0000
  }
  const raw = Array.from({ length: dim }, next)
  const norm = Math.sqrt(raw.reduce((sum, value) => sum + value * value, 0))
  return raw.map(value => value / norm)
}
