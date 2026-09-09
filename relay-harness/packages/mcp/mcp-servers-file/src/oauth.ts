/**
 * MCP HTTP OAuth 2.1 authorization-code + PKCE helper used by Settings login.
 * @module @relay-harness/rlh-mcp-servers-file/oauth
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { runNativeCommand, type NativeCommandRunner } from '@relay-harness/rlh-native-command'

/** Tokens returned by the authorization-code exchange. */
export interface McpOAuthTokens {
  readonly access_token: string
  readonly refresh_token?: string
  readonly token_type?: string
  readonly expires_in?: number
}

/** Localhost callback the authorization server redirects to. */
export interface McpOAuthListener {
  /** Exact redirect URI registered with the authorization server. */
  readonly redirectUri: string
  /**
   * Wait for one callback carrying `code` and matching `state`; only one
   * waiter may be active. Unauthenticated callbacks do not consume it.
   * @param state - CSRF token placed on the authorize URL.
   * @param timeoutMs - how long to wait for the browser redirect.
   * @returns the authorization code.
   */
  waitForCode: (state: string, timeoutMs: number) => Promise<string>
  /** Stop listening and reject any pending wait; repeated calls share completion. */
  close: () => Promise<void>
}

/** Injected I/O so authorization-flow tests can avoid browsers and real ports. */
export interface McpOAuthRuntime {
  readonly fetch: typeof fetch
  readonly openBrowser: (url: string, signal?: AbortSignal) => void | Promise<void>
  readonly createListener: () => Promise<McpOAuthListener>
}

const AUTH_TIMEOUT_MS = 180_000
const SCOPE = 'mcp:use'

/**
 * Discover the resource, register a public client, and exchange a PKCE code
 * for an access token. Opens the system browser for the user to sign in.
 * @param resource - MCP Streamable HTTP endpoint URL.
 * @param runtime - fetch, browser, and localhost callback.
 * @param signal - optional owner cancellation propagated through requests and browser hand-off.
 * @returns the token response.
 */
export async function authorizeMcpHttp(resource: string, runtime: McpOAuthRuntime, signal?: AbortSignal): Promise<McpOAuthTokens> {
  signal?.throwIfAborted()
  const resourceUrl = resourceTransportUrl(resource)
  const fetchImpl: typeof fetch = (input, init) => {
    signal?.throwIfAborted()
    const signals = [AbortSignal.timeout(30_000)]
    if (signal !== undefined) signals.push(signal)
    return runtime.fetch(input, { ...init, signal: AbortSignal.any(signals), redirect: 'error' })
  }
  const metadataUrl = await discoverResourceMetadataUrl(resource, fetchImpl)
  validateMetadataTransport(metadataUrl, resourceUrl)
  const protectedResource = await getJson(fetchImpl, metadataUrl)
  if (protectedResource.resource !== resource) throw new Error('mcp-servers-file: OAuth resource metadata mismatch')
  const issuer = firstString(protectedResource.authorization_servers, 'authorization_servers')
  if (issuer === undefined) {
    throw new Error('mcp-servers-file: OAuth metadata is missing authorization_servers')
  }
  const asMeta = await getJson(fetchImpl, issuerMetadataUrl(issuer))
  if (asMeta.issuer !== issuer) throw new Error('mcp-servers-file: OAuth issuer metadata mismatch')
  const methods = asMeta.code_challenge_methods_supported
  if (!Array.isArray(methods) || !methods.includes('S256')) {
    throw new Error('mcp-servers-file: authorization server does not advertise PKCE S256')
  }
  const authorizationEndpoint = endpointUrl(asMeta.authorization_endpoint, 'authorization_endpoint')
  const tokenEndpoint = endpointUrl(asMeta.token_endpoint, 'token_endpoint')
  const registrationEndpoint = endpointUrl(asMeta.registration_endpoint, 'registration_endpoint')
  const scope = firstString(protectedResource.scopes_supported, 'scopes_supported') ?? SCOPE

  signal?.throwIfAborted()
  const listener = await runtime.createListener()
  let onAbort: (() => void) | undefined
  try {
    signal?.throwIfAborted()
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => { reject(new Error('mcp-servers-file: OAuth login cancelled')) }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    void cancelled.catch(() => undefined)
    const clientId = await registerClient(fetchImpl, registrationEndpoint, listener.redirectUri, scope)
    signal?.throwIfAborted()
    const { verifier, challenge } = pkce()
    const state = b64url(randomBytes(16))
    const authorize = new URL(authorizationEndpoint)
    authorize.searchParams.set('response_type', 'code')
    authorize.searchParams.set('client_id', clientId)
    authorize.searchParams.set('redirect_uri', listener.redirectUri)
    authorize.searchParams.set('scope', scope)
    authorize.searchParams.set('code_challenge', challenge)
    authorize.searchParams.set('code_challenge_method', 'S256')
    authorize.searchParams.set('resource', resource)
    authorize.searchParams.set('state', state)
    const codePromise = listener.waitForCode(state, AUTH_TIMEOUT_MS)
    // Browser launch may throw before the await; close still rejects this waiter.
    void codePromise.catch(() => undefined)
    await runtime.openBrowser(authorize.href, signal)
    signal?.throwIfAborted()
    const code = await Promise.race([codePromise, cancelled])
    return await exchangeCode(fetchImpl, {
      tokenEndpoint,
      clientId,
      code,
      redirectUri: listener.redirectUri,
      verifier,
      resource,
    })
  } finally {
    if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
    await listener.close()
  }
}

/**
 * Production I/O: global fetch, OS browser, and an ephemeral 127.0.0.1 listener.
 * @returns the default runtime.
 */
export function defaultOAuthRuntime(): McpOAuthRuntime {
  return {
    fetch,
    openBrowser: (url, signal) => openBrowser(url, { ...signal === undefined ? {} : { signal } }),
    createListener,
  }
}

/** Parse transport locations without reflecting supplied URLs in diagnostics. */
function transportUrl(value: string, field: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new Error(`mcp-servers-file: invalid OAuth ${field} URL`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '' || value.includes('#')) {
    throw new Error(`mcp-servers-file: invalid OAuth ${field} URL`)
  }
  return url
}

/** Plain HTTP is limited to the explicit local-development resource origins. */
function resourceTransportUrl(resource: string): URL {
  const url = transportUrl(resource, 'resource')
  if (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new Error('mcp-servers-file: invalid OAuth resource URL')
  }
  return url
}

/** Metadata may delegate over HTTPS, never to a different plaintext origin. */
function validateMetadataTransport(metadata: string, resource: URL): void {
  const url = transportUrl(metadata, 'resource metadata')
  if (url.protocol === 'http:' && url.origin !== resource.origin) {
    throw new Error('mcp-servers-file: invalid OAuth resource metadata URL')
  }
}

async function discoverResourceMetadataUrl(resource: string, fetchImpl: typeof fetch): Promise<string> {
  const probe = await fetchImpl(resource, {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    },
    body: '{}',
  })
  try {
    if (probe.status !== 401 && probe.status !== 403) {
      throw new Error('mcp-servers-file: MCP server did not request OAuth')
    }
    const challenge = probe.headers.get('www-authenticate')
    const fromHeader = parseResourceMetadata(challenge)
    return fromHeader ?? wellKnownProtectedResource(resource)
  } finally {
    await probe.body?.cancel().catch(() => undefined)
  }
}

function parseResourceMetadata(header: string | null): string | undefined {
  if (header === null || header.length === 0) return undefined
  const quoted = /resource_metadata="([^"]+)"/.exec(header)
  if (quoted?.[1] !== undefined) return quoted[1]
  const bare = /resource_metadata=([^\s,]+)/.exec(header)
  return bare?.[1]
}

/** RFC 8414: insert the well-known suffix before the issuer path. */
function issuerMetadataUrl(issuer: string): string {
  let url: URL
  try { url = new URL(issuer) } catch { throw new Error('mcp-servers-file: invalid OAuth issuer URL') }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || issuer.includes('?') || issuer.includes('#')) {
    throw new Error('mcp-servers-file: invalid OAuth issuer URL')
  }
  return `${url.origin}/.well-known/oauth-authorization-server${url.pathname.replace(/\/$/, '')}`
}

function wellKnownProtectedResource(resource: string): string {
  const url = new URL(resource)
  const path = url.pathname === '/' ? '' : url.pathname
  return `${url.origin}/.well-known/oauth-protected-resource${path}${url.search}`
}

async function registerClient(
  fetchImpl: typeof fetch,
  endpoint: string,
  redirectUri: string,
  scope: string,
): Promise<string> {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Relay Harness',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope,
    }),
  })
  const body = await readJson(response)
  const clientId = body.client_id
  if (typeof clientId !== 'string' || clientId.length === 0) {
    throw new Error(`mcp-servers-file: OAuth registration failed (${String(response.status)})`)
  }
  return clientId
}

async function exchangeCode(fetchImpl: typeof fetch, input: {
  tokenEndpoint: string
  clientId: string
  code: string
  redirectUri: string
  verifier: string
  resource: string
}): Promise<McpOAuthTokens> {
  const response = await fetchImpl(input.tokenEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.verifier,
      resource: input.resource,
    }),
  })
  const body = await readJson(response)
  if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
    throw new Error(`mcp-servers-file: OAuth token exchange failed (${String(response.status)})`)
  }
  return {
    access_token: body.access_token,
    ...typeof body.refresh_token === 'string' ? { refresh_token: body.refresh_token } : {},
    ...typeof body.token_type === 'string' ? { token_type: body.token_type } : {},
    ...typeof body.expires_in === 'number' ? { expires_in: body.expires_in } : {},
  }
}

async function getJson(fetchImpl: typeof fetch, url: string): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url)
  return readJson(response)
}

const MAX_OAUTH_RESPONSE_BYTES = 1024 * 1024

/** Consume at most one MiB of decoded response bytes; never trust Content-Length alone. */
async function readOAuthBody(response: Response): Promise<string> {
  const tooLarge = (): Error => new Error(`mcp-servers-file: OAuth response exceeds ${MAX_OAUTH_RESPONSE_BYTES} bytes`)
  if (Number(response.headers.get('content-length')) > MAX_OAUTH_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    throw tooLarge()
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_OAUTH_RESPONSE_BYTES) throw tooLarge()
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  return Buffer.concat(chunks, total).toString('utf8')
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`mcp-servers-file: OAuth HTTP request failed (${String(response.status)})`)
  }
  const text = await readOAuthBody(response)
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('mcp-servers-file: OAuth response is not a JSON object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('mcp-servers-file:')) throw error
    throw new Error(`mcp-servers-file: OAuth response is not JSON (${String(response.status)})`)
  }
}

function firstString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((entry: unknown): entry is string => typeof entry === 'string' && entry.length > 0)) {
    throw new Error(`mcp-servers-file: OAuth metadata ${field} must be an array of non-empty strings`)
  }
  return value[0]
}

/** Admit authorization endpoints before any listener, registration, or browser effects. */
function endpointUrl(value: unknown, field: string): string {
  const endpoint = requiredString(value, field)
  let url: URL
  try { url = new URL(endpoint) } catch { throw new Error(`mcp-servers-file: invalid OAuth ${field} URL`) }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || endpoint.includes('#')) {
    throw new Error(`mcp-servers-file: invalid OAuth ${field} URL`)
  }
  return endpoint
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`mcp-servers-file: OAuth metadata is missing ${field}`)
  }
  return value
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32))
  const challenge = b64url(createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

/**
 * Open one HTTP(S) authorization URL through the shared native runner with a cancellation deadline.
 * @param url - authorization URL, never a shell command or local file.
 * @param internals - platform and runner overrides for offline command-boundary tests.
 * @returns when the OS hand-off command exits successfully.
 */
export async function openBrowser(
  url: string,
  internals: { platform?: NodeJS.Platform; run?: NativeCommandRunner; signal?: AbortSignal } = {},
): Promise<void> {
  internals.signal?.throwIfAborted()
  let target: URL
  try { target = new URL(url) } catch { throw new Error('mcp-servers-file: invalid OAuth browser URL') }
  if (!['http:', 'https:'].includes(target.protocol) || target.username !== '' || target.password !== '' || target.hash !== '') {
    throw new Error('mcp-servers-file: invalid OAuth browser URL')
  }
  const platform = internals.platform ?? process.platform
  const command = platform === 'win32' ? 'powershell.exe' : platform === 'darwin' ? 'open' : 'xdg-open'
  const args = platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-Command', `Start-Process -FilePath '${target.href.replace(/'/g, "''")}'`]
    : [target.href]
  try {
    const timeout = AbortSignal.timeout(10_000)
    const signal = internals.signal === undefined ? timeout : AbortSignal.any([timeout, internals.signal])
    await (internals.run ?? runNativeCommand)(command, args, signal)
  } catch {
    // Native errors include argv and sometimes stderr; neither may expose an
    // authorization URL's transient state or provider-controlled diagnostics.
    throw new Error('mcp-servers-file: could not open OAuth browser')
  }
}

function createListener(): Promise<McpOAuthListener> {
  return new Promise((resolve, reject) => {
    let pending: { state: string; resolve: (code: string) => void; reject: (error: Error) => void } | undefined
    let closing: Promise<void> | undefined
    let closed = false
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let url: URL
      try { url = new URL(req.url ?? '/', 'http://127.0.0.1') } catch {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Invalid callback')
        return
      }
      if (url.pathname !== '/callback') {
        res.writeHead(404).end()
        return
      }
      const error = url.searchParams.get('error')
      const code = url.searchParams.get('code')
      const returnedState = url.searchParams.get('state')
      // Unauthenticated traffic cannot consume the active transaction, even
      // when it contains an OAuth error. Never reflect callback-controlled text.
      if (req.method !== 'GET' || pending === undefined || returnedState !== pending.state) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('Invalid callback')
        return
      }
      if (error !== null || code === null || code.length === 0) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('OAuth authorization failed')
        pending.reject(new Error('mcp-servers-file: OAuth authorization failed'))
        pending = undefined
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('Login complete. You can return to Relay Harness.')
      pending.resolve(code)
      pending = undefined
    })
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        const failure = new Error('mcp-servers-file: OAuth listener did not bind a TCP port')
        server.close(() => { reject(failure) })
        server.closeAllConnections()
        return
      }
      resolve({
        redirectUri: `http://127.0.0.1:${String(address.port)}/callback`,
        waitForCode: (state, timeoutMs) => new Promise((codeResolve, codeReject) => {
          if (closed) { codeReject(new Error('mcp-servers-file: OAuth listener closed')); return }
          if (pending !== undefined) { codeReject(new Error('mcp-servers-file: OAuth listener already waiting')); return }
          if (state.length === 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
            codeReject(new Error('mcp-servers-file: invalid OAuth listener state or timeout'))
            return
          }
          const timer = setTimeout(() => {
            pending = undefined
            codeReject(new Error('mcp-servers-file: OAuth login timed out'))
          }, timeoutMs)
          pending = {
            state,
            resolve: (code) => {
              clearTimeout(timer)
              codeResolve(code)
            },
            reject: (error) => {
              clearTimeout(timer)
              codeReject(error)
            },
          }
        }),
        close: () => {
          if (closing !== undefined) return closing
          closed = true
          pending?.reject(new Error('mcp-servers-file: OAuth listener closed'))
          pending = undefined
          closing = new Promise((closeResolve, closeReject) => {
            server.close((error) => {
              if (error !== undefined) closeReject(error)
              else closeResolve()
            })
            // Only this transaction's sockets: incomplete request bodies must
            // not retain the OAuth listener after owner cancellation.
            server.closeAllConnections()
          })
          return closing
        },
      })
    })
  })
}
