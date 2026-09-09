import * as homePaths from '@relay-harness/rlh-home-paths'
import type { FSWatcher } from 'chokidar'
import { createServer } from 'node:http'
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { defaultMounter, McpServersFile, resolveSpec } from '../src/service.ts'
import type { ChildHandle, McpClientMounter } from '../src/service.ts'
import { reportMcpClientStatus } from '@relay-harness/rlh-mcp-client'
import type { Config as McpClientConfig } from '@relay-harness/rlh-mcp-client'

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'rlh-mcp-servers-'))
}

function trackingMounter(mounted: McpClientConfig[]): McpClientMounter {
  return (_ctx, config): ChildHandle => {
    mounted.push(config)
    return {
      dispose: () => {
        const index = mounted.indexOf(config)
        if (index !== -1) mounted.splice(index, 1)
      },
      phase: () => 'active',
    }
  }
}

describe('McpServersFile', () => {
  it('exposes live child and composition connection health by serverName', async () => {
    const rlhHome = await home()
    const ctx = new Context()
    contexts.push(ctx)
    const mounted: McpClientConfig[] = []
    const service = new McpServersFile(ctx, { rlhHome, watch: false })
    service.useMounter(trackingMounter(mounted))
    const stop = service.start()
    await service.upsert({
      id: 'github',
      enabled: true,
      transport: 'stdio',
      serverName: 'github',
      command: 'npx',
    })

    // No mcp-client has reported for either server yet.
    expect(service.childHealth('github')).toBeUndefined()
    expect(service.connectionStatus('github')).toBeUndefined()
    expect(service.childHealth('missing-id')).toBeUndefined()

    reportMcpClientStatus(ctx.root, 'github', { health: 'reconnecting', lastError: 'Error: spawn failed' })
    expect(service.childHealth('github')).toMatchObject({ health: 'reconnecting', lastError: 'Error: spawn failed' })
    expect(service.connectionStatus('github')).toMatchObject({ health: 'reconnecting' })

    reportMcpClientStatus(ctx.root, 'github', undefined)
    expect(service.childHealth('github')).toBeUndefined()
    await stop()
  })

  it('loads an absent file as empty and writes an upsert', async () => {
    const rlhHome = await home()
    const ctx = new Context()
    contexts.push(ctx)
    const mounted: McpClientConfig[] = []
    const service = new McpServersFile(ctx, { rlhHome, watch: false })
    service.useMounter(trackingMounter(mounted))
    const stop = service.start()
    await service.upsert({
      id: 'github',
      enabled: true,
      transport: 'stdio',
      serverName: 'github',
      command: 'npx',
      env: { GITHUB_TOKEN: 'abc' },
    })
    const listed = service.listManaged()[0]
    expect(listed?.transport === 'stdio' && listed.env?.GITHUB_TOKEN).toBe('********')
    expect(mounted).toHaveLength(1)
    expect(mounted[0]).toMatchObject({ serverName: 'github', command: 'npx' })
    const text = await readFile(join(rlhHome, 'mcp-servers.yaml'), 'utf8')
    expect(text).toContain('github')
    expect(text).toContain('abc')
    await service.setEnabled('github', false)
    expect(mounted).toHaveLength(0)
    await service.remove('github')
    expect(service.listManaged()).toEqual([])
    await stop()
  })

  it('mounts enabled records from an existing file', async () => {
    const rlhHome = await home()
    await writeFile(join(rlhHome, 'mcp-servers.yaml'), `
servers:
  - id: http
    transport: streamable-http
    serverName: http
    url: http://127.0.0.1:9/mcp
`)
    const ctx = new Context()
    contexts.push(ctx)
    const mounted: McpClientConfig[] = []
    const service = new McpServersFile(ctx, { rlhHome, watch: false })
    service.useMounter(trackingMounter(mounted))
    service.start()
    await service.upsert({
      id: 'http',
      enabled: true,
      transport: 'streamable-http',
      serverName: 'http',
      url: 'http://127.0.0.1:9/mcp',
    })
    expect(mounted[0]).toMatchObject({ transport: 'streamable-http', url: 'http://127.0.0.1:9/mcp' })
    expect(service.childPhase('http')).toBe('active')
  })

  it('remounts when an enabled record changes', async () => {
    const rlhHome = await home()
    const ctx = new Context()
    contexts.push(ctx)
    const mounted: McpClientConfig[] = []
    const service = new McpServersFile(ctx, { rlhHome, watch: false })
    service.useMounter(trackingMounter(mounted))
    service.start()
    await service.upsert({
      id: 'github',
      enabled: true,
      transport: 'stdio',
      serverName: 'github',
      command: 'npx',
    })
    await service.upsert({
      id: 'github',
      enabled: true,
      transport: 'stdio',
      serverName: 'github',
      command: 'uvx',
    })
    expect(mounted).toHaveLength(1)
    expect(mounted[0]).toMatchObject({ command: 'uvx' })
  })

  it('remounts an enabled child without rewriting the document', async () => {
    const rlhHome = await home()
    const ctx = new Context()
    contexts.push(ctx)
    const mounted: McpClientConfig[] = []
    const service = new McpServersFile(ctx, { rlhHome, watch: false })
    service.useMounter(trackingMounter(mounted))
    service.start()
    await service.upsert({
      id: 'github',
      enabled: true,
      transport: 'stdio',
      serverName: 'github',
      command: 'npx',
    })
    const first = mounted[0]
    const before = await readFile(join(rlhHome, 'mcp-servers.yaml'), 'utf8')
    await service.remount('github')
    expect(mounted).toHaveLength(1)
    expect(mounted[0]).not.toBe(first)
    expect(mounted[0]).toMatchObject({ serverName: 'github', command: 'npx' })
    expect(await readFile(join(rlhHome, 'mcp-servers.yaml'), 'utf8')).toBe(before)
    await expect(service.remount('missing')).rejects.toThrow(/not in the managed document/)
  })

  it('authorize writes a bearer header for an HTTP server and remounts', async () => {
    const rlhHome = await home()
    const ctx = new Context()
    contexts.push(ctx)
    const mounted: McpClientConfig[] = []
    const service = new McpServersFile(ctx, { rlhHome, watch: false })
    service.useMounter(trackingMounter(mounted))
    service.useAuthorizeHttp(async (url) => {
      expect(url).toBe('https://mcp.example.test/mcp')
      return { access_token: 'tok-live' }
    })
    const stop = service.start()
    await service.upsert({
      id: 'remote',
      enabled: true,
      transport: 'streamable-http',
      serverName: 'remote',
      url: 'https://mcp.example.test/mcp',
    })
    await service.authorize('remote')
    expect(mounted[0]).toMatchObject({
      transport: 'streamable-http',
      headers: { Authorization: 'Bearer tok-live' },
    })
    expect(await readFile(join(rlhHome, 'mcp-servers.yaml'), 'utf8')).toContain('tok-live')
    await stop()
  })

  it('authorize refuses stdio and unknown ids', async () => {
    const rlhHome = await home()
    const ctx = new Context()
    contexts.push(ctx)
    const mounted: McpClientConfig[] = []
    const service = new McpServersFile(ctx, { rlhHome, watch: false })
    service.useMounter(trackingMounter(mounted))
    const stop = service.start()
    await service.upsert({
      id: 'github',
      enabled: true,
      transport: 'stdio',
      serverName: 'github',
      command: 'npx',
    })
    await expect(service.authorize('github')).rejects.toThrow(/HTTP/)
    await expect(service.authorize('missing')).rejects.toThrow(/not in the managed document/)
    await stop()
  })


  it.each([{ state: 2, phase: 'active' }, { state: 999, phase: null }])('defaultMounter reports fiber phase for $state', ({ state, phase }) => {
    const dispose = (): void => {}
    const ctx = {
      plugin: () => ({ dispose, state, await: () => Promise.resolve() }),
      logger: { error() {} },
    }
    const handle = defaultMounter(ctx as never, {
      transport: 'stdio',
      serverName: 'x',
      command: 'npx',
      args: [],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 1,
      failOnStartupError: false,
    })
    expect(handle.phase()).toBe(phase)
    void handle.dispose()
  })

  it('defaultMounter logs a child await rejection instead of throwing', async () => {
    const errors: unknown[] = []
    const ctx = {
      plugin: () => ({
        dispose: () => {},
        state: 3,
        await: () => Promise.reject(new Error('mcp apply failed')),
      }),
      logger: { error(error: unknown) { errors.push(error) } },
    }
    const handle = defaultMounter(ctx as never, {
      transport: 'stdio',
      serverName: 'x',
      command: 'npx',
      args: [],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 1,
      failOnStartupError: false,
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(errors).toHaveLength(1)
    expect(String(errors[0])).toContain('mcp apply failed')
    void handle.dispose()
  })
})

describe('OAuth credential commit ownership', () => {
  it.each(['service-url', 'disk-url', 'disk-remove', 'disk-stdio', 'disk-invalid'] as const)('refuses to attach an old endpoint token after %s changes', async (change) => {
    const rlhHome = await home()
    const ctx = new Context()
    contexts.push(ctx)
    const service = new McpServersFile(ctx, { rlhHome, watch: false })
    service.useMounter(trackingMounter([]))
    const entered = Promise.withResolvers<undefined>()
    const token = Promise.withResolvers<{ access_token: string }>()
    service.useAuthorizeHttp(async () => { entered.resolve(undefined); return token.promise })
    const stop = service.start()
    const original = {
      id: 'remote', enabled: true, transport: 'streamable-http' as const,
      serverName: 'remote', url: 'https://first.example.test/mcp',
    }
    let authorizing: Promise<void> | undefined
    try {
      await service.upsert(original)
      authorizing = service.authorize('remote')
      await entered.promise
      const replacement = { ...original, url: 'https://second.example.test/mcp' }
      if (change === 'service-url') await service.upsert(replacement)
      else {
        const servers = change === 'disk-remove' ? [] : change === 'disk-stdio'
          ? [{ id: 'remote', enabled: true, transport: 'stdio', serverName: 'remote', command: 'fixture-command' }]
          : [replacement]
        await writeFile(service.spec.filename, change === 'disk-invalid' ? 'servers: [' : JSON.stringify({ servers }))
      }
      const before = await readFile(service.spec.filename, 'utf8')
      token.resolve({ access_token: 'fixture-old-endpoint-token' })
      await expect(authorizing).rejects.toThrow(change.endsWith('url') ? 'changed during OAuth' : change === 'disk-invalid' ? 'refusing to modify an unreadable document' : 'not in the managed document')
      expect(await readFile(service.spec.filename, 'utf8')).toBe(before)
    } finally {
      token.resolve({ access_token: 'fixture-old-endpoint-token' })
      await authorizing?.catch(() => undefined)
      await stop()
    }
  })
})

it('preserves newer document fields while committing OAuth for the same endpoint', async () => {
  const rlhHome = await home()
  const ctx = new Context()
  contexts.push(ctx)
  const service = new McpServersFile(ctx, { rlhHome, watch: false })
  service.useMounter(trackingMounter([]))
  const entered = Promise.withResolvers<undefined>()
  const token = Promise.withResolvers<{ access_token: string }>()
  service.useAuthorizeHttp(async () => { entered.resolve(undefined); return token.promise })
  const stop = service.start()
  const original = { id: 'remote', enabled: true, transport: 'streamable-http' as const, serverName: 'remote', url: 'https://same.example.test/mcp' }
  let authorizing: Promise<void> | undefined
  try {
    await service.upsert(original)
    authorizing = service.authorize('remote')
    await entered.promise
    const latest = { ...original, enabled: false, serverName: 'renamed', headers: { 'X-Trace': 'latest' } }
    const other = { id: 'other', enabled: false, transport: 'stdio', serverName: 'other', command: 'fixture-command' }
    await writeFile(service.spec.filename, JSON.stringify({ servers: [latest, other] }))
    token.resolve({ access_token: 'fixture-current-token' })
    await authorizing
    const saved = service.listManaged()
    expect(saved).toHaveLength(2)
    expect(saved[0]).toMatchObject({ ...latest, headers: { 'X-Trace': 'latest', Authorization: '********' } })
    expect(saved[1]).toMatchObject(other)
    expect(await readFile(service.spec.filename, 'utf8')).toContain('Bearer fixture-current-token')
  } finally {
    token.resolve({ access_token: 'fixture-current-token' })
    await authorizing?.catch(() => undefined)
    await stop()
  }
})

describe('MCP service shutdown admission', () => {
  it('refuses new work and late OAuth persistence after shutdown', async () => {
    const rlhHome = await home()
    const ctx = new Context()
    contexts.push(ctx)
    const service = new McpServersFile(ctx, { rlhHome, watch: false })
    const mounted: McpClientConfig[] = []
    service.useMounter(trackingMounter(mounted))
    let logins = 0
    let authorizationSignal: AbortSignal | undefined
    const entered = Promise.withResolvers<undefined>()
    const token = Promise.withResolvers<{ access_token: string }>()
    service.useAuthorizeHttp(async (_url, signal) => {
      authorizationSignal = signal
      logins += 1
      entered.resolve(undefined)
      return token.promise
    })
    const stop = service.start()
    const row = { id: 'remote', enabled: true, transport: 'streamable-http' as const, serverName: 'remote', url: 'https://same.example.test/mcp' }
    await service.upsert(row)
    const login = service.authorize('remote')
    await entered.promise
    const before = await readFile(service.spec.filename, 'utf8')
    const closing = stop()
    expect(authorizationSignal?.aborted).toBe(true)
    token.resolve({ access_token: 'fixture-late-token' })
    await closing
    await expect(login).rejects.toThrow('service is closed')
    await expect(service.authorize('remote')).rejects.toThrow('service is closed')
    await expect(service.upsert(row)).rejects.toThrow('service is closed')
    await expect(service.remove('remote')).rejects.toThrow('service is closed')
    await expect(service.setEnabled('remote', false)).rejects.toThrow('service is closed')
    await expect(service.remount('remote')).rejects.toThrow('service is closed')
    expect(logins).toBe(1)
    expect(mounted).toEqual([])
    expect(await readFile(service.spec.filename, 'utf8')).toBe(before)
  })

  it.each(['replacement', 'remount'] as const)('drains an in-flight %s before cleanup and never remounts after closing', async (operation) => {
    const rlhHome = await home()
    const ctx = new Context()
    contexts.push(ctx)
    const service = new McpServersFile(ctx, { rlhHome, watch: false })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let mounts = 0
    let disposals = 0
    service.useMounter(() => {
      mounts += 1
      return { phase: () => 'active', dispose: async () => { disposals += 1; entered.resolve(undefined); await release.promise } }
    })
    const stop = service.start()
    const row = { id: 'local', enabled: true, transport: 'stdio' as const, serverName: 'local', command: 'first' }
    await service.upsert(row)
    const replacing = operation === 'remount' ? service.remount(row.id) : service.upsert({ ...row, command: 'second' })
    await entered.promise
    const closing = stop()
    try {
      expect(closing).toBeInstanceOf(Promise)
      expect(stop()).toBe(closing)
    } finally {
      release.resolve(undefined)
      await replacing
      await closing
    }
    expect(mounts).toBe(1)
    expect(disposals).toBe(1)
  })
})


it('awaits every child disposal before reporting shutdown failures', async () => {
  const rlhHome = await home()
  const ctx = new Context()
  contexts.push(ctx)
  const service = new McpServersFile(ctx, { rlhHome, watch: false })
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  let disposals = 0
  service.useMounter((_ctx, config) => ({
    phase: () => 'active',
    dispose: async () => {
      disposals += 1
      if (config.serverName === 'failed') throw new Error('fixture child failure')
      entered.resolve(undefined)
      await release.promise
    },
  }))
  const stop = service.start()
  for (const serverName of ['failed', 'held']) {
    await service.upsert({ id: serverName, enabled: true, transport: 'stdio', serverName, command: 'fixture' })
  }
  const closing = stop()
  let settled = false
  const outcome = closing.then(() => undefined, (error: unknown) => error).finally(() => { settled = true })
  try {
    await entered.promise
    expect(settled).toBe(false)
    expect(disposals).toBe(2)
    release.resolve(undefined)
    expect(await outcome).toBeInstanceOf(AggregateError)
    expect(stop()).toBe(closing)
    expect(() => service.start()).toThrow('service is closed')
  } finally {
    release.resolve(undefined)
    await outcome
  }
})


it('service shutdown cancels its default OAuth transport and waits for settlement', async () => {
  const entered = Promise.withResolvers<undefined>()
  const peerClosed = Promise.withResolvers<undefined>()
  const server = createServer((_req, res) => {
    res.once('close', () => { peerClosed.resolve(undefined) })
    entered.resolve(undefined)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('fixture address missing')
  const rlhHome = await home()
  const ctx = new Context()
  contexts.push(ctx)
  const service = new McpServersFile(ctx, { rlhHome, watch: false })
  service.useMounter(trackingMounter([]))
  const stop = service.start()
  try {
    await service.upsert({
      id: 'remote', enabled: false, transport: 'streamable-http', serverName: 'remote',
      url: `http://127.0.0.1:${address.port}/mcp`,
    })
    const before = await readFile(service.spec.filename, 'utf8')
    const outcome = service.authorize('remote').then(() => undefined, (error: unknown) => error)
    await Promise.race([entered.promise, outcome.then(() => { throw new Error('OAuth ended before transport admission') })])
    await stop()
    expect(await outcome).toBeInstanceOf(Error)
    await peerClosed.promise
    expect(await readFile(service.spec.filename, 'utf8')).toBe(before)
  } finally {
    await stop()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
})

it('returns a detached raw snapshot without exposing the service-owned rows', async () => {
  const rlhHome = await home()
  const ctx = new Context()
  contexts.push(ctx)
  const service = new McpServersFile(ctx, { rlhHome, watch: false })
  const mounted: McpClientConfig[] = []
  service.useMounter(trackingMounter(mounted))
  const stop = service.start()
  try {
    await service.upsert({
      id: 'remote', enabled: true, transport: 'streamable-http', serverName: 'remote',
      url: 'https://same.example.test/mcp', headers: { Authorization: 'Bearer fixture-original' },
    })
    const before = await readFile(service.spec.filename, 'utf8')
    const snapshot = service.listManagedRaw()
    const row = snapshot[0]
    if (row?.transport !== 'streamable-http' || row.headers === undefined) throw new Error('fixture row missing')
    Reflect.set(row.headers, 'Authorization', 'Bearer fixture-mutated')
    Reflect.set(row, 'url', 'https://different.example.test/mcp')
    Reflect.set(snapshot, 'length', 0)
    const current = service.listManagedRaw()
    expect(current).toHaveLength(1)
    expect(current[0]).toMatchObject({
      url: 'https://same.example.test/mcp', headers: { Authorization: 'Bearer fixture-original' },
    })
    expect(mounted[0]).toMatchObject({ headers: { Authorization: 'Bearer fixture-original' } })
    expect(await readFile(service.spec.filename, 'utf8')).toBe(before)
  } finally {
    await stop()
  }
})

it('detaches masked stdio rows and nested arguments from live configuration', async () => {
  const rlhHome = await home()
  const ctx = new Context()
  contexts.push(ctx)
  const service = new McpServersFile(ctx, { rlhHome, watch: false })
  const mounted: McpClientConfig[] = []
  service.useMounter(trackingMounter(mounted))
  const stop = service.start()
  try {
    await service.upsert({ id: 'local', enabled: true, transport: 'stdio', serverName: 'local', command: 'original', args: ['original-arg'] })
    const snapshot = service.listManaged()
    const row = snapshot[0]
    if (row?.transport !== 'stdio' || row.args === undefined) throw new Error('fixture stdio row missing')
    Reflect.set(row, 'command', 'changed')
    Reflect.set(row.args, '0', 'changed-arg')
    expect(service.listManagedRaw()[0]).toMatchObject({ command: 'original', args: ['original-arg'] })
    expect(mounted[0]).toMatchObject({ command: 'original', args: ['original-arg'] })
  } finally {
    await stop()
  }
})


it('reloads an external edit back to a previously self-written document', async () => {
  const rlhHome = await home()
  const ctx = new Context()
  contexts.push(ctx)
  const mounted: McpClientConfig[] = []
  const service = new McpServersFile(ctx, { rlhHome, watch: true, debounceMs: 5 })
  service.useMounter(trackingMounter(mounted))
  const stop = service.start()
  const warnings = vi.spyOn(ctx.logger, 'warn')
  try {
    const row = { id: 'local', enabled: true, transport: 'stdio' as const, serverName: 'local', command: 'first' }
    await service.upsert(row)
    const original = await readFile(service.spec.filename, 'utf8')
    const watcherView = service as unknown as { watcher?: { getWatched(): Record<string, string[]> } }
    await vi.waitFor(() => {
      expect(Object.values(watcherView.watcher?.getWatched() ?? {}).flat()).toContain('mcp-servers.yaml')
    }, { timeout: 5000 })
    await writeFile(service.spec.filename, JSON.stringify({ servers: [{ ...row, command: 'second' }] }))
    await vi.waitFor(() => { expect(mounted[0]).toMatchObject({ command: 'second' }) }, { timeout: 5000 })
    await writeFile(service.spec.filename, original)
    await vi.waitFor(() => { expect(mounted[0]).toMatchObject({ command: 'first' }) }, { timeout: 1500 })
    expect(service.listManaged()[0]).toMatchObject({ command: 'first' })
    expect(await readFile(service.spec.filename, 'utf8')).toBe(original)
    await writeFile(service.spec.filename, 'servers: [')
    await vi.waitFor(() => { expect(warnings).toHaveBeenCalled() }, { timeout: 5000 })
    expect(service.listManaged()[0]).toMatchObject({ command: 'first' })
    expect(mounted[0]).toMatchObject({ command: 'first' })
    expect(await readFile(service.spec.filename, 'utf8')).toBe('servers: [')
    await writeFile(service.spec.filename, JSON.stringify({ servers: [{ ...row, enabled: false }] }))
    await vi.waitFor(() => { expect(mounted).toEqual([]) }, { timeout: 5000 })
    await unlink(service.spec.filename)
    await vi.waitFor(() => { expect(service.listManaged()).toEqual([]) }, { timeout: 5000 })
    await writeFile(service.spec.filename, original)
    await vi.waitFor(() => { expect(mounted[0]).toMatchObject({ command: 'first' }) }, { timeout: 5000 })
    await stop()
    expect(watcherView.watcher?.getWatched()).toEqual({})
    expect(mounted).toEqual([])
  } finally {
    warnings.mockRestore()
    await stop()
  }
})


it('contains watcher error events without reflecting details or losing the current configuration', async () => {
  const rlhHome = await home()
  const ctx = new Context()
  contexts.push(ctx)
  const mounted: McpClientConfig[] = []
  const service = new McpServersFile(ctx, { rlhHome, watch: true, debounceMs: 5 })
  service.useMounter(trackingMounter(mounted))
  const stop = service.start()
  const warning = vi.spyOn(ctx.logger, 'warn')
  try {
    const row = { id: 'local', enabled: true, transport: 'stdio' as const, serverName: 'local', command: 'first' }
    await service.upsert(row)
    const watcher = (service as unknown as { watcher: FSWatcher }).watcher
    await vi.waitFor(() => { expect(Object.values(watcher.getWatched()).flat()).toContain('mcp-servers.yaml') }, { timeout: 5000 })
    expect(() => watcher.emit('error', new Error('fixture-private-watcher-detail'))).not.toThrow()
    expect(warning).toHaveBeenCalledWith('mcp-servers-file: watcher error; keeping current configuration')
    expect(warning.mock.calls.flat().some(value => String(value).includes('fixture-private-watcher-detail'))).toBe(false)
    expect(mounted[0]).toMatchObject({ command: 'first' })
    await writeFile(service.spec.filename, JSON.stringify({ servers: [{ ...row, command: 'after-error' }] }))
    await vi.waitFor(() => { expect(mounted[0]).toMatchObject({ command: 'after-error' }) }, { timeout: 5000 })
  } finally {
    warning.mockRestore()
    await stop()
  }
})

it('observes background startup failure without replacing its rejection or leaking details', async () => {
  const rlhHome = await home()
  const ctx = new Context()
  contexts.push(ctx)
  const service = new McpServersFile(ctx, { rlhHome, watch: false })
  const failure = new Error('fixture-private-startup-detail')
  const warning = vi.spyOn(ctx.logger, 'warn')
  service.useMounter(() => { throw failure })
  await writeFile(service.spec.filename, JSON.stringify({ servers: [
    { id: 'local', enabled: true, transport: 'stdio', serverName: 'local', command: 'fixture' },
  ] }))
  const stop = service.start()
  try {
    await vi.waitFor(() => { expect(warning).toHaveBeenCalledWith('mcp-servers-file: startup failed') })
    await expect(service.authorize('local')).rejects.toBe(failure)
    expect(warning.mock.calls.flat().some(value => String(value).includes('fixture-private-startup-detail'))).toBe(false)
    await expect(stop()).rejects.toThrow('shutdown failed')
  } finally {
    warning.mockRestore()
    await stop().catch(() => undefined)
  }
})

it('does not echo malformed configuration contents into background diagnostics', async () => {
  const rlhHome = await home()
  const ctx = new Context()
  contexts.push(ctx)
  const service = new McpServersFile(ctx, { rlhHome, watch: false })
  service.useMounter(trackingMounter([]))
  const warning = vi.spyOn(ctx.logger, 'warn')
  await writeFile(service.spec.filename, 'servers: [fixture-private-config')
  const stop = service.start()
  try {
    await vi.waitFor(() => { expect(warning).toHaveBeenCalled() })
    expect(warning.mock.calls.flat().some(value => String(value).includes('fixture-private-config'))).toBe(false)
    expect(service.listManaged()).toEqual([])
    expect(await readFile(service.spec.filename, 'utf8')).toBe('servers: [fixture-private-config')
  } finally {
    warning.mockRestore()
    await stop()
  }
})

it('refuses repeated startup before creating a second background owner', async () => {
  const rlhHome = await home()
  const ctx = new Context()
  contexts.push(ctx)
  const service = new McpServersFile(ctx, { rlhHome, watch: true, debounceMs: 5 })
  const mounted: McpClientConfig[] = []
  service.useMounter(trackingMounter(mounted))
  const stop = service.start()
  try {
    expect(() => service.start()).toThrow('already started')
    await service.upsert({ id: 'local', enabled: true, transport: 'stdio', serverName: 'local', command: 'fixture' })
    expect(mounted).toHaveLength(1)
  } finally {
    await stop()
  }
  expect(mounted).toEqual([])
})

it('finishes child cleanup after watcher-close failure and rejects retained callbacks', async () => {
  const rlhHome = await home()
  const ctx = new Context()
  contexts.push(ctx)
  const mounted: McpClientConfig[] = []
  const service = new McpServersFile(ctx, { rlhHome, watch: true, debounceMs: 5 })
  service.useMounter(trackingMounter(mounted))
  const stop = service.start()
  let restoreClose: (() => void) | undefined
  try {
    await service.upsert({ id: 'local', enabled: true, transport: 'stdio', serverName: 'local', command: 'fixture' })
    const watcher = (service as unknown as { watcher: FSWatcher }).watcher
    const onAll = watcher.listeners('all')[0]
    const onError = watcher.listeners('error')[0]
    if (onAll === undefined || onError === undefined) throw new Error('watcher callbacks missing')
    const close = watcher.close.bind(watcher)
    const failedClose = vi.spyOn(watcher, 'close').mockImplementation(async () => {
      await close()
      throw new Error('fixture watcher close failed')
    })
    restoreClose = () => { failedClose.mockRestore() }
    await expect(stop()).rejects.toThrow('shutdown failed')
    expect(mounted).toEqual([])
    expect(watcher.getWatched()).toEqual({})
    const operations: unknown = Reflect.get(service, 'operations')
    expect(operations).toBeInstanceOf(Promise)
    const warn = vi.spyOn(ctx.logger, 'warn')
    try {
      onAll('change', service.spec.filename)
      onError(new Error('late error'))
      expect(Reflect.get(service, 'operations')).toBe(operations)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  } finally {
    restoreClose?.()
    await stop().catch(() => undefined)
  }
})


it('rechecks admission after awaiting startup and leaves absent child phase empty', async () => {
  const rlhHome = await home()
  const ctx = new Context()
  contexts.push(ctx)
  const service = new McpServersFile(ctx, { rlhHome, watch: true })
  const authorize = vi.fn(async () => ({ access_token: 'fixture-never-requested' }))
  service.useAuthorizeHttp(authorize)
  service.useMounter(trackingMounter([]))
  const stop = service.start()
  const login = service.authorize('not-created')
  const closing = stop()
  await expect(login).rejects.toThrow('service is closed')
  await closing
  expect(authorize).not.toHaveBeenCalled()
  expect(service.childPhase('not-created')).toBeNull()
})


it('keeps watch enabled by default and remounting a disabled absent child is a no-op', async () => {
  const rlhHome = await home()
  expect(resolveSpec({ rlhHome }).watch).toBe(true)
  const ctx = new Context()
  contexts.push(ctx)
  const service = new McpServersFile(ctx, { rlhHome, watch: false })
  const mount = vi.fn<McpClientMounter>()
  service.useMounter(mount)
  const stop = service.start()
  try {
    await service.upsert({ id: 'local', enabled: false, transport: 'stdio', serverName: 'local', command: 'fixture' })
    await service.remount('local')
    expect(mount).not.toHaveBeenCalled()
  } finally {
    await stop()
  }
})

it('does not publish a watcher if shutdown wins path canonicalization', async () => {
  const rlhHome = await home()
  const ctx = new Context()
  contexts.push(ctx)
  const service = new McpServersFile(ctx, { rlhHome, watch: true })
  service.useMounter(trackingMounter([]))
  const original = homePaths.canonicalizeWatchPath
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const canonicalize = vi.spyOn(homePaths, 'canonicalizeWatchPath').mockImplementation(async (path) => {
    entered.resolve(undefined)
    await release.promise
    return original(path)
  })
  const stop = service.start()
  try {
    await entered.promise
    const closing = stop()
    release.resolve(undefined)
    await closing
    expect(Reflect.get(service, 'watcher')).toBeUndefined()
  } finally {
    release.resolve(undefined)
    await stop()
    canonicalize.mockRestore()
  }
})

it.each(['replace', 'delete'] as const)('reconciles a %s between initial read and watcher readiness without another write', async (operation) => {
  const rlhHome = await home()
  const ctx = new Context()
  contexts.push(ctx)
  const mounted: McpClientConfig[] = []
  const service = new McpServersFile(ctx, { rlhHome, watch: true, debounceMs: 5 })
  service.useMounter(trackingMounter(mounted))
  const row = { id: 'local', enabled: true, transport: 'stdio', serverName: 'local', command: 'first' }
  await writeFile(service.spec.filename, JSON.stringify({ servers: [row] }))
  const original = homePaths.canonicalizeWatchPath
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const canonicalize = vi.spyOn(homePaths, 'canonicalizeWatchPath').mockImplementation(async (path) => {
    entered.resolve(undefined)
    await release.promise
    return original(path)
  })
  const stop = service.start()
  try {
    await entered.promise
    expect(mounted[0]).toMatchObject({ command: 'first' })
    if (operation === 'delete') await unlink(service.spec.filename)
    else await writeFile(service.spec.filename, JSON.stringify({ servers: [{ ...row, command: 'second' }] }))
    release.resolve(undefined)
    if (operation === 'delete') {
      await vi.waitFor(() => { expect(mounted).toEqual([]) }, { timeout: 1500 })
      expect(service.listManaged()).toEqual([])
    } else {
      await vi.waitFor(() => { expect(mounted[0]).toMatchObject({ command: 'second' }) }, { timeout: 1500 })
      expect(service.listManaged()[0]).toMatchObject({ command: 'second' })
      expect(mounted).toHaveLength(1)
    }
  } finally {
    release.resolve(undefined)
    await stop()
    canonicalize.mockRestore()
  }
})
