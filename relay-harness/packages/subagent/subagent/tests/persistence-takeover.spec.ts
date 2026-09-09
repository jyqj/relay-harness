import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@relay-harness/cordis'
import SessionStore, { Session, SessionId, installSessionPersistenceFence, type SessionPersistenceFence } from '@relay-harness/rlh-session'
import JsonlSessionPersistence from '@relay-harness/rlh-session-persistence-jsonl'
import SqliteSessionPersistence from '@relay-harness/rlh-session-persistence-sqlite'
import { SqliteStore } from '../../../session/session-persistence-sqlite/src/store.ts'
import { SubagentActivationLeaseStore } from '../src/activation-lease.ts'

const leaseModule = new URL('../src/activation-lease.ts', import.meta.url).href
const rootPath = fileURLToPath(new URL('../../../../', import.meta.url))
const childEnvironment = () => ({ ...process.env, TSX_TSCONFIG_PATH: join(rootPath, 'tsconfig.host.json') })
const sourceArgs = ['--disable-warning=ExperimentalWarning', '--import', 'tsx/esm', '--input-type=module', '-e']
const exec = promisify(execFile)

async function takeover(path: string, id: string): Promise<{ code: string; fence?: number }> {
  const code = `
    import { SubagentActivationLeaseStore } from ${JSON.stringify(leaseModule)};
    const store = new SubagentActivationLeaseStore(${JSON.stringify(path)});
    try {
      const lease = store.acquire(${JSON.stringify(id)}, 5000);
      console.log(JSON.stringify({code:'acquired', fence:lease.fence}));
      lease.release();
    } catch (error) { console.log(JSON.stringify({code:error.code})); }
    finally { store.close(); }
  `
  const { stdout } = await exec(process.execPath, [...sourceArgs, code], { cwd: rootPath, env: childEnvironment(), timeout: 10_000 })
  return JSON.parse(stdout.trim()) as { code: string; fence?: number }
}

/** Delay a real storage operation at the exact observed takeover boundary. */
function pauseAtGate(entered: (value: undefined) => void, release: Promise<unknown>) {
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    entered(undefined)
    await release
    return operation()
  }
}

describe('cross-process persistence takeover', () => {
  it.each(['jsonl', 'sqlite'] as const)('excludes a second owner until the actual %s commit settles', async (backend) => {
    const root = mkdtempSync(join(tmpdir(), 'rlh-commit-takeover-'))
    const path = join(root, 'leases.sqlite3')
    const store = new SubagentActivationLeaseStore(path)
    const ctx = new Context()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let uninstall: (() => void) | undefined
    await ctx.plugin(SessionStore)
    const pause = pauseAtGate(entered.resolve, release.promise)
    // oxlint-disable-next-line typescript/unbound-method -- instrumentation restores the receiver with apply.
    const originalJsonl = JsonlSessionPersistence.prototype.appendBatch
    // oxlint-disable-next-line typescript/unbound-method -- instrumentation restores the receiver with apply.
    const originalSqlite = SqliteStore.prototype.appendBatch
    const spy = backend === 'jsonl'
      ? vi.spyOn(JsonlSessionPersistence.prototype, 'appendBatch').mockImplementation(function (this: JsonlSessionPersistence, ...args) {
        return pause(() => originalJsonl.apply(this, args))
      })
      : vi.spyOn(SqliteStore.prototype, 'appendBatch').mockImplementation(function (this: SqliteStore, ...args) {
        return pause(() => originalSqlite.apply(this, args))
      })
    try {
      if (backend === 'jsonl') await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
      else await ctx.plugin(SqliteSessionPersistence, { path: join(root, 'sessions.sqlite3') })
      const id = SessionId(`commit-${backend}`)
      const session = ctx.sessions.create(id)
      const lease = store.acquire(id, 200)
      uninstall = installSessionPersistenceFence(session, {
        token: `${lease.ownerToken}:${lease.fence}`,
        assertCurrent: () => { lease.assertCurrent() },
        runExclusive: operation => lease.runExclusive(operation),
      })
      session.append('turn/start', { turn: 1 })
      const flush = ctx.sessions.flush(session)
      await entered.promise
      await new Promise(resolve => setTimeout(resolve, Math.max(0, lease.expiresAt - Date.now() + 20)))
      expect(await takeover(path, id)).toEqual({ code: 'LEASE_HELD' })
      release.resolve(undefined)
      await flush
      const persisted = await ctx.sessionPersistence.readFrom(id, 0)
      expect(persisted.events.map(event => event.type)).toEqual(['turn/start'])
      expect(await takeover(path, id)).toEqual({ code: 'acquired', fence: lease.fence + 1 })
      expect(() => session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })).toThrow()
    } finally {
      release.resolve(undefined)
      spy.mockRestore()
      uninstall?.()
      await ctx.fiber.dispose().catch(() => undefined)
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('releases the OS mutation lock after the owning process dies', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rlh-mutation-crash-'))
    const path = join(root, 'leases.sqlite3')
    const code = `
      import { SubagentActivationLeaseStore } from ${JSON.stringify(leaseModule)};
      const store = new SubagentActivationLeaseStore(${JSON.stringify(path)});
      const lease = store.acquire('crashed-child', 100);
      await lease.runExclusive(async () => {
        console.log('locked');
        await new Promise(() => { setInterval(() => {}, 1000); });
      });
    `
    const child = spawn(process.execPath, [...sourceArgs, code], { cwd: rootPath, env: childEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    try {
      const chunks: readonly unknown[] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(10_000) })
      expect(String(chunks[0])).toContain('locked')
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(await takeover(path, 'crashed-child')).toEqual({ code: 'LEASE_HELD' })
      child.kill('SIGKILL')
      await exited
      expect(await takeover(path, 'crashed-child')).toEqual({ code: 'acquired', fence: 2 })
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await exited
      rmSync(root, { recursive: true, force: true })
    }
  })
  it.each(['jsonl', 'sqlite'] as const)('a rolled-back fenced %s preparation is not reused by the successor owner', async (backend) => {
    const root = mkdtempSync(join(tmpdir(), 'rlh-fenced-prepare-retry-'))
    const store = new SubagentActivationLeaseStore(join(root, 'leases.sqlite3'))
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    if (backend === 'jsonl') await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
    else await ctx.plugin(SqliteSessionPersistence, { path: join(root, 'sessions.sqlite3') })
    const id = SessionId(`failed-prepare-${backend}`)
    const seeded = Session.create(id)
    seeded.append('turn/start', { turn: 1 })
    seeded.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessionPersistence.create(seeded.header)
    await ctx.sessionPersistence.append(id, seeded.events)
    const first = store.acquire(id, 10_000)
    const proof = (lease: typeof first): SessionPersistenceFence => ({
      token: `${lease.ownerToken}:${lease.fence}`,
      assertCurrent: () =>{  lease.assertCurrent() },
      runExclusive: operation => lease.runExclusive(operation),
    })
    let detach: (() => void) | undefined
    let retire: (() => void) | undefined
    let next: Awaited<ReturnType<typeof ctx.sessionPersistence.prepare>> | undefined
    let successor: typeof first | undefined
    try {
      const prepared = await ctx.sessionPersistence.prepare(id, undefined, proof(first))
      const oldSession = prepared.session
      const retireOld = installSessionPersistenceFence(oldSession, proof(first))
      // Resume setup failed without appending anything. Its reservation releases
      // before continuation rollback retires the lifetime proof, exactly as the real call chain does.
      prepared[Symbol.dispose]()
      retireOld()
      first.release()
      successor = store.acquire(id, 10_000)
      next = await ctx.sessionPersistence.prepare(id, undefined, proof(successor))
      expect(next.session).not.toBe(oldSession)
      retire = installSessionPersistenceFence(next.session, proof(successor))
      detach = ctx.sessions.enter(next.session)
      ctx.sessions.announce(next.session)
      next.session.append('turn/start', { turn: 2 })
      next.session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      await ctx.sessions.flush(next.session)
      const persisted = await ctx.sessionPersistence.readFrom(id, 0)
      expect(persisted.events.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2])
      expect(persisted.events.map(event => event.seq)).toEqual(persisted.events.map((_event, index) => index))
      expect(() => oldSession.append('turn/start', { turn: 99 })).toThrow(/retired/)
    } finally {
      detach?.()
      next?.[Symbol.dispose]()
      await ctx.fiber.dispose().catch(() => undefined)
      retire?.()
      try { successor?.release() } catch { /* An earlier failure may leave no acquired successor. */ }
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.each(['jsonl', 'sqlite'] as const)('a queued stale %s owner cannot overwrite a successor process commit', async (backend) => {
    const root = mkdtempSync(join(tmpdir(), 'rlh-queued-stale-owner-'))
    const leasePath = join(root, 'leases.sqlite3')
    const store = new SubagentActivationLeaseStore(leasePath)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const config = backend === 'jsonl' ? { root: join(root, 'sessions') } : { path: join(root, 'sessions.sqlite3') }
    if (backend === 'jsonl') await ctx.plugin(JsonlSessionPersistence, { root: join(root, 'sessions') })
    else await ctx.plugin(SqliteSessionPersistence, { path: join(root, 'sessions.sqlite3') })
    const id = SessionId(`queued-stale-${backend}`)
    const session = ctx.sessions.create(id)
    const lease = store.acquire(id, 1_000)
    const retire = installSessionPersistenceFence(session, {
      token: `${lease.ownerToken}:${lease.fence}`,
      assertCurrent: () =>{  lease.assertCurrent() }, runExclusive: operation => lease.runExclusive(operation),
    })
    session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ctx.sessions.flush(session)
    const entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    // Only delay a real read, never replace a storage mutation. The successor
    // process uses the real provider to commit before this owner's queue resumes.
    // oxlint-disable-next-line typescript/unbound-method -- the read instrumentation restores its receiver with apply.
    const jsonlRead = JsonlSessionPersistence.prototype.loadStored
    // oxlint-disable-next-line typescript/unbound-method -- the read instrumentation restores its receiver with apply.
    const sqliteRead = SqliteStore.prototype.loadStoredFrom
    const pause = pauseAtGate(entered.resolve, release.promise)
    const blockedRead = backend === 'jsonl'
      ? vi.spyOn(JsonlSessionPersistence.prototype, 'loadStored').mockImplementation(function (this: JsonlSessionPersistence, ...args) { return pause(() => jsonlRead.apply(this, args)) })
      : vi.spyOn(SqliteStore.prototype, 'loadStoredFrom').mockImplementation(function (this: SqliteStore, ...args) { return pause(() => sqliteRead.apply(this, args)) })
    let flush: Promise<unknown> | undefined
    try {
      const reading = ctx.sessionPersistence.readFrom(id, 0)
      await entered.promise
      session.append('turn/start', { turn: 99 })
      session.append('turn/end', { turn: 99, reason: { kind: 'completed' } })
      flush = ctx.sessions.flush(session)
      void flush.catch(() => undefined)
      await new Promise(resolve => setTimeout(resolve, Math.max(0, lease.expiresAt - Date.now() + 20)))
      const provider = new URL(`../../../session/session-persistence-${backend}/src/index.ts`, import.meta.url).href
      const code = `
        import { Context } from '@relay-harness/cordis';
        import SessionStore, { SessionId, installSessionPersistenceFence } from '@relay-harness/rlh-session';
        import Provider from ${JSON.stringify(provider)};
        import { SubagentActivationLeaseStore } from ${JSON.stringify(leaseModule)};
        const ctx = new Context(); await ctx.plugin(SessionStore); await ctx.plugin(Provider, ${JSON.stringify(config)});
        const store = new SubagentActivationLeaseStore(${JSON.stringify(leasePath)});
        const id = SessionId(${JSON.stringify(id)}), lease = store.acquire(id, 10000);
        const proof = { token: lease.ownerToken+':'+lease.fence, assertCurrent: () => lease.assertCurrent(), runExclusive: operation => lease.runExclusive(operation) };
        const prepared = await ctx.sessionPersistence.prepare(id, undefined, proof);
        const retire = installSessionPersistenceFence(prepared.session, proof);
        const detach = ctx.sessions.enter(prepared.session); ctx.sessions.announce(prepared.session);
        prepared.session.append('turn/start', {turn: 2});
        prepared.session.append('turn/end', {turn: 2, reason: {kind:'completed'}});
        await ctx.sessions.flush(prepared.session);
        const stored = await ctx.sessionPersistence.readFrom(id, 0);
        console.log(JSON.stringify({fence:lease.fence, turns:stored.events.filter(event => event.type==='turn/start').map(event => event.data.turn)}));
        detach(); prepared[Symbol.dispose](); await ctx.fiber.dispose(); retire(); lease.release(); store.close();
      `
      const { stdout } = await exec(process.execPath, [...sourceArgs, code], { cwd: rootPath, env: childEnvironment(), timeout: 15_000 })
      expect(JSON.parse(stdout.trim())).toEqual({ fence: lease.fence + 1, turns: [1, 2] })
      release.resolve(undefined)
      await reading
      await expect(flush).rejects.toThrow(/no longer owned/)
      const persisted = await ctx.sessionPersistence.readFrom(id, 0)
      expect(persisted.events.filter(event => event.type === 'turn/start').map(event => event.data.turn)).toEqual([1, 2])
    } finally {
      release.resolve(undefined)
      blockedRead.mockRestore()
      await flush?.catch(() => undefined)
      await ctx.fiber.dispose().catch(() => undefined)
      retire()
      store.close()
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)

})
