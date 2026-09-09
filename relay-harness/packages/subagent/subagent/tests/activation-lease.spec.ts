import { existsSync, linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { loadNodeSqlite } from '@relay-harness/rlh-sqlite-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@relay-harness/rlh-session'
import {
  SubagentActivationLeaseError,
  SubagentActivationLeaseStore,
} from '../src/activation-lease.ts'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  syncBuiltinESMExports()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function stores() {
  const root = mkdtempSync(join(tmpdir(), 'rlh-subagent-lease-'))
  roots.push(root)
  const path = join(root, 'leases.sqlite3')
  return {
    first: new SubagentActivationLeaseStore(path),
    second: new SubagentActivationLeaseStore(path),
  }
}

describe('SubagentActivationLeaseStore', () => {
  it('rejects a lock directory replaced during creation and can retry without consuming ownership', () => {
    const root = mkdtempSync(join(tmpdir(), 'rlh-lease-directory-race-'))
    roots.push(root)
    const store = new SubagentActivationLeaseStore(join(root, 'lease.sqlite3'))
    const lockRoot = `${fs.realpathSync(store.path)}.mutation-locks`
    const original = fs.mkdirSync
    const mkdir = vi.spyOn(fs, 'mkdirSync').mockImplementation((target, options) => {
      const result = original(target, options)
      if (target === lockRoot) {
        fs.rmdirSync(lockRoot)
        writeFileSync(lockRoot, 'replaced directory')
      }
      return result
    })
    syncBuiltinESMExports()
    try {
      expect(() => store.acquire(SessionId('race'), 60_000)).toThrow(expect.objectContaining({ code: 'LEASE_STORE_INVALID' }))
      mkdir.mockRestore()
      syncBuiltinESMExports()
      rmSync(lockRoot)
      expect(store.acquire(SessionId('race'), 60_000).fence).toBe(1)
    } finally { store.close() }
  })

  it.each(['open', 'chmod'] as const)('propagates a mutation-lock %s failure without leaking an owner or handle', (operation) => {
    const root = mkdtempSync(join(tmpdir(), 'rlh-lease-io-failure-'))
    roots.push(root)
    const store = new SubagentActivationLeaseStore(join(root, 'lease.sqlite3'))
    const id = SessionId('io-child')
    const lock = join(`${fs.realpathSync(store.path)}.mutation-locks`, `${createHash('sha256').update(id).digest('hex')}.sqlite3`)
    const failure = Object.assign(new Error('mutation lock access denied'), { code: 'EACCES' })
    const open = fs.openSync, chmod = fs.chmodSync
    if (operation === 'open') {
      vi.spyOn(fs, 'openSync').mockImplementation((target, flags, mode) => {
        if (target === lock) throw failure
        return open(target, flags, mode)
      })
    } else {
      vi.spyOn(fs, 'chmodSync').mockImplementation((target, mode) => {
        if (target === lock) throw failure
        chmod(target, mode)
      })
    }
    syncBuiltinESMExports()
    try {
      expect(() => store.acquire(id, 60_000)).toThrow(failure)
      vi.restoreAllMocks()
      syncBuiltinESMExports()
      expect(store.acquire(id, 60_000).fence).toBe(1)
    } finally { store.close() }
  })

  it('rejects a relative database path before creating storage', () => {
    const root = mkdtempSync(join(tmpdir(), 'rlh-relative-lease-'))
    roots.push(root)
    const file = join(root, 'lease.sqlite3')
    expect(() => new SubagentActivationLeaseStore(relative(process.cwd(), file))).toThrow(/must be absolute/)
    expect(existsSync(file)).toBe(false)
  })

  it('refuses an unsupported schema without replacing its version or records', () => {
    const root = mkdtempSync(join(tmpdir(), 'rlh-versioned-lease-'))
    roots.push(root)
    const file = join(root, 'lease.sqlite3')
    const { DatabaseSync } = loadNodeSqlite()
    const seed = new DatabaseSync(file)
    seed.exec("PRAGMA user_version = 9; CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('retained')")
    seed.close()
    expect(() => new SubagentActivationLeaseStore(file)).toThrow(/unsupported subagent activation lease schema/)
    const stored = new DatabaseSync(file)
    try {
      expect(stored.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 })
      expect(stored.prepare('SELECT value FROM sentinel').get()).toEqual({ value: 'retained' })
      expect(existsSync(`${file}.mutation-locks`)).toBe(false)
    } finally { stored.close() }
  })

  it.each([
    { now: -1, leaseMs: 100 }, { now: 0.5, leaseMs: 100 },
    { now: 0, leaseMs: 0 }, { now: 0, leaseMs: -1 }, { now: 0, leaseMs: NaN },
  ])('rejects invalid acquisition time without consuming a fence: %j', ({ now, leaseMs }) => {
    const store = new SubagentActivationLeaseStore(':memory:')
    try {
      const id = SessionId('invalid-acquire')
      expect(() => store.acquire(id, leaseMs, now)).toThrow(/safe integer/)
      expect(store.acquire(id, 100, 0).fence).toBe(1)
    } finally { store.close() }
  })

  it.each([0, -1])('rejects renewal lifetime %s without expiring the current owner', (leaseMs) => {
    const store = new SubagentActivationLeaseStore(':memory:')
    try {
      const lease = store.acquire(SessionId('invalid-renewal'), 100, 0)
      expect(() => store.renew(lease, 10, leaseMs)).toThrow(/positive safe integer/)
      expect(() => { store.assertCurrent(lease, 20) }).not.toThrow()
    } finally { store.close() }
  })

  it.skipIf(process.platform === 'win32')('shares mutation exclusion through a symlink alias of the lease database', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rlh-lease-alias-'))
    roots.push(root)
    const path = join(root, 'lease.sqlite3')
    const alias = join(root, 'alias.sqlite3')
    const first = new SubagentActivationLeaseStore(path)
    symlinkSync(path, alias, 'file')
    const second = new SubagentActivationLeaseStore(alias)
    const lease = first.acquire(SessionId('alias-child'), 60_000)
    try {
      await lease.runExclusive(() => {
        expect(() => second.acquire(lease.childId, 100, lease.expiresAt + 1)).toThrow(expect.objectContaining({ code: 'LEASE_HELD' }))
        return Promise.resolve()
      })
      const successor = second.acquire(lease.childId, 100, lease.expiresAt + 1)
      successor.release()
    } finally {
      first.close()
      second.close()
    }
  })

  it('refuses hard-link aliases of the lease database before creating a second lock namespace', () => {
    const root = mkdtempSync(join(tmpdir(), 'rlh-lease-hardlink-'))
    roots.push(root)
    const path = join(root, 'lease.sqlite3')
    const alias = join(root, 'alias.sqlite3')
    const first = new SubagentActivationLeaseStore(path)
    linkSync(path, alias)
    try {
      expect(() => new SubagentActivationLeaseStore(alias)).toThrow(expect.objectContaining({ code: 'LEASE_STORE_INVALID' }))
    } finally { first.close() }
  })

  it.skipIf(process.platform === 'win32').each(['root', 'dangling root', 'file', 'dangling file', 'hardlinked file'] as const)('rejects a linked mutation-lock %s', (target) => {
    const root = mkdtempSync(join(tmpdir(), 'rlh-lease-lock-link-'))
    roots.push(root)
    const path = join(root, 'lease.sqlite3')
    const lockRoot = `${path}.mutation-locks`
    const id = SessionId('linked-child')
    const store = new SubagentActivationLeaseStore(path)
    const destination = join(root, 'elsewhere')
    if (target === 'root' || target === 'dangling root') {
      if (target === 'root') mkdirSync(destination)
      symlinkSync(destination, lockRoot, 'dir')
    } else {
      mkdirSync(lockRoot)
      if (target === 'file' || target === 'hardlinked file') writeFileSync(destination, '')
      const lockPath = join(lockRoot, `${createHash('sha256').update(id).digest('hex')}.sqlite3`)
      if (target === 'hardlinked file') linkSync(destination, lockPath)
      else symlinkSync(destination, lockPath, 'file')
    }
    try {
      expect(() => store.acquire(id, 100)).toThrow(expect.objectContaining({ code: 'LEASE_STORE_INVALID' }))
    } finally { store.close() }
  })

  it('releases mutation locks after nested admission refusal, failure, and stale-owner rejection', async () => {
    const { first, second } = stores()
    const id = SessionId('mutation-failure')
    const lease = first.acquire(id, 60_000)
    try {
      await expect(lease.runExclusive(async () => {
        await expect(lease.runExclusive(() => Promise.resolve())).rejects.toMatchObject({ code: 'LEASE_HELD' })
        throw new Error('backend failed')
      })).rejects.toThrow('backend failed')
      await expect(lease.runExclusive(() => Promise.resolve('retried'))).resolves.toBe('retried')
      lease.release()
      const successor = second.acquire(id, 60_000)
      const body = vi.fn(() => Promise.resolve())
      await expect(lease.runExclusive(body)).rejects.toMatchObject({ code: 'LEASE_LOST' })
      expect(body).not.toHaveBeenCalled()
      await expect(successor.runExclusive(() => Promise.resolve('successor'))).resolves.toBe('successor')
      successor.release()
    } finally {
      first.close()
      second.close()
    }
  })

  it('keeps the mutation lock until in-flight work settles after store close', async () => {
    const { first, second } = stores()
    const id = SessionId('close-during-mutation')
    const lease = first.acquire(id, 60_000)
    const gate = Promise.withResolvers<undefined>()
    try {
      const mutation = lease.runExclusive(() => gate.promise)
      first.close()
      expect(() => first.acquire(id, 100)).toThrow(expect.objectContaining({ code: 'LEASE_STORE_INVALID' }))
      expect(() => second.acquire(id, 100, lease.expiresAt + 1)).toThrow(expect.objectContaining({ code: 'LEASE_HELD' }))
      gate.resolve(undefined)
      await mutation
      const successor = second.acquire(id, 100, lease.expiresAt + 1)
      successor.release()
    } finally {
      gate.resolve(undefined)
      first.close()
      second.close()
    }
  })

  it('excludes takeover through the complete asynchronous mutation while renewal stays independent', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const { first, second } = stores()
    const id = SessionId('mutating-child')
    const lease = first.acquire(id, 100)
    const release = Promise.withResolvers<undefined>()
    try {
      const mutation = lease.runExclusive(async () => { await release.promise; return 'committed' })
      now.mockReturnValue(1_050)
      lease.renew()
      now.mockReturnValue(1_151)
      expect(() => second.acquire(id, 100)).toThrow(expect.objectContaining({ code: 'LEASE_HELD' }))
      expect(() => { lease.release() }).toThrow(expect.objectContaining({ code: 'LEASE_HELD' }))
      release.resolve(undefined)
      expect(await mutation).toBe('committed')
      const successor = second.acquire(id, 100)
      expect(successor.fence).toBe(lease.fence + 1)
      successor.release()
    } finally {
      release.resolve(undefined)
      now.mockRestore()
      first.close()
      second.close()
    }
  })

  it('admits one owner, renews it, and rejects a concurrent owner', () => {
    const { first, second } = stores()
    const id = SessionId('child')
    const lease = first.acquire(id, 100, 1_000)

    expect(() => second.acquire(id, 100, 1_050)).toThrow(
      expect.objectContaining({ code: 'LEASE_HELD' }),
    )
    lease.renew(1_050)
    expect(lease.expiresAt).toBe(1_150)
    expect(() => second.acquire(id, 100, 1_149)).toThrow(SubagentActivationLeaseError)
    lease.release()
    const successor = second.acquire(id, 100, 1_060)
    expect(successor.fence).toBe(2)
    successor.release()
    first.close()
    second.close()
  })

  it('takes over only after expiry and fences stale renew and release', () => {
    const { first, second } = stores()
    const id = SessionId('child')
    const stale = first.acquire(id, 100, 2_000)
    const successor = second.acquire(id, 100, 2_101)

    expect(successor.fence).toBe(stale.fence + 1)
    expect(() => { stale.renew(2_102) }).toThrow(expect.objectContaining({ code: 'LEASE_LOST' }))
    expect(() => { stale.release() }).toThrow(expect.objectContaining({ code: 'LEASE_LOST' }))
    expect(() => { successor.assertCurrent(2_150) }).not.toThrow()
    successor.release()
    first.close()
    second.close()
  })

  it('preserves an unexpired crash lease across store restart, then permits timed takeover', () => {
    const root = mkdtempSync(join(tmpdir(), 'rlh-subagent-lease-restart-'))
    roots.push(root)
    const path = join(root, 'leases.sqlite3')
    const first = new SubagentActivationLeaseStore(path)
    const id = SessionId('child')
    first.acquire(id, 100, 3_000)
    first.close()

    const restarted = new SubagentActivationLeaseStore(path)
    expect(() => restarted.acquire(id, 100, 3_099)).toThrow(expect.objectContaining({ code: 'LEASE_HELD' }))
    const takeover = restarted.acquire(id, 100, 3_101)
    expect(takeover.fence).toBe(2)
    takeover.release()
    restarted.close()
  })

  it('rejects unsafe lease arithmetic before mutating ownership', () => {
    const store = new SubagentActivationLeaseStore(':memory:')
    expect(() => store.acquire(SessionId('overflow'), 100, Number.MAX_SAFE_INTEGER - 50))
      .toThrow(expect.objectContaining({ code: 'LEASE_STORE_INVALID' }))
    expect(() => store.acquire(SessionId('overflow'), 100, 1)).not.toThrow()
    store.close()
  })
})
