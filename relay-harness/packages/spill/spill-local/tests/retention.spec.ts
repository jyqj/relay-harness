/**
 * Tests for spill RECLAMATION: `disposeSession` deletes a session's spill
 * directory and leaves others untouched, session disposal reclaims the
 * session's directory (registry-disposal discipline: the disposer is observed
 * through the session store's `session/disposed` edge), and the bounded
 * startup sweep removes only orphan roots older than `orphanRetentionMs`.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CallId } from '@relay-harness/rlh-llm'
import SessionStore from '@relay-harness/rlh-session'
import { SessionId } from '@relay-harness/rlh-session'
import type { SaveTextSpill } from '@relay-harness/rlh-spill'
import LocalSpillStore, { DEFAULT_ORPHAN_RETENTION_MS, pruneOrphanRoots, sessionDir } from '@relay-harness/rlh-spill-local'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rlh-spill-retention-'))
})

afterEach(() => {
  // The plugin's startup sweep only removes rlh-spill-* roots, so this
  // differently-prefixed fixture survives the run and is cleaned here.
  rmSync(root, { recursive: true, force: true })
})

function request(sessionId: SessionId): SaveTextSpill {
  return {
    owner: { sessionId },
    source: { toolName: 'web_fetch', callId: CallId('call-1'), label: 'result' },
    suggestedName: 'web_fetch.txt',
    content: 'the full body',
  }
}

describe('disposeSession', () => {
  it('deletes the session directory and leaves other sessions untouched', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSpillStore, { root })
    await ctx.spillStore.saveText(request(SessionId('sess-a')))
    await ctx.spillStore.saveText(request(SessionId('sess-a')))
    await ctx.spillStore.saveText(request(SessionId('sess-b')))

    await ctx.spillStore.disposeSession(SessionId('sess-a'))

    expect(existsSync(sessionDir(root, 'sess-a'))).toBe(false)
    expect(existsSync(sessionDir(root, 'sess-b'))).toBe(true)
  })

  it('resolves when the session saved nothing', async () => {
    const ctx = new Context()
    await ctx.plugin(LocalSpillStore, { root })
    await expect(ctx.spillStore.disposeSession(SessionId('never-saved'))).resolves.toBeUndefined()
  })
})

describe('session disposal wiring', () => {
  it('reclaims the session directory when the session is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LocalSpillStore, { root })
    const session = ctx.sessions.prepare()
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    await ctx.spillStore.saveText(request(session.id))
    const dir = sessionDir(root, session.id)
    expect(existsSync(dir)).toBe(true)

    detach()

    await vi.waitFor(() =>{  expect(existsSync(dir)).toBe(false) })
  })
})

describe('orphan-root startup sweep', () => {
  it('removes only expired roots under the watched parent', () => {
    const parent = mkdtempSync(join(tmpdir(), 'rlh-spill-sweep-parent-'))
    const expired = mkdtempSync(join(parent, 'rlh-spill-'))
    const fresh = mkdtempSync(join(parent, 'rlh-spill-'))
    const unrelated = mkdtempSync(join(parent, 'unrelated-'))
    const old = new Date(Date.now() - 2 * DEFAULT_ORPHAN_RETENTION_MS)
    utimesSync(expired, old, old)

    const removed = pruneOrphanRoots({ parent, prefix: 'rlh-spill-', retentionMs: DEFAULT_ORPHAN_RETENTION_MS })

    expect(removed).toContain(expired)
    expect(removed).not.toContain(fresh)
    expect(existsSync(fresh)).toBe(true)
    expect(existsSync(unrelated)).toBe(true)
    rmSync(parent, { recursive: true, force: true })
  })

  it('never removes the root this process is using, even when expired', () => {
    const parent = mkdtempSync(join(tmpdir(), 'rlh-spill-sweep-parent-'))
    const keep = mkdtempSync(join(parent, 'rlh-spill-'))
    const old = new Date(Date.now() - 2 * DEFAULT_ORPHAN_RETENTION_MS)
    utimesSync(keep, old, old)

    const removed = pruneOrphanRoots({ parent, prefix: 'rlh-spill-', keep, retentionMs: DEFAULT_ORPHAN_RETENTION_MS })

    expect(removed).toEqual([])
    expect(existsSync(keep)).toBe(true)
    rmSync(parent, { recursive: true, force: true })
  })

  it('runs at plugin load and reclaims an expired orphan root beside the default root', async () => {
    // The production sweep watches the OS temp dir itself, so the orphan root
    // is seeded there; another worker's sweep removing it first is the same
    // expected outcome.
    const expired = mkdtempSync(join(tmpdir(), 'rlh-spill-'))
    const current = mkdtempSync(join(tmpdir(), 'rlh-spill-current-'))
    const old = new Date(Date.now() - 2 * DEFAULT_ORPHAN_RETENTION_MS)
    utimesSync(expired, old, old)

    const ctx = new Context()
    await ctx.plugin(LocalSpillStore, { root: current })

    expect(existsSync(expired)).toBe(false)
    expect(existsSync(current)).toBe(true)
    rmSync(current, { recursive: true, force: true })
  })

  it('fails loud on a non-positive retention', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(LocalSpillStore, { root, orphanRetentionMs: 0 })).rejects.toThrow()
  })
})
