import * as nativeCommands from '@relay-harness/rlh-native-command'
import { createConnection } from 'node:net'
import { createServer, request as httpRequest, Server } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { NativeCommandRunner } from '@relay-harness/rlh-native-command'
import { authorizeMcpHttp, defaultOAuthRuntime, openBrowser, type McpOAuthRuntime } from '../src/oauth.ts'

const RESOURCE = 'https://mcp.example.test/mcp'
const METADATA = 'https://mcp.example.test/.well-known/oauth-protected-resource/mcp'
const ISSUER = 'https://auth.example.test'
const AUTHORIZE = `${ISSUER}/oauth/authorize`
const TOKEN = `${ISSUER}/oauth/token`
const REGISTER = `${ISSUER}/oauth/register`

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function runtime(overrides: {
  probeStatus?: number
  probeHeaders?: Record<string, string>
  tokenStatus?: number
  tokenBody?: unknown
}): { runtime: McpOAuthRuntime; opened: string[] } {
  const opened: string[] = []
  /** The wire face only ever hands this fake strings and form bodies. */
  const bodyText = (body: BodyInit | null | undefined): string =>
    typeof body === 'string' ? body : body instanceof URLSearchParams ? body.toString() : ''
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url === RESOURCE && method === 'POST') {
      const headers = overrides.probeHeaders ?? {
        'www-authenticate': `Bearer error="invalid_token", resource_metadata="${METADATA}"`,
      }
      return jsonResponse(overrides.probeStatus ?? 401, { error: 'missing bearer token' }, headers)
    }
    if (url === METADATA && method === 'GET') {
      return jsonResponse(200, { resource: RESOURCE, authorization_servers: [ISSUER], scopes_supported: ['mcp:use'] })
    }
    if (url === `${ISSUER}/.well-known/oauth-authorization-server` && method === 'GET') {
      return jsonResponse(200, {
        issuer: ISSUER,
        authorization_endpoint: AUTHORIZE,
        token_endpoint: TOKEN,
        registration_endpoint: REGISTER,
        code_challenge_methods_supported: ['S256'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: ['none'],
      })
    }
    if (url === REGISTER && method === 'POST') {
      const body = JSON.parse(bodyText(init?.body)) as { redirect_uris?: string[] }
      expect(body.redirect_uris).toEqual(['http://127.0.0.1:9/callback'])
      return jsonResponse(201, { client_id: 'client-1', token_endpoint_auth_method: 'none' })
    }
    if (url === TOKEN && method === 'POST') {
      const params = new URLSearchParams(bodyText(init?.body))
      expect(params.get('grant_type')).toBe('authorization_code')
      expect(params.get('code')).toBe('auth-code')
      expect(params.get('client_id')).toBe('client-1')
      expect(params.get('redirect_uri')).toBe('http://127.0.0.1:9/callback')
      expect(params.get('resource')).toBe(RESOURCE)
      expect(params.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]+$/)
      return jsonResponse(
        overrides.tokenStatus ?? 200,
        overrides.tokenBody ?? {
          access_token: 'tok-live',
          refresh_token: 'ref-live',
          token_type: 'Bearer',
          expires_in: 3600,
        },
      )
    }
    throw new Error(`unexpected fetch ${method} ${url}`)
  }
  return {
    opened,
    runtime: {
      fetch: fetchImpl,
      openBrowser: (url) => { opened.push(url) },
      createListener: async () => ({
        redirectUri: 'http://127.0.0.1:9/callback',
        waitForCode: async (state) => {
          expect(state.length).toBeGreaterThan(8)
          return 'auth-code'
        },
        close: async () => {},
      }),
    },
  }
}

describe('authorizeMcpHttp', () => {
  it('runs PKCE against discovered metadata and returns the access token', async () => {
    const { runtime: oauth, opened } = runtime({})
    const tokens = await authorizeMcpHttp(RESOURCE, oauth)
    expect(tokens.access_token).toBe('tok-live')
    expect(tokens.refresh_token).toBe('ref-live')
    expect(opened).toHaveLength(1)
    const authorize = new URL(opened[0]!)
    expect(authorize.origin + authorize.pathname).toBe(AUTHORIZE)
    expect(authorize.searchParams.get('response_type')).toBe('code')
    expect(authorize.searchParams.get('client_id')).toBe('client-1')
    expect(authorize.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:9/callback')
    expect(authorize.searchParams.get('scope')).toBe('mcp:use')
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authorize.searchParams.get('resource')).toBe(RESOURCE)
    expect(authorize.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('refuses a server that does not challenge for OAuth', async () => {
    const { runtime: oauth } = runtime({ probeStatus: 200 })
    await expect(authorizeMcpHttp(RESOURCE, oauth)).rejects.toThrow(/did not request OAuth/)
  })

  it('falls back to well-known metadata when WWW-Authenticate is absent', async () => {
    const { runtime: oauth } = runtime({ probeHeaders: {} })
    const tokens = await authorizeMcpHttp(RESOURCE, oauth)
    expect(tokens.access_token).toBe('tok-live')
  })
})

describe('OAuth HTTP success boundary', () => {
  it.each([METADATA, `${ISSUER}/.well-known/oauth-authorization-server`, REGISTER, TOKEN])('rejects successful-looking JSON delivered with HTTP 500 at %s', async (endpoint) => {
    const { runtime: original, opened } = runtime({})
    let closed = 0
    const oauth: McpOAuthRuntime = {
      ...original,
      fetch: async (input, init) => {
        const response = await original.fetch(input, init)
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
        return url === endpoint ? new Response(await response.text(), { status: 500 }) : response
      },
      createListener: async () => {
        const listener = await original.createListener()
        return { ...listener, close: async () => { closed += 1; await listener.close() } }
      },
    }
    await expect(authorizeMcpHttp(RESOURCE, oauth)).rejects.toThrow('OAuth HTTP request failed (500)')
    expect(opened).toHaveLength(endpoint === TOKEN ? 1 : 0)
    expect(closed).toBe(endpoint === REGISTER || endpoint === TOKEN ? 1 : 0)
  })
})

describe('OAuth response rejection diagnostics', () => {
  it.each([400, 401, 403, 429])('rejects token-shaped HTTP %i errors without reflecting response credentials', async (status) => {
    const { runtime: oauth } = runtime({ tokenStatus: status, tokenBody: { access_token: 'fixture-must-not-leak' } })
    await expect(authorizeMcpHttp(RESOURCE, oauth))
      .rejects.toHaveProperty('message', `mcp-servers-file: OAuth HTTP request failed (${status})`)
  })

  it.each([[], 'fixture-sensitive-error'])('rejects non-object successful token responses: %j', async (tokenBody) => {
    const { runtime: oauth } = runtime({ tokenBody })
    await expect(authorizeMcpHttp(RESOURCE, oauth)).rejects.toHaveProperty('message', 'mcp-servers-file: OAuth response is not a JSON object')
  })

  it('rejects a successful JSON object that has no access token', async () => {
    const { runtime: oauth } = runtime({ tokenBody: { error: 'fixture-sensitive-error' } })
    await expect(authorizeMcpHttp(RESOURCE, oauth)).rejects.toHaveProperty('message', 'mcp-servers-file: OAuth token exchange failed (200)')
  })

  it('does not expose the body when a successful response contains invalid JSON', async () => {
    const { runtime: original } = runtime({})
    const oauth: McpOAuthRuntime = {
      ...original,
      fetch: (input, init) => input === TOKEN
        ? Promise.resolve(new Response('fixture-sensitive-not-json', { status: 200 }))
        : original.fetch(input, init),
    }
    await expect(authorizeMcpHttp(RESOURCE, oauth)).rejects.toHaveProperty('message', 'mcp-servers-file: OAuth response is not JSON (200)')
  })
})


describe('real loopback OAuth listener', () => {
  it.each(['code=foreign&state=wrong', 'error=foreign-private-error&state=wrong'])('does not consume an active login on an unauthenticated callback: %s', async (query) => {
    const listener = await defaultOAuthRuntime().createListener()
    const waiting = listener.waitForCode('expected-state', 1000).then(code => ({ code }), (error: unknown) => ({ error: String(error) }))
    try {
      const invalid = await fetch(`${listener.redirectUri}?${query}`)
      expect(invalid.status).toBe(400)
      expect(await invalid.text()).not.toContain('foreign-private-error')
      const valid = await fetch(`${listener.redirectUri}?code=accepted&state=expected-state`)
      expect(valid.status).toBe(200)
      await expect(waiting).resolves.toEqual({ code: 'accepted' })
    } finally {
      await listener.close()
      await waiting
    }
  })

  it('closes idempotently, rejects pending login immediately, and refuses new waits', async () => {
    const listener = await defaultOAuthRuntime().createListener()
    const waiting = listener.waitForCode('expected-state', 1000).then(code => code, (error: unknown) => String(error))
    const closing = listener.close()
    // Attach before asserting identity so a broken repeated close is observed.
    const repeated = listener.close()
    void repeated.catch(() => undefined)
    await closing
    expect(await waiting).toContain('OAuth listener closed')
    expect(repeated).toBe(closing)
    await expect(listener.waitForCode('later', 1000)).rejects.toThrow('OAuth listener closed')
  })

  it('rejects a second waiter without replacing the first', async () => {
    const listener = await defaultOAuthRuntime().createListener()
    const first = listener.waitForCode('first-state', 1000).then(code => ({ code }), (error: unknown) => ({ error: String(error) }))
    try {
      await expect(listener.waitForCode('second-state', 1000)).rejects.toThrow('already waiting')
      const response = await fetch(`${listener.redirectUri}?code=first-code&state=first-state`)
      expect(response.status).toBe(200)
      await expect(first).resolves.toEqual({ code: 'first-code' })
    } finally {
      await listener.close()
      await first
    }
  })
})

describe('OAuth listener terminal paths', () => {
  it.each(['error=fixture-private-reason', 'code='])('contains matching-state authorization failure without reflecting details: %s', async (query) => {
    const listener = await defaultOAuthRuntime().createListener()
    const waiting = listener.waitForCode('expected', 1000).then(code => code, (error: unknown) => String(error))
    try {
      const response = await fetch(`${listener.redirectUri}?${query}&state=expected`)
      expect(response.status).toBe(400)
      expect(await response.text()).toBe('OAuth authorization failed')
      expect(await waiting).toBe('Error: mcp-servers-file: OAuth authorization failed')
    } finally {
      await listener.close()
    }
  })

  it('times out one transaction, then admits a new one and rejects replay', async () => {
    const listener = await defaultOAuthRuntime().createListener()
    try {
      await expect(listener.waitForCode('expired', 5)).rejects.toThrow('OAuth login timed out')
      expect((await fetch(listener.redirectUri.replace('/callback', '/elsewhere'))).status).toBe(404)
      const waiting = listener.waitForCode('next', 1000)
      const url = `${listener.redirectUri}?code=accepted&state=next`
      expect((await fetch(url, { method: 'POST' })).status).toBe(400)
      expect((await fetch(url)).status).toBe(200)
      await expect(waiting).resolves.toBe('accepted')
      expect((await fetch(url)).status).toBe(400)
    } finally {
      await listener.close()
    }
  })

  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])('rejects invalid timer duration %s before installing a wait', async (duration) => {
    const listener = await defaultOAuthRuntime().createListener()
    try {
      await expect(listener.waitForCode('expected', duration)).rejects.toThrow('invalid OAuth listener state or timeout')
      await expect(listener.waitForCode('', 1000)).rejects.toThrow('invalid OAuth listener state or timeout')
    } finally {
      await listener.close()
    }
  })

  it.each(['sync', 'async'])('observes waiter rejection when %s browser launch fails before awaiting the callback', async (mode) => {
    const { runtime: original } = runtime({})
    let rejectCode: ((error: Error) => void) | undefined
    let closed = false
    const oauth: McpOAuthRuntime = {
      ...original,
      openBrowser: () => {
        if (mode === 'async') return Promise.reject(new Error('fixture browser unavailable'))
        throw new Error('fixture browser unavailable')
      },
      createListener: async () => ({
        redirectUri: 'http://127.0.0.1:9/callback',
        waitForCode: () => new Promise((_resolve, reject) => { rejectCode = reject }),
        close: async () => {
          closed = true
          rejectCode?.(new Error('fixture listener closed'))
        },
      }),
    }
    await expect(authorizeMcpHttp(RESOURCE, oauth)).rejects.toThrow('fixture browser unavailable')
    expect(closed).toBe(true)
  })
})


describe('OAuth native browser hand-off', () => {
  it.each(['darwin', 'linux', 'win32'] as const)('uses the shared runner without cmd.exe interpolation on %s', async (platform) => {
    const run = vi.fn<NativeCommandRunner>(async () => ({ stdout: '', stderr: '' }))
    const url = "https://auth.example.test/quoted'/authorize?scope=a%20b"
    await openBrowser(url, { platform, run })
    expect(run).toHaveBeenCalledTimes(1)
    const args = platform === 'win32'
      ? ['-NoProfile', '-NonInteractive', '-Command', "Start-Process -FilePath 'https://auth.example.test/quoted''/authorize?scope=a%20b'"]
      : [url]
    expect(run).toHaveBeenCalledWith(platform === 'win32' ? 'powershell.exe' : platform === 'darwin' ? 'open' : 'xdg-open', args, expect.any(AbortSignal))
  })

  it.each(['not a URL', 'javascript:alert(1)', 'file:///tmp/file', 'data:text/plain,hi', 'https://user:password@example.test/', 'https://example.test/#fragment'])('refuses non-browser targets without executing a command: %s', async (url) => {
    const run = vi.fn<NativeCommandRunner>()
    await expect(openBrowser(url, { run })).rejects.toHaveProperty('message', 'mcp-servers-file: invalid OAuth browser URL')
    expect(run).not.toHaveBeenCalled()
  })

  it('bounds the hand-off and redacts native errors containing authorization URLs', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout')
    const run = vi.fn<NativeCommandRunner>(async () => { throw new Error('fixture argv includes private-state') })
    try {
      await expect(openBrowser(AUTHORIZE, { run })).rejects.toHaveProperty('message', 'mcp-servers-file: could not open OAuth browser')
      expect(timeout).toHaveBeenCalledWith(10_000)
    } finally {
      timeout.mockRestore()
    }
  })
})


it('contains a malformed raw callback URL without consuming the login', async () => {
  const listener = await defaultOAuthRuntime().createListener()
  const waiting = listener.waitForCode('expected', 1000).then(code => code, (error: unknown) => String(error))
  try {
    const address = new URL(listener.redirectUri)
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = httpRequest({ hostname: address.hostname, port: address.port, path: 'http://[', timeout: 250 }, (res) => {
        res.resume()
        res.once('end', () => { resolve(res.statusCode) })
      })
      req.on('error', reject)
      req.on('timeout', () => { req.destroy(new Error('malformed callback did not receive a response')) })
      req.end()
    })
    expect(status).toBe(400)
    const valid = await fetch(`${listener.redirectUri}?code=accepted&state=expected`)
    expect(valid.status).toBe(200)
    expect(await waiting).toBe('accepted')
  } finally {
    await listener.close()
    await waiting
  }
})

describe('OAuth discovery validation', () => {
  it.each([
    { endpoint: METADATA, field: 'authorization_servers', value: [], error: 'OAuth metadata is missing authorization_servers' },
    { endpoint: `${ISSUER}/.well-known/oauth-authorization-server`, field: 'code_challenge_methods_supported', value: [], error: 'authorization server does not advertise PKCE S256' },
    ...['authorization_endpoint', 'token_endpoint', 'registration_endpoint'].map(field => ({
      endpoint: `${ISSUER}/.well-known/oauth-authorization-server`, field, value: '', error: `OAuth metadata is missing ${field}`,
    })),
    { endpoint: REGISTER, field: 'client_id', value: '', error: 'OAuth registration failed (201)' },
  ])('rejects invalid $field before advancing authorization', async ({ endpoint, field, value, error }) => {
    const { runtime: original, opened } = runtime({})
    let closed = false
    const oauth: McpOAuthRuntime = {
      ...original,
      fetch: async (input, init) => {
        const response = await original.fetch(input, init)
        if (input !== endpoint) return response
        const body = await response.json() as Record<string, unknown>
        return jsonResponse(response.status, { ...body, [field]: value })
      },
      createListener: async () => {
        const listener = await original.createListener()
        return { ...listener, close: async () => { closed = true; await listener.close() } }
      },
    }
    await expect(authorizeMcpHttp(RESOURCE, oauth)).rejects.toHaveProperty('message', `mcp-servers-file: ${error}`)
    expect(opened).toEqual([])
    expect(closed).toBe(endpoint === REGISTER)
  })

  it('accepts a bare metadata challenge and a token with only required fields', async () => {
    const { runtime: oauth } = runtime({
      probeHeaders: { 'www-authenticate': `Bearer resource_metadata=${METADATA}` },
      tokenBody: { access_token: 'fixture-token' },
    })
    await expect(authorizeMcpHttp(RESOURCE, oauth)).resolves.toEqual({ access_token: 'fixture-token' })
  })
})


describe('OAuth lifetime cancellation', () => {
  it.each([
    { mode: 'owner', phase: 'headers' }, { mode: 'owner', phase: 'body' },
    { mode: 'request-deadline', phase: 'headers' }, { mode: 'request-deadline', phase: 'body' },
  ])('aborts a real stalled HTTP $phase through $mode', async ({ mode, phase }) => {
    const owner = new AbortController()
    const deadline = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    const peerClosed = Promise.withResolvers<undefined>()
    const server = createServer((req, res) => {
      if (phase === 'body' && req.url === '/mcp') {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="http://${req.headers.host}/metadata"` }).end()
        return
      }
      res.on('close', () => { peerClosed.resolve(undefined) })
      if (phase === 'body') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write('{"authorization_servers":')
      }
      entered.resolve(undefined)
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture listener missing')
    const timeout = mode === 'request-deadline' ? vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal) : undefined
    const outcome = authorizeMcpHttp(`http://127.0.0.1:${address.port}/mcp`, defaultOAuthRuntime(), owner.signal)
      .catch((error: unknown) => error)
    try {
      await entered.promise
      if (mode === 'owner') owner.abort(new Error('fixture cancellation'))
      else deadline.abort(new Error('fixture cancellation'))
      expect(await outcome).toBeInstanceOf(Error)
      await peerClosed.promise
      if (timeout !== undefined) expect(timeout).toHaveBeenCalledWith(30_000)
    } finally {
      owner.abort()
      deadline.abort()
      timeout?.mockRestore()
      await outcome
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
    }
  })

  it('closes a real callback listener when its owner cancels browser waiting', async () => {
    const owner = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    const { runtime: original } = runtime({})
    let redirect = ''
    const oauth: McpOAuthRuntime = {
      ...original,
      fetch: (input, init) => input === REGISTER ? Promise.resolve(jsonResponse(201, { client_id: 'client-1' })) : original.fetch(input, init),
      createListener: async () => {
        const listener = await defaultOAuthRuntime().createListener()
        redirect = listener.redirectUri
        return listener
      },
      openBrowser: () => { entered.resolve(undefined) },
    }
    const outcome = authorizeMcpHttp(RESOURCE, oauth, owner.signal).catch((error: unknown) => error)
    await entered.promise
    owner.abort()
    expect(await outcome).toBeInstanceOf(Error)
    await expect(fetch(redirect)).rejects.toThrow()
  })

  it('refuses a pre-cancelled owner without network or listener admission', async () => {
    const owner = new AbortController()
    owner.abort(new Error('fixture already closed'))
    const { runtime: original } = runtime({})
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(authorizeMcpHttp(RESOURCE, { ...original, fetch }, owner.signal)).rejects.toThrow('fixture already closed')
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('OAuth response byte budget', () => {
  const limit = 1024 * 1024
  it.each(['declared', 'streamed', 'lying-length'] as const)('rejects an oversized %s body and cancels it', async (kind) => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(limit + 1))
      },
      cancel() { cancelled = true },
    })
    const headers = kind === 'declared'
      ? { 'content-length': String(limit + 1) }
      : kind === 'lying-length' ? { 'content-length': '1' } : {}
    const response = new Response(body, { headers })
    const { runtime: original } = runtime({})
    const oauth: McpOAuthRuntime = {
      ...original,
      fetch: (input, init) => input === TOKEN ? Promise.resolve(response) : original.fetch(input, init),
    }
    // An unbounded implementation would wait forever for this stream to end.
    const outcome = authorizeMcpHttp(RESOURCE, oauth)
    await expect(outcome).rejects.toHaveProperty('message', 'mcp-servers-file: OAuth response exceeds 1048576 bytes')
    expect(cancelled).toBe(true)
    expect(body.locked).toBe(false)
  }, 1000)
})


it('accepts an exactly bounded JSON body and UTF-8 split across chunks', async () => {
  const limit = 1024 * 1024
  const empty = JSON.stringify({ access_token: '' })
  const exact = JSON.stringify({ access_token: 'x'.repeat(limit - Buffer.byteLength(empty)) })
  for (const text of [exact, JSON.stringify({ access_token: 'fixture-中文' })]) {
    const bytes = new TextEncoder().encode(text)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunkSize = text === exact ? 257 : 1
        for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.subarray(i, i + chunkSize))
        controller.close()
      },
    })
    const { runtime: original } = runtime({})
    const tokens = await authorizeMcpHttp(RESOURCE, {
      ...original,
      fetch: (input, init) => input === TOKEN ? Promise.resolve(new Response(stream)) : original.fetch(input, init),
    })
    expect(JSON.stringify(tokens)).toBe(text)
    expect(stream.locked).toBe(false)
  }
})

it.each([500, 200])('preserves HTTP/size diagnostics when body cancellation rejects for status %i', async (status) => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    cancel() { cancelled = true; return Promise.reject(new Error('fixture private cancellation detail')) },
  })
  const response = new Response(stream, { status, headers: { 'content-length': '1048577' } })
  const { runtime: original } = runtime({})
  await expect(authorizeMcpHttp(RESOURCE, {
    ...original,
    fetch: (input, init) => input === TOKEN ? Promise.resolve(response) : original.fetch(input, init),
  })).rejects.toHaveProperty('message', status === 500
    ? 'mcp-servers-file: OAuth HTTP request failed (500)'
    : 'mcp-servers-file: OAuth response exceeds 1048576 bytes')
  expect(cancelled).toBe(true)
  expect(stream.locked).toBe(false)
})


it('closes its own incomplete HTTP connections instead of waiting for remote EOF', async () => {
  const listener = await defaultOAuthRuntime().createListener()
  const address = new URL(listener.redirectUri)
  const socket = createConnection({ host: address.hostname, port: Number(address.port) })
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
  const response = new Promise<string>((resolve, reject) => {
    socket.once('data', (data: Buffer) => { resolve(data.toString()) })
    socket.once('error', reject)
  })
  socket.write('POST /callback HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\nx')
  expect(await response).toContain('400')
  const closing = listener.close()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const settled = await Promise.race([
      closing.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => { resolve(false) }, 500) }),
    ])
    expect(settled).toBe(true)
  } finally {
    clearTimeout(timer)
    socket.destroy()
    await closing
  }
})


describe('OAuth adapter cancellation and body cleanup edges', () => {
  it('uses the default browser adapter with and without owner cancellation', async () => {
    const run = vi.spyOn(nativeCommands, 'runNativeCommand').mockResolvedValue({ stdout: '', stderr: '' })
    try {
      await defaultOAuthRuntime().openBrowser(AUTHORIZE)
      const owner = new AbortController()
      await defaultOAuthRuntime().openBrowser(AUTHORIZE, owner.signal)
      expect(run).toHaveBeenCalledTimes(2)
      const forwarded = run.mock.calls[1]?.[2]
      if (forwarded === undefined) throw new Error('native signal not forwarded')
      expect(forwarded.aborted).toBe(false)
      owner.abort()
      expect(forwarded.aborted).toBe(true)
    } finally {
      run.mockRestore()
    }
  })

  it('closes a listener acquired after owner cancellation before registering a client', async () => {
    const { runtime: original, opened } = runtime({})
    const owner = new AbortController()
    let closed = false
    const oauth: McpOAuthRuntime = {
      ...original,
      createListener: async () => {
        const listener = await original.createListener()
        owner.abort(new Error('fixture cancelled while binding'))
        return { ...listener, close: async () => { closed = true; await listener.close() } }
      },
    }
    await expect(authorizeMcpHttp(RESOURCE, oauth, owner.signal)).rejects.toThrow('fixture cancelled while binding')
    expect(closed).toBe(true)
    expect(opened).toEqual([])
  })

  it('rejects an absent JSON body without inventing a token', async () => {
    const { runtime: original } = runtime({})
    await expect(authorizeMcpHttp(RESOURCE, {
      ...original,
      fetch: (input, init) => input === TOKEN ? Promise.resolve(new Response(null, { status: 200 })) : original.fetch(input, init),
    })).rejects.toHaveProperty('message', 'mcp-servers-file: OAuth response is not JSON (200)')
  })

  it('preserves an over-budget read failure when stream cancellation rejects', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)) },
      cancel() { cancelled = true; return Promise.reject(new Error('fixture cancel detail')) },
    })
    const { runtime: original } = runtime({})
    await expect(authorizeMcpHttp(RESOURCE, {
      ...original,
      fetch: (input, init) => input === TOKEN ? Promise.resolve(new Response(stream)) : original.fetch(input, init),
    })).rejects.toHaveProperty('message', 'mcp-servers-file: OAuth response exceeds 1048576 bytes')
    expect(cancelled).toBe(true)
    expect(stream.locked).toBe(false)
  })

  it('continues discovery when discarding the challenge body rejects', async () => {
    let cancelled = false
    const { runtime: original } = runtime({})
    const tokens = await authorizeMcpHttp(RESOURCE, {
      ...original,
      fetch: (input, init) => input === RESOURCE ? Promise.resolve(new Response(new ReadableStream({
        cancel() { cancelled = true; return Promise.reject(new Error('fixture private probe detail')) },
      }), { status: 401, headers: { 'www-authenticate': `Bearer resource_metadata="${METADATA}"` } })) : original.fetch(input, init),
    })
    expect(tokens.access_token).toBe('tok-live')
    expect(cancelled).toBe(true)
  })
})


it.each([null, 'unexpected-pipe'])('reaps a listener whose address lookup returns %s instead of a TCP address', async (invalid) => {
  const address = vi.spyOn(Server.prototype, 'address').mockReturnValue(invalid)
  try {
    await expect(defaultOAuthRuntime().createListener()).rejects.toThrow('OAuth listener did not bind a TCP port')
    const observed = address.mock.contexts.find((value): value is Server => value instanceof Server)
    expect(observed).toBeDefined()
    expect(observed?.listening).toBe(false)
  } finally {
    const owned = address.mock.contexts.find((value): value is Server => value instanceof Server)
    address.mockRestore()
    if (owned?.listening) await new Promise<void>((resolve, reject) => {
      owned.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
})

describe('OAuth issuer discovery identity', () => {
  it.each(['/tenant-one', '/tenant-one/'])('preserves issuer path %s when discovering metadata', async (path) => {
    const issuer = `${ISSUER}${path}`
    const metadata = `${ISSUER}/.well-known/oauth-authorization-server/tenant-one`
    const { runtime: original } = runtime({})
    const requested: unknown[] = []
    const oauth: McpOAuthRuntime = {
      ...original,
      fetch: async (input, init) => {
        requested.push(input)
        if (input === METADATA) return jsonResponse(200, { resource: RESOURCE, authorization_servers: [issuer] })
        if (input === metadata) {
          const response = await original.fetch(`${ISSUER}/.well-known/oauth-authorization-server`, init)
          const body = await response.json() as Record<string, unknown>
          return jsonResponse(200, { ...body, issuer })
        }
        return original.fetch(input, init)
      },
    }
    await authorizeMcpHttp(RESOURCE, oauth)
    expect(requested).toContain(metadata)
    expect(requested).not.toContain(`${ISSUER}/.well-known/oauth-authorization-server`)
  })

  it.each([undefined, 'https://other.example.test', `${ISSUER}/`])('refuses missing or non-identical response issuer %s before registration', async (issuer) => {
    const { runtime: original, opened } = runtime({})
    let listenerCreated = false
    const oauth: McpOAuthRuntime = {
      ...original,
      fetch: async (input, init) => {
        const response = await original.fetch(input, init)
        if (input !== `${ISSUER}/.well-known/oauth-authorization-server`) return response
        const body = await response.json() as Record<string, unknown>
        return jsonResponse(200, { ...body, issuer })
      },
      createListener: async () => { listenerCreated = true; return original.createListener() },
    }
    await expect(authorizeMcpHttp(RESOURCE, oauth)).rejects.toHaveProperty('message', 'mcp-servers-file: OAuth issuer metadata mismatch')
    expect(listenerCreated).toBe(false)
    expect(opened).toEqual([])
  })
})

it.each([
  'not-a-url', 'http://auth.example.test', 'https://user:fixture-password@auth.example.test',
  `${ISSUER}?tenant=one`, `${ISSUER}?`, `${ISSUER}#fragment`, `${ISSUER}#`,
])('rejects invalid issuer identifiers before fetching their metadata: %s', async (issuer) => {
  const { runtime: original, opened } = runtime({})
  const requests: unknown[] = []
  await expect(authorizeMcpHttp(RESOURCE, {
    ...original,
    fetch: (input, init) => {
      requests.push(input)
      return input === METADATA
        ? Promise.resolve(jsonResponse(200, { resource: RESOURCE, authorization_servers: [issuer] }))
        : original.fetch(input, init)
    },
  })).rejects.toHaveProperty('message', 'mcp-servers-file: invalid OAuth issuer URL')
  expect(requests).toEqual([RESOURCE, METADATA])
  expect(opened).toEqual([])
})

describe('OAuth protected resource identity', () => {
  it.each([undefined, 'https://other.example.test/mcp', `${RESOURCE}/`, `${RESOURCE}?other=1`])('rejects non-identical metadata resource %s', async (resource) => {
    const { runtime: original, opened } = runtime({})
    const requests: unknown[] = []
    await expect(authorizeMcpHttp(RESOURCE, {
      ...original,
      fetch: async (input, init) => {
        requests.push(input)
        const response = await original.fetch(input, init)
        if (input !== METADATA) return response
        const body = await response.json() as Record<string, unknown>
        return jsonResponse(200, { ...body, resource })
      },
    })).rejects.toHaveProperty('message', 'mcp-servers-file: OAuth resource metadata mismatch')
    expect(requests).toEqual([RESOURCE, METADATA])
    expect(opened).toEqual([])
  })

  it.each(['/', '/mcp?tenant=blue', '/mcp/'])('preserves the resource identity and fallback metadata location for %s', async (path) => {
    const resource = `https://mcp.example.test${path}`
    const metadata = `https://mcp.example.test/.well-known/oauth-protected-resource${path === '/' ? '' : path}`
    const { runtime: original } = runtime({})
    const requests: unknown[] = []
    const tokens = await authorizeMcpHttp(resource, {
      ...original,
      fetch: (input, init) => {
        requests.push(input)
        if (input === resource) return Promise.resolve(jsonResponse(401, {}))
        if (input === metadata) return Promise.resolve(jsonResponse(200, { resource, authorization_servers: [ISSUER] }))
        if (input === TOKEN) {
          if (!(init?.body instanceof URLSearchParams)) throw new Error('fixture token form missing')
          expect(init.body.get('resource')).toBe(resource)
          return Promise.resolve(jsonResponse(200, { access_token: 'fixture-token' }))
        }
        return original.fetch(input, init)
      },
    })
    expect(tokens.access_token).toBe('fixture-token')
    expect(requests).toContain(metadata)
  })
})

describe('OAuth metadata collection shapes', () => {
  it.each([
    { field: 'authorization_servers', value: ISSUER },
    { field: 'authorization_servers', value: [ISSUER, 42] },
    { field: 'authorization_servers', value: [ISSUER, ''] },
    { field: 'authorization_servers', value: null },
    { field: 'scopes_supported', value: 'mcp:use' },
    { field: 'scopes_supported', value: ['mcp:use', 42] },
    { field: 'scopes_supported', value: ['mcp:use', ''] },
    { field: 'scopes_supported', value: {} },
  ])('rejects invalid $field before listener/browser admission', async ({ field, value }) => {
    const { runtime: original, opened } = runtime({})
    let listenerCreated = false
    await expect(authorizeMcpHttp(RESOURCE, {
      ...original,
      fetch: async (input, init) => {
        const response = await original.fetch(input, init)
        if (input !== METADATA) return response
        const body = await response.json() as Record<string, unknown>
        return jsonResponse(200, { ...body, [field]: value })
      },
      createListener: async () => { listenerCreated = true; return original.createListener() },
    })).rejects.toHaveProperty('message', `mcp-servers-file: OAuth metadata ${field} must be an array of non-empty strings`)
    expect(listenerCreated).toBe(false)
    expect(opened).toEqual([])
  })
})

it('selects the first advertised issuer and scope without broadening the requested scope', async () => {
  const { runtime: original, opened } = runtime({})
  const other = 'https://unused.example.test'
  const requested: unknown[] = []
  await authorizeMcpHttp(RESOURCE, {
    ...original,
    fetch: (input, init) => {
      requested.push(input)
      if (input === METADATA) return Promise.resolve(jsonResponse(200, {
        resource: RESOURCE, authorization_servers: [ISSUER, other], scopes_supported: ['mcp:use', 'admin'],
      }))
      return original.fetch(input, init)
    },
  })
  expect(new URL(opened[0]!).searchParams.get('scope')).toBe('mcp:use')
  expect(requested.some(input => String(input).startsWith(other))).toBe(false)
})

it('reports an externally closed listener once and retains its close outcome', async () => {
  const address = vi.spyOn(Server.prototype, 'address')
  const listener = await defaultOAuthRuntime().createListener()
  const server = address.mock.contexts.find((value): value is Server => value instanceof Server)
  address.mockRestore()
  if (server === undefined) throw new Error('fixture server missing')
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  })
  const closing = listener.close()
  await expect(closing).rejects.toMatchObject({ code: 'ERR_SERVER_NOT_RUNNING' })
  expect(listener.close()).toBe(closing)
})

it('contains a missing request URL at the HTTP adapter boundary without consuming state', async () => {
  const address = vi.spyOn(Server.prototype, 'address')
  const listener = await defaultOAuthRuntime().createListener()
  const server = address.mock.contexts.find((value): value is Server => value instanceof Server)
  address.mockRestore()
  if (server === undefined) throw new Error('fixture server missing')
  // Inject the optional IncomingMessage.url case before the registered handler;
  // this is an adapter fault, not a claim that valid HTTP omits its request target.
  server.prependOnceListener('request', (request: import('node:http').IncomingMessage) => { delete request.url })
  const waiting = listener.waitForCode('expected', 1000).then(code => code, (error: unknown) => String(error))
  try {
    const url = `${listener.redirectUri}?state=expected&code=accepted`
    expect((await fetch(url)).status).toBe(404)
    expect((await fetch(url)).status).toBe(200)
    expect(await waiting).toBe('accepted')
  } finally {
    await listener.close()
    await waiting
  }
})

describe('OAuth endpoint transport admission', () => {
  it.each(['authorization_endpoint', 'registration_endpoint', 'token_endpoint'])('rejects unsafe %s before listener admission', async (field) => {
    for (const endpoint of ['http://auth.example.test/endpoint', 'file:///tmp/endpoint', 'not a URL', 'https://user:fixture@auth.example.test/', 'https://:fixture@auth.example.test/', 'https://auth.example.test/#fragment', 'https://auth.example.test/#']) {
      const { runtime: original, opened } = runtime({})
      let listenerCreated = false
      await expect(authorizeMcpHttp(RESOURCE, {
        ...original,
        fetch: async (input, init) => {
          const response = await original.fetch(input, init)
          if (input !== `${ISSUER}/.well-known/oauth-authorization-server`) return response
          const body = await response.json() as Record<string, unknown>
          return jsonResponse(200, { ...body, [field]: endpoint })
        },
        createListener: async () => { listenerCreated = true; return original.createListener() },
      })).rejects.toHaveProperty('message', `mcp-servers-file: invalid OAuth ${field} URL`)
      expect(listenerCreated).toBe(false)
      expect(opened).toEqual([])
    }
  })
})

it.each([RESOURCE, METADATA, `${ISSUER}/.well-known/oauth-authorization-server`, REGISTER, TOKEN])('does not forward an OAuth request through a redirect from %s', async (endpoint) => {
  let originalRequests = 0
  let forwardedRequests = 0
  const server = createServer((req, res) => {
    req.resume()
    if (req.url === '/request') {
      originalRequests += 1
      res.writeHead(307, { location: '/unexpected' }).end()
    } else {
      forwardedRequests += 1
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ client_id: 'client-1', access_token: 'fixture-redirect-token' }))
    }
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture address missing')
  const { runtime: original } = runtime({})
  try {
    await expect(authorizeMcpHttp(RESOURCE, {
      ...original,
      // Only the test transport maps its HTTPS fixture endpoint to this local
      // HTTP server; native fetch still exercises the actual redirect policy.
      fetch: (input, init) => input === endpoint
        ? fetch(`http://127.0.0.1:${address.port}/request`, init)
        : original.fetch(input, init),
    })).rejects.toBeInstanceOf(Error)
    expect(originalRequests).toBe(1)
    expect(forwardedRequests).toBe(0)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
      server.closeAllConnections()
    })
  }
})

describe('OAuth resource transport boundary', () => {
  it.each(['not a URL', 'http://remote.example.test/mcp', 'http://localhost.attacker.test/mcp', 'file:///tmp/mcp', `${RESOURCE}#fragment`, 'https://user:fixture@mcp.example.test/mcp', 'https://:fixture@mcp.example.test/mcp'])('refuses unsafe resource %s before network admission', async (resource) => {
    const { runtime: original } = runtime({})
    const fetch = vi.fn<typeof globalThis.fetch>(async () => { throw new Error('fixture unexpected network') })
    await expect(authorizeMcpHttp(resource, { ...original, fetch })).rejects.toHaveProperty('message', 'mcp-servers-file: invalid OAuth resource URL')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each(['http://metadata.example.test/meta', 'http://127.0.0.1:9999/meta', 'file:///tmp/meta', 'https://user:fixture@metadata.example.test/meta', 'https://metadata.example.test/meta#fragment'])('rejects unsafe metadata location %s before fetching it', async (metadata) => {
    const { runtime: original } = runtime({ probeHeaders: { 'www-authenticate': `Bearer resource_metadata="${metadata}"` } })
    const requests: unknown[] = []
    await expect(authorizeMcpHttp(RESOURCE, {
      ...original,
      fetch: (input, init) => { requests.push(input); return original.fetch(input, init) },
    })).rejects.toHaveProperty('message', 'mcp-servers-file: invalid OAuth resource metadata URL')
    expect(requests).toEqual([RESOURCE])
  })
})

it.each(['127.0.0.1', 'localhost', '[::1]'])('allows the explicit loopback origin %s without weakening issuer TLS', async (host) => {
  const resource = `http://${host}:9000/mcp`
  const metadata = `http://${host}:9000/metadata`
  const { runtime: original } = runtime({})
  const tokens = await authorizeMcpHttp(resource, {
    ...original,
    fetch: (input, init) => {
      if (input === resource) return Promise.resolve(jsonResponse(401, {}, { 'www-authenticate': `Bearer resource_metadata="${metadata}"` }))
      if (input === metadata) return Promise.resolve(jsonResponse(200, { resource, authorization_servers: [ISSUER] }))
      if (input === TOKEN) {
        if (!(init?.body instanceof URLSearchParams)) throw new Error('fixture token form missing')
        expect(init.body.get('resource')).toBe(resource)
        return Promise.resolve(jsonResponse(200, { access_token: 'fixture-local-token' }))
      }
      return original.fetch(input, init)
    },
  })
  expect(tokens.access_token).toBe('fixture-local-token')
})

it('rejects plaintext metadata on a different loopback port', async () => {
  const resource = 'http://127.0.0.1:9000/mcp'
  const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(401, {}, {
    'www-authenticate': 'Bearer resource_metadata="http://127.0.0.1:9001/metadata"',
  }))
  const { runtime: original } = runtime({})
  await expect(authorizeMcpHttp(resource, { ...original, fetch }))
    .rejects.toHaveProperty('message', 'mcp-servers-file: invalid OAuth resource metadata URL')
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('permits explicit cross-origin HTTPS metadata with matching resource identity', async () => {
  const metadata = 'https://metadata.example.test/description'
  const { runtime: original } = runtime({ probeHeaders: { 'www-authenticate': `Bearer resource_metadata="${metadata}"` } })
  const tokens = await authorizeMcpHttp(RESOURCE, {
    ...original,
    fetch: (input, init) => input === metadata
      ? Promise.resolve(jsonResponse(200, { resource: RESOURCE, authorization_servers: [ISSUER] }))
      : original.fetch(input, init),
  })
  expect(tokens.access_token).toBe('tok-live')
})
