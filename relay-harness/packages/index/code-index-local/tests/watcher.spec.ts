/** Tree watcher: active/degraded lifecycle, debounced triggers, idempotent dispose. */

import type { FSWatcher } from 'node:fs'
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

  it('retains and deduplicates native path names across a debounce window', async () => {
    vi.useFakeTimers()
    try {
      const onChange = vi.fn()
      const watcher = new TreeWatcher('/unused-root', onChange)
      watcher.schedule('src/b.ts')
      watcher.schedule('src/a.ts')
      watcher.schedule('src/b.ts')
      await vi.advanceTimersByTimeAsync(WATCHER_EVENT_DEBOUNCE_MS)
      expect(onChange).toHaveBeenCalledWith(['src/a.ts', 'src/b.ts'])
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

it('degrades and releases a watcher that emits an error after startup', async () => {
  const root = await scratch()
  const onChange = vi.fn()
  const onDegraded = vi.fn()
  const watcher = new TreeWatcher(root, onChange, onDegraded)
  await watcher.start()
  const native = Reflect.get(watcher, 'watcher') as FSWatcher
  const close = vi.spyOn(native, 'close')
  try {
    watcher.schedule('pending.ts')
    expect(() => native.emit('error', new Error('fixture watcher error'))).not.toThrow()
    expect(watcher.state).toBe('degraded')
    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    watcher.dispose()
    expect(() => native.emit('error', new Error('late error'))).not.toThrow()
    expect(watcher.state).toBe('off')
    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(onChange).not.toHaveBeenCalled()
  } finally {
    watcher.dispose()
    close.mockRestore()
  }
})

it.each(['dispose', 'error'] as const)('ignores retained native change callbacks after %s', async (ending) => {
  const root = await scratch()
  const onChange = vi.fn()
  const watcher = new TreeWatcher(root, onChange)
  await watcher.start()
  const native = Reflect.get(watcher, 'watcher') as FSWatcher
  vi.useFakeTimers()
  try {
    if (ending === 'dispose') watcher.dispose()
    else native.emit('error', new Error('fixture retired handle'))
    native.emit('change', 'change', 'late.ts')
    await vi.advanceTimersByTimeAsync(WATCHER_EVENT_DEBOUNCE_MS * 2)
    expect(onChange).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(watcher.state).toBe(ending === 'dispose' ? 'off' : 'degraded')
  } finally {
    watcher.dispose()
    vi.useRealTimers()
  }
})

it.each([null, 'src\\nested.ts'])('normalizes native event filename %j without narrowing a pending full refresh', async (filename) => {
  const root = await scratch()
  const onChange = vi.fn()
  const watcher = new TreeWatcher(root, onChange)
  await watcher.start()
  const native = Reflect.get(watcher, 'watcher') as FSWatcher
  vi.useFakeTimers()
  try {
    native.emit('change', 'change', filename)
    await vi.advanceTimersByTimeAsync(WATCHER_EVENT_DEBOUNCE_MS)
    expect(onChange).toHaveBeenLastCalledWith(filename === null ? undefined : ['src/nested.ts'])
    watcher.schedule()
    watcher.schedule('later-file.ts')
    await vi.advanceTimersByTimeAsync(WATCHER_EVENT_DEBOUNCE_MS)
    expect(onChange).toHaveBeenLastCalledWith(undefined)
    expect(onChange).toHaveBeenCalledTimes(2)
  } finally {
    watcher.dispose()
    vi.useRealTimers()
  }
})
