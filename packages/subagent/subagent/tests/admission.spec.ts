import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentAdmissionController } from '../src/admission.ts'

function parent(id: string): Agent {
  return { id: SessionId(id) } as Agent
}

const signal = new AbortController().signal

describe('SubagentAdmissionController', () => {
  it('leaves unconfigured capacity unbounded and closes future admission idempotently', async () => {
    const controller = new SubagentAdmissionController({ overflow: 'reject' }, subject => subject.id)
    const first = await controller.acquire(parent('root'), signal)
    const second = await controller.acquire(parent('root'), signal)
    first.release()
    first.release()
    second.release()

    controller.close()
    controller.close()
    await expect(controller.acquire(parent('root'), signal)).rejects.toMatchObject({ code: 'DRAINING' })
  })

  it('enforces root and direct-parent ceilings while isolating different roots', async () => {
    const roots = new Map([
      ['a-1', SessionId('root-a')],
      ['a-2', SessionId('root-a')],
      ['b-1', SessionId('root-b')],
    ])
    const controller = new SubagentAdmissionController(
      { maxActivePerRoot: 2, maxActivePerParent: 1, overflow: 'reject' },
      subject => roots.get(subject.id) as SessionId,
    )
    const a1 = await controller.acquire(parent('a-1'), signal)
    await expect(controller.acquire(parent('a-1'), signal)).rejects.toMatchObject({
      code: 'CAPACITY_EXCEEDED',
    })
    const a2 = await controller.acquire(parent('a-2'), signal)
    await expect(controller.acquire(parent('a-2'), signal)).rejects.toMatchObject({ code: 'CAPACITY_EXCEEDED' })
    const b1 = await controller.acquire(parent('b-1'), signal)

    a1.release()
    a1.release()
    a2.release()
    b1.release()
  })

  it('retains a parent counter until its final sibling releases', async () => {
    const controller = new SubagentAdmissionController(
      { maxActivePerRoot: 3, overflow: 'reject' },
      () => SessionId('root'),
    )
    const first = await controller.acquire(parent('p'), signal)
    const second = await controller.acquire(parent('p'), signal)
    first.release()
    second.release()
  })

  it('queues by root, skips a parent-blocked head, and promotes after release', async () => {
    const roots = new Map([
      ['p1', SessionId('root')],
      ['p2', SessionId('root')],
      ['p3', SessionId('root')],
    ])
    const controller = new SubagentAdmissionController(
      { maxActivePerRoot: 2, maxActivePerParent: 1, overflow: 'queue' },
      subject => roots.get(subject.id) as SessionId,
    )
    const p1 = await controller.acquire(parent('p1'), signal)
    const p2 = await controller.acquire(parent('p2'), signal)
    const queuedP1 = controller.acquire(parent('p1'), signal)
    const queuedP3 = controller.acquire(parent('p3'), signal)
    let p1Promoted = false
    void queuedP1.then(() => { p1Promoted = true })

    p2.release()
    const p3 = await queuedP3
    await Promise.resolve()
    expect(p1Promoted).toBe(false)

    p1.release()
    const replacementP1 = await queuedP1
    replacementP1.release()
    p3.release()
  })

  it('removes a cancelled waiter and rejects pending work when closed', async () => {
    const controller = new SubagentAdmissionController(
      { maxActivePerRoot: 1, overflow: 'queue' },
      () => SessionId('root'),
    )
    const active = await controller.acquire(parent('p1'), signal)
    const cancelled = new AbortController()
    const reason = new Error('caller left')
    const waiting = controller.acquire(parent('p2'), cancelled.signal)
    cancelled.abort(reason)
    await expect(waiting).rejects.toBe(reason)

    const closing = controller.acquire(parent('p3'), signal)
    controller.close()
    await expect(closing).rejects.toMatchObject({ code: 'DRAINING' })
    active.release()
  })

  it('rejects an already-aborted acquisition before creating root state', async () => {
    const controller = new SubagentAdmissionController(
      { maxActivePerRoot: 1, overflow: 'queue' },
      vi.fn(() => SessionId('root')),
    )
    const cancelled = new AbortController()
    const reason = new Error('already gone')
    cancelled.abort(reason)
    await expect(controller.acquire(parent('p'), cancelled.signal)).rejects.toBe(reason)
  })

  it('removes a waiter when cancellation wins during listener installation', async () => {
    const controller = new SubagentAdmissionController(
      { maxActivePerRoot: 1, overflow: 'queue' },
      () => SessionId('root'),
    )
    const active = await controller.acquire(parent('active'), signal)
    const reason = new Error('installation race')
    let reads = 0
    const racy = {
      get aborted() { reads += 1; return reads >= 1 },
      reason,
      throwIfAborted() {},
      addEventListener() {},
      removeEventListener() {},
    } as unknown as AbortSignal
    await expect(controller.acquire(parent('waiting'), racy)).rejects.toBe(reason)
    active.release()
  })

  it('rechecks cancellation at promotion before publishing a lease', async () => {
    const controller = new SubagentAdmissionController(
      { maxActivePerRoot: 1, overflow: 'queue' },
      () => SessionId('root'),
    )
    const active = await controller.acquire(parent('p1'), signal)
    const cancelled = new AbortController()
    const reason = new Error('lost promotion')
    const originalRemove = cancelled.signal.removeEventListener.bind(cancelled.signal)
    vi.spyOn(cancelled.signal, 'removeEventListener').mockImplementationOnce((...args) => {
      cancelled.abort(reason)
      originalRemove(...args)
    })
    const waiting = controller.acquire(parent('p2'), cancelled.signal)
    active.release()
    await expect(waiting).rejects.toBe(reason)
  })
})
