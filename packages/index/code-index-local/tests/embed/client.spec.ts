import { afterEach, describe, expect, it } from 'vitest'
import { TimeoutReason } from '@relay-harness/rlh-timeout'
import { EmbeddingClient } from '../../src/embed/client.ts'
import type { EmbeddingClientOptions } from '../../src/embed/client.ts'
import {
  EmbedError,
  EMBED_ABORTED,
  EMBED_DIMENSION_MISMATCH,
  EMBED_INVALID_CREDENTIAL,
  EMBED_PROVIDER_ERROR,
  EMBED_RESPONSE_INVALID,
  EMBED_TIMEOUT,
} from '../../src/embed/errors.ts'
import { startFakeEmbedServer, type FakeEmbedServer } from './fake-server.ts'

const servers: FakeEmbedServer[] = []

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close()
})

/** Start one fake endpoint plus a client pointed at it. */
async function start(
  behaviors?: NonNullable<Parameters<typeof startFakeEmbedServer>[0]>['behaviors'],
  clientOptions: Partial<ConstructorParameters<typeof EmbeddingClient>[0]> = {},
) {
  const server = await startFakeEmbedServer({ dim: 16, ...(behaviors === undefined ? {} : { behaviors }) })
  servers.push(server)
  const client = new EmbeddingClient({
    baseURL: server.url,
    apiKey: 'test-key',
    model: 'fake-embed',
    batchSize: 2,
    timeoutMs: 2_000,
    maxInputsPerRequest: 2,
    ...clientOptions,
  })
  return { server, client }
}

/** Run a promise and return its rejection typed as EmbedError. */
async function rejected(run: () => Promise<unknown>): Promise<EmbedError> {
  return await run().then(
    () => {
      throw new Error('expected the call to reject')
    },
    (error: unknown) => error as EmbedError,
  )
}

describe('EmbeddingClient construction', () => {
  it('refuses a blank or header-illegal API key with EMBED_INVALID_CREDENTIAL', () => {
    for (const apiKey of ['   ', 'bad\nkey', 'tab\tkey']) {
      expect(() => new EmbeddingClient(clientOptions(apiKey, 'http://127.0.0.1:1'))).toThrow(EmbedError)
      let code: string | undefined
      try {
        new EmbeddingClient(clientOptions(apiKey, 'http://127.0.0.1:1'))
      } catch (error: unknown) {
        code = (error as EmbedError).code
      }
      expect(code).toBe(EMBED_INVALID_CREDENTIAL)
    }
  })

  it('accepts a padded key and trims it for the wire header', async () => {
    const { server, client } = await start(undefined, { apiKey: '  test-key  ' })
    await client.embed(['hello'])
    expect(server.requests[0]?.authorization).toBe('Bearer test-key')
  })
})

/** Minimal option set for construction-only probes. */
function clientOptions(apiKey: string, baseURL: string): EmbeddingClientOptions {
  return { baseURL, apiKey, model: 'm', batchSize: 1, timeoutMs: 1_000, maxInputsPerRequest: 1 }
}

describe('EmbeddingClient happy path', () => {
  it('returns one deterministic vector per input in order with accumulated usage', async () => {
    const { server, client } = await start()
    const texts = ['alpha', 'beta', 'gamma']
    const result = await client.embed(texts)
    expect(result.vectors).toHaveLength(3)
    expect(result.promptTokens).toBe(texts.reduce((sum, text) => sum + Math.ceil(text.length / 4), 0))
    for (const vector of result.vectors) {
      expect(vector).toBeInstanceOf(Float32Array)
      expect(vector.length).toBe(16)
    }
    const alphaAgain = (await client.embed(['alpha'])).vectors[0]!
    expect([...alphaAgain]).toEqual([...result.vectors[0]!])
    await server.close()
  })

  it('splits inputs into wire requests of min(batchSize, maxInputsPerRequest)', async () => {
    const { server, client } = await start(undefined, { batchSize: 8, maxInputsPerRequest: 2 })
    await client.embed(['a', 'b', 'c', 'd', 'e'])
    expect(server.requests).toHaveLength(3)
    expect(server.requests.map(request => (request.body as { input: string[] }).input))
      .toEqual([['a', 'b'], ['c', 'd'], ['e']])
    expect((server.requests[0]?.body as { model: string }).model).toBe('fake-embed')
    await server.close()
  })

  it('sends dimensions only when configured, and skips the network for an empty input', async () => {
    const { server, client } = await start(undefined, { dimensions: 16 })
    expect(await client.embed([])).toEqual({ vectors: [], promptTokens: 0 })
    await client.embed(['a'])
    expect(server.requests).toHaveLength(1)
    expect((server.requests[0]?.body as { dimensions?: number }).dimensions).toBe(16)
    await server.close()
  })

  it('keeps the bearer and JSON content headers on every wire request', async () => {
    const { server, client } = await start()
    await client.embed(['one', 'two', 'three'])
    expect(server.requests.every(request => request.authorization === 'Bearer test-key')).toBe(true)
    await server.close()
  })
})

describe('EmbeddingClient failure classification', () => {
  it('maps HTTP 401 to EMBED_PROVIDER_ERROR carrying the endpoint detail', async () => {
    const { server, client } = await start(['unauthorized'])
    const error = await rejected(() => client.embed(['x']))
    expect(error.code).toBe(EMBED_PROVIDER_ERROR)
    expect(error.message).toBe('invalid api key')
    await server.close()
  })

  it('falls back to the status message when an HTTP error body is not JSON', async () => {
    const { server, client } = await start(['http-error-plain'])
    const error = await rejected(() => client.embed(['x']))
    expect(error.code).toBe(EMBED_PROVIDER_ERROR)
    expect(error.message).toContain('HTTP 500')
    await server.close()
  })

  it('maps a transport failure (connection refused) to EMBED_PROVIDER_ERROR', async () => {
    // Port 1 on loopback is closed by convention; nothing listens there.
    const client = new EmbeddingClient(clientOptions('k', 'http://127.0.0.1:1'))
    const error = await rejected(() => client.embed(['x']))
    expect(error.code).toBe(EMBED_PROVIDER_ERROR)
    expect(error.cause).toBeInstanceOf(Error)
  })

  it('refuses a 302 redirect as EMBED_PROVIDER_ERROR', async () => {
    const { server, client } = await start(['redirect'])
    const error = await rejected(() => client.embed(['x']))
    expect(error.code).toBe(EMBED_PROVIDER_ERROR)
    await server.close()
  })

  it('classifies a caller abort before the first request as EMBED_ABORTED', async () => {
    const { server, client } = await start()
    const controller = new AbortController()
    controller.abort()
    const error = await rejected(() => client.embed(['x'], controller.signal))
    expect(error.code).toBe(EMBED_ABORTED)
    expect(server.requests).toHaveLength(0)
    await server.close()
  })

  it('classifies a deadline overrun as EMBED_TIMEOUT with the timeout message', async () => {
    const { server, client } = await start(['slow'], { timeoutMs: 50 })
    const error = await rejected(() => client.embed(['x']))
    expect(error.code).toBe(EMBED_TIMEOUT)
    expect(error.message).toContain('timed out after 50ms')
    await server.close()
  })

  it('carries earlier batches billed spend on a mid-call failure and none on a first-batch failure', async () => {
    // Batch 1 answers, batch 2 hits the deadline: the billed spend survives.
    const { server, client } = await start(['ok', 'slow'], { timeoutMs: 50 })
    const error = await rejected(() => client.embed(['aaaa', 'bbbb', 'cc']))
    expect(error.code).toBe(EMBED_TIMEOUT)
    expect(error.promptTokensUsed).toBe(2)
    await server.close()

    // A first-batch failure has no earlier spend to carry.
    const { server: cold, client: coldClient } = await start(['slow'], { timeoutMs: 50 })
    const coldError = await rejected(() => coldClient.embed(['x']))
    expect(coldError.code).toBe(EMBED_TIMEOUT)
    expect(coldError.promptTokensUsed).toBeUndefined()
    await cold.close()
  })

  it('maps a lying Content-Length above the read ceiling to EMBED_RESPONSE_INVALID', async () => {
    const { server, client } = await start(['lying-content-length'])
    const error = await rejected(() => client.embed(['x']))
    expect(error.code).toBe(EMBED_RESPONSE_INVALID)
    expect(error.message).toContain('more than')
    await server.close()
  })

  it('maps a non-embeddings and a non-JSON 2xx body to EMBED_RESPONSE_INVALID', async () => {
    const { server, client } = await start(['not-embeddings'])
    const error = await rejected(() => client.embed(['x']))
    expect(error.code).toBe(EMBED_RESPONSE_INVALID)
    expect(error.message).toContain('no embedding records')
    await server.close()

    const { server: plain, client: plainClient } = await start(['non-json-2xx'])
    const parseError = await rejected(() => plainClient.embed(['x']))
    expect(parseError.code).toBe(EMBED_RESPONSE_INVALID)
    expect(parseError.message).toContain('unparsable JSON body')
    await plain.close()
  })

  it('maps a record-count mismatch to EMBED_RESPONSE_INVALID', async () => {
    const { server, client } = await start(['short-data'], { batchSize: 2, maxInputsPerRequest: 2 })
    const error = await rejected(() => client.embed(['x', 'y']))
    expect(error.code).toBe(EMBED_RESPONSE_INVALID)
    expect(error.message).toContain('1 embedding records for 2 inputs')
    await server.close()
  })

  it('maps a wrong-dimension reply to EMBED_DIMENSION_MISMATCH', async () => {
    const { server, client } = await start(['wrong-dim'], { dimensions: 16 })
    const error = await rejected(() => client.embed(['x']))
    expect(error.code).toBe(EMBED_DIMENSION_MISMATCH)
    expect(error.message).toContain('17-dimensional vector where 16 was expected')
    await server.close()
  })

  it('locks the dimension on the first reply when none is configured, then enforces it', async () => {
    const { server, client } = await start(['ok', 'wrong-dim'])
    const first = (await client.embed(['first'])).vectors[0]!
    expect(first.length).toBe(16)
    const error = await rejected(() => client.embed(['second']))
    expect(error.code).toBe(EMBED_DIMENSION_MISMATCH)
    await server.close()
  })
})

describe('EmbeddingClient bounded reads over injected transports', () => {
  it('rejects a streamed body that outgrows the ceiling regardless of its declared length', async () => {
    const oversized = new Uint8Array(4 * 1024 * 1024 + 1)
    const response = new Response(new Blob([oversized]), { status: 200, headers: { 'content-length': '16' } })
    const client = streamingClient(response)
    const error = await rejected(() => client.embed(['x']))
    expect(error.code).toBe(EMBED_RESPONSE_INVALID)
    expect(error.message).toContain('more than')
  })

  it('treats a body-less 2xx reply as an invalid response', async () => {
    const client = streamingClient(new Response(null, { status: 200 }))
    const error = await rejected(() => client.embed(['x']))
    expect(error.code).toBe(EMBED_RESPONSE_INVALID)
    expect(error.message).toContain('unparsable JSON body')
  })

  it('surfaces an abort raised while reading an HTTP error body as EMBED_ABORTED', async () => {
    const body = new Response('{"error":{"message":"late"}}', { status: 500 })
    Object.defineProperty(body, 'json', {
      value: () => Promise.reject(new DOMException('aborted mid error body', 'AbortError')),
    })
    const client = streamingClient(body)
    const error = await rejected(() => client.embed(['x']))
    expect(error.code).toBe(EMBED_ABORTED)
    expect(error.message).toBe('the embedding request was aborted')
  })

  it('keeps the status message when an error body carries no usable detail', async () => {
    const client = streamingClient(new Response('{}', {
      status: 503,
      headers: { 'content-type': 'application/json' },
    }))
    const error = await rejected(() => client.embed(['x']))
    expect(error.code).toBe(EMBED_PROVIDER_ERROR)
    expect(error.message).toBe('the embedding endpoint answered HTTP 503')
  })

  it('reads a flat top-level error message when no error object is present', async () => {
    const client = streamingClient(new Response(JSON.stringify({ message: 'rate limited, flat' }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    }))
    const error = await rejected(() => client.embed(['x']))
    expect(error.code).toBe(EMBED_PROVIDER_ERROR)
    expect(error.message).toBe('rate limited, flat')
  })

  it('ignores an empty error-object message and keeps the status message', async () => {
    const client = streamingClient(new Response(JSON.stringify({ error: { message: '' } }), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    }))
    const error = await rejected(() => client.embed(['x']))
    expect(error.message).toBe('the embedding endpoint answered HTTP 500')
  })

  it('refuses a data record without a usable numeric vector', async () => {
    for (const body of ['{"data":[null],"usage":{}}', '{"data":[{"embedding":["x",true]}],"usage":{}}']) {
      const client = streamingClient(new Response(body, { status: 200 }))
      const error = await rejected(() => client.embed(['x']))
      expect(error.code).toBe(EMBED_RESPONSE_INVALID)
      expect(error.message).toContain('no usable vector for input 1 of 1')
    }
  })

  it('surfaces a deadline raised while reading an HTTP error body as the timeout message', async () => {
    const body = new Response('{"error":{"message":"never read"}}', { status: 500 })
    Object.defineProperty(body, 'json', {
      value: () => Promise.reject(new TimeoutReason('EMBED_REQUEST_TIMEOUT', 1_000)),
    })
    const client = streamingClient(body)
    const error = await rejected(() => client.embed(['x']))
    expect(error.code).toBe(EMBED_TIMEOUT)
    expect(error.message).toContain('timed out after')
  })

  it('keeps the status message when the error body read fails for a non-abort reason', async () => {
    const body = new Response('{"error":{"message":"never read"}}', { status: 500 })
    Object.defineProperty(body, 'json', { value: () => Promise.reject(new TypeError('stream reset')) })
    const client = streamingClient(body)
    const error = await rejected(() => client.embed(['x']))
    expect(error.code).toBe(EMBED_PROVIDER_ERROR)
    expect(error.message).toBe('the embedding endpoint answered HTTP 500')
  })

  it('counts missing or non-numeric usage as zero prompt tokens', async () => {
    const client = streamingClient(new Response('{"data":[{"embedding":[1,2]}],"usage":{"prompt_tokens":"many"}}', {
      status: 200,
    }))
    const result = await client.embed(['x'])
    expect(result.vectors[0]!.length).toBe(2)
    expect(result.promptTokens).toBe(0)
  })

  it('classifies a mid-flight caller abort as EMBED_ABORTED', async () => {
    const { server, client } = await start(['slow'])
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort()
    }, 50)
    const error = await rejected(() => client.embed(['x'], controller.signal))
    expect(error.code).toBe(EMBED_ABORTED)
    expect(error.message).toBe('the embedding request was aborted')
    await server.close()
  })
})

/** A client whose transport always answers with the given pre-built Response. */
function streamingClient(response: Response): EmbeddingClient {
  const fetchImpl: typeof fetch = () => Promise.resolve(response)
  return new EmbeddingClient({ ...clientOptions('k', 'http://127.0.0.1:1'), fetchImpl })
}
