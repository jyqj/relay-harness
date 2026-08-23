/**
 * Fair, cancellation-aware read/write locks for tool-declared resources.
 * @module @deepseek-ai/dsh-tools/resource-lock
 */

import type { ToolResourceIntent } from './index.ts'

interface Waiter {
  readonly access: ToolResourceIntent['access']
  readonly signal: AbortSignal
  readonly resolve: (release: () => void) => void
  readonly reject: (error: unknown) => void
  readonly abort: () => void
}

interface ResourceState {
  readers: number
  writer: boolean
  readonly queue: Waiter[]
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(`tool resource acquisition aborted: ${String(signal.reason)}`)
}

/** Normalize duplicate claims, with write dominating read, in deadlock-free key order. */
function normalizeIntents(intents: readonly ToolResourceIntent[]): ToolResourceIntent[] {
  const byKey = new Map<string, ToolResourceIntent['access']>()
  for (const intent of intents) {
    if (typeof intent.key !== 'string' || intent.key.length === 0) {
      throw new TypeError('tool resource intent key must be a non-empty string')
    }
    const access: unknown = intent.access
    if (access !== 'read' && access !== 'write') {
      throw new TypeError(`tool resource intent ${JSON.stringify(intent.key)} has invalid access ${JSON.stringify(access)}`)
    }
    if (access === 'write' || !byKey.has(intent.key)) byKey.set(intent.key, access)
  }
  return [...byKey].sort(([left], [right]) => left < right ? -1 : 1)
    .map(([key, access]) => ({ key, access }))
}

/** Runtime-owned resource lock table shared by native and Code Mode dispatches. */
export class ToolResourceLockManager {
  private readonly states = new Map<string, ResourceState>()

  /**
   * Run one action after acquiring its normalized resource set in key order.
   * @param intents - read/write claims; duplicate keys collapse with write dominance.
   * @param signal - caller cancellation while queued or running.
   * @param action - effect executed while every lease is held.
   * @returns the action result after all leases are released.
   */
  async run<T>(
    intents: readonly ToolResourceIntent[],
    signal: AbortSignal,
    action: () => Promise<T>,
  ): Promise<T> {
    const normalized = normalizeIntents(intents)
    const releases: (() => void)[] = []
    try {
      for (const intent of normalized) {
        releases.push(await this.acquire(intent.key, intent.access, signal))
      }
      signal.throwIfAborted()
      return await action()
    } finally {
      for (const release of releases.toReversed()) release()
    }
  }

  private acquire(
    key: string,
    access: ToolResourceIntent['access'],
    signal: AbortSignal,
  ): Promise<() => void> {
    if (signal.aborted) return Promise.reject(abortReason(signal))
    let state = this.states.get(key)
    if (state === undefined) {
      state = { readers: 0, writer: false, queue: [] }
      this.states.set(key, state)
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: Waiter = {
        access,
        signal,
        resolve,
        reject,
        abort: () => {
          const index = state.queue.indexOf(waiter)
          /* v8 ignore next -- granted waiters remove this listener before user code can abort. */
          if (index < 0) return
          state.queue.splice(index, 1)
          reject(abortReason(signal))
          this.drain(key, state)
        },
      }
      state.queue.push(waiter)
      signal.addEventListener('abort', waiter.abort, { once: true })
      this.drain(key, state)
    })
  }

  private drain(key: string, state: ResourceState): void {
    if (state.writer) return
    if (state.readers > 0 && state.queue[0]?.access === 'write') return
    const first = state.queue[0]
    if (first === undefined) {
      if (state.readers === 0) this.states.delete(key)
      return
    }
    if (first.access === 'write') {
      state.queue.shift()
      this.grant(key, state, first)
      return
    }
    while (state.queue[0]?.access === 'read') {
      const reader = state.queue.shift()
      /* v8 ignore next -- the loop condition proves the head exists. */
      if (reader === undefined) break
      this.grant(key, state, reader)
    }
  }

  private grant(key: string, state: ResourceState, waiter: Waiter): void {
    waiter.signal.removeEventListener('abort', waiter.abort)
    /* v8 ignore next 4 -- abort dispatch is synchronous and removes a queued waiter before drain can grant it. */
    if (waiter.signal.aborted) {
      waiter.reject(abortReason(waiter.signal))
      this.drain(key, state)
      return
    }
    if (waiter.access === 'write') state.writer = true
    else state.readers += 1
    let released = false
    waiter.resolve(() => {
      /* v8 ignore next -- releases are retained only inside run() and invoked once in its finally. */
      if (released) return
      released = true
      if (waiter.access === 'write') state.writer = false
      else state.readers -= 1
      this.drain(key, state)
    })
  }
}
