/** Tree watcher: active/degraded lifecycle, debounced triggers, idempotent dispose. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WATCHER_EVENT_DEBOUNCE_MS, TreeWatcher } from '../src/watcher.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rlh-watch-'))
  roots.push(root)
  return root
}

describe('TreeWatcher', () => {
  it('starts active on a real directory and collapses event storms into one callback', async () => {
    const root = await scratch()
    const onChange = vi.fn()
    const watcher = new TreeWatcher(root, onChange)
    expect(await watcher.start()).toBe('active')
    expect(watcher.state).toBe('active')
    // A storm of events inside the debounce window yields exactly one trigger.
    await writeFile(join(root, 'a.md'), 'x\n')
    await writeFile(join(root, 'b.md'), 'y\n')
    await writeFile(join(root, 'c.md'), 'z\n')
    await vi.waitFor(() => {
      expect(onChange).toHaveBeenCalledOnce()
    }, { timeout: WATCHER_EVENT_DEBOUNCE_MS + 2000 })
    watcher.dispose()
    expect(watcher.state).toBe('off')
  }, 15_000)

  it('collapses repeated raw events into one debounced callback deterministically', async () => {
    vi.useFakeTimers()
    try {
      const onChange = vi.fn()
      const watcher = new TreeWatcher('/unused-root', onChange)
      // The second event lands inside the pending debounce window.
      watcher.schedule()
      watcher.schedule()
      await vi.advanceTimersByTimeAsync(WATCHER_EVENT_DEBOUNCE_MS - 1)
      expect(onChange).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(onChange).toHaveBeenCalledOnce()
      // After firing, a new event schedules fresh again.
      watcher.schedule()
      await vi.advanceTimersByTimeAsync(WATCHER_EVENT_DEBOUNCE_MS)
      expect(onChange).toHaveBeenCalledTimes(2)
      watcher.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('dispose clears a pending debounce timer outright', async () => {
    vi.useFakeTimers()
    try {
      const onChange = vi.fn()
      const watcher = new TreeWatcher('/unused-root', onChange)
      watcher.schedule()
      watcher.dispose()
      expect(watcher.state).toBe('off')
      await vi.advanceTimersByTimeAsync(WATCHER_EVENT_DEBOUNCE_MS * 2)
      expect(onChange).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports degraded when the platform refuses to establish the watch', async () => {
    const root = await scratch()
    const watcher = new TreeWatcher(join(root, 'does-not-exist'), () => {})
    try {
      expect(await watcher.start()).toBe('degraded')
      expect(watcher.state).toBe('degraded')
    } finally {
      watcher.dispose()
    }
  })

  it('stops cleanly after firing and again after every late storm', async () => {
    const root = await scratch()
    const onChange = vi.fn()
    const watcher = new TreeWatcher(root, onChange)
    await watcher.start()
    await writeFile(join(root, 'late.md'), 'late\n')
    // Dispose mid-debounce: the pending native burst must not fire later.
    watcher.dispose()
    await new Promise(resolvePromise => setTimeout(resolvePromise, 80))
    await writeFile(join(root, 'after-dispose.md'), 'ignored\n')
    await new Promise(resolvePromise => setTimeout(resolvePromise, 60))
    expect(onChange).not.toHaveBeenCalled()
  })
})
