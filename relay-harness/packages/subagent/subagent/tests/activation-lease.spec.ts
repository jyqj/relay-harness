import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@relay-harness/rlh-session'
import {
  SubagentActivationLeaseError,
  SubagentActivationLeaseStore,
} from '../src/activation-lease.ts'

const roots: string[] = []
afterEach(() => {
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
