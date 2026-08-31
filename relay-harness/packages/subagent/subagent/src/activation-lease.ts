/** SQLite-backed cross-process lease and fencing for continuable child Activations. */

import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { SessionId } from '@relay-harness/rlh-session'

/** Stable cross-process lease failure. */
export class SubagentActivationLeaseError extends Error {
  constructor(
    message: string,
    readonly code: 'LEASE_HELD' | 'LEASE_LOST' | 'LEASE_STORE_INVALID',
  ) {
    super(message)
    this.name = 'SubagentActivationLeaseError'
  }
}

interface LeaseRow {
  owner_token: string | null
  fence: number
  expires_at: number
}

/** One acquired child lease. A stale handle cannot renew or release its successor. */
export class SubagentActivationLease {
  constructor(
    private readonly store: SubagentActivationLeaseStore,
    readonly childId: SessionId,
    readonly ownerToken: string,
    readonly fence: number,
    private readonly leaseMs: number,
    private expiresAtValue: number,
  ) {}

  /** Current expiry in epoch milliseconds. */
  get expiresAt(): number { return this.expiresAtValue }

  /**
   * Renew this exact token/fence or fail when another owner took over.
   * @param now - current epoch milliseconds.
   */
  renew(now: number = Date.now()): void {
    this.expiresAtValue = this.store.renew(this, now, this.leaseMs)
  }

  /**
   * Assert that this token/fence remains the current unexpired owner.
   * @param now - current epoch milliseconds.
   */
  assertCurrent(now: number = Date.now()): void { this.store.assertCurrent(this, now) }

  /** Release this exact token/fence without affecting any successor. */
  release(): void { this.store.release(this) }
}

/** Dedicated SQLite lease Adapter. Transactions serialize owners across Harness processes. */
export class SubagentActivationLeaseStore {
  private readonly db: DatabaseSync

  constructor(readonly path: string) {
    if (path !== ':memory:' && !isAbsolute(path)) {
      throw new SubagentActivationLeaseError('subagent activation lease path must be absolute', 'LEASE_STORE_INVALID')
    }
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    if (path !== ':memory:') chmodSync(path, 0o600)
    this.db.exec('PRAGMA busy_timeout = 5000')
    const version = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (version.user_version !== 0 && version.user_version !== 1) {
      this.db.close()
      throw new SubagentActivationLeaseError(
        `unsupported subagent activation lease schema ${version.user_version}`,
        'LEASE_STORE_INVALID',
      )
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS activation_leases (
        child_id TEXT PRIMARY KEY,
        owner_token TEXT,
        fence INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      PRAGMA user_version = 1;
    `)
  }

  /**
   * Acquire an absent/released/expired child lease and increment its fencing token.
   * @param childId - durable child identity.
   * @param leaseMs - positive lease lifetime.
   * @param now - current epoch milliseconds.
   * @returns the exact owner token and fence handle.
   */
  acquire(childId: SessionId, leaseMs: number, now: number = Date.now()): SubagentActivationLease {
    this.assertTime('leaseMs', leaseMs, true)
    this.assertTime('now', now, false)
    const expiresAt = this.expiry(now, leaseMs)
    const ownerToken = randomUUID()
    let fence = 1
    this.transaction(() => {
      const row = this.row(childId)
      if (row !== undefined && row.owner_token !== null && row.expires_at > now) {
        throw new SubagentActivationLeaseError(
          `subagent "${childId}" is activated by another Harness owner until ${row.expires_at}`,
          'LEASE_HELD',
        )
      }
      fence = (row?.fence ?? 0) + 1
      this.db.prepare(`
        INSERT INTO activation_leases (child_id, owner_token, fence, expires_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(child_id) DO UPDATE SET
          owner_token = excluded.owner_token,
          fence = excluded.fence,
          expires_at = excluded.expires_at
      `).run(childId, ownerToken, fence, expiresAt)
    })
    return new SubagentActivationLease(this, childId, ownerToken, fence, leaseMs, expiresAt)
  }

  /** Close this process's database handle without releasing durable leases. */
  close(): void { this.db.close() }

  /**
   * Renew an exact handle.
   * @param lease - owner handle.
   * @param now - current time.
   * @param leaseMs - lifetime.
   * @returns next expiry.
   */
  renew(lease: SubagentActivationLease, now: number, leaseMs: number): number {
    this.assertTime('now', now, false)
    const expiresAt = this.expiry(now, leaseMs)
    const changed = this.db.prepare(`
      UPDATE activation_leases SET expires_at = ?
      WHERE child_id = ? AND owner_token = ? AND fence = ? AND expires_at > ?
    `).run(expiresAt, lease.childId, lease.ownerToken, lease.fence, now).changes
    if (changed !== 1) this.lost(lease)
    return expiresAt
  }

  /**
   * Assert exact current ownership.
   * @param lease - owner handle.
   * @param now - current time.
   */
  assertCurrent(lease: SubagentActivationLease, now: number): void {
    this.assertTime('now', now, false)
    const row = this.row(lease.childId)
    if (row?.owner_token !== lease.ownerToken || row.fence !== lease.fence || row.expires_at <= now) this.lost(lease)
  }

  /**
   * Release only an exact current fence.
   * @param lease - owner handle.
   */
  release(lease: SubagentActivationLease): void {
    const changed = this.db.prepare(`
      UPDATE activation_leases SET owner_token = NULL, expires_at = 0
      WHERE child_id = ? AND owner_token = ? AND fence = ?
    `).run(lease.childId, lease.ownerToken, lease.fence).changes
    if (changed !== 1) this.lost(lease)
  }

  private row(childId: SessionId): LeaseRow | undefined {
    return this.db.prepare(
      'SELECT owner_token, fence, expires_at FROM activation_leases WHERE child_id = ?',
    ).get(childId) as LeaseRow | undefined
  }

  private transaction(operation: () => void): void {
    this.db.exec('BEGIN IMMEDIATE')
    try { operation(); this.db.exec('COMMIT') } catch (error: unknown) { this.db.exec('ROLLBACK'); throw error }
  }

  private lost(lease: SubagentActivationLease): never {
    throw new SubagentActivationLeaseError(
      `subagent "${lease.childId}" activation lease ${lease.fence} is no longer owned by this Harness`,
      'LEASE_LOST',
    )
  }

  private assertTime(name: string, value: number, positive: boolean): void {
    if (!Number.isSafeInteger(value) || (positive ? value <= 0 : value < 0)) {
      throw new SubagentActivationLeaseError(`${name} must be a ${positive ? 'positive' : 'non-negative'} safe integer`, 'LEASE_STORE_INVALID')
    }
  }

  private expiry(now: number, leaseMs: number): number {
    const value = now + leaseMs
    if (!Number.isSafeInteger(value)) {
      throw new SubagentActivationLeaseError('subagent activation lease expiry exceeds safe integer range', 'LEASE_STORE_INVALID')
    }
    return value
  }
}
