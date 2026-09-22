// @vitest-environment jsdom
// RFC §5.4 draft lifecycle over the conversation composer: unsent input at a
// Session-scope teardown becomes a discarded tombstone (surfaced on reopen,
// never silently destroyed or shown as live input), an explicit submit or
// discard clears it, and a connection epoch change neither wipes it nor
// tombstones it.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { makeTranslate, SlotTestRuntime } from '@relay-harness/rlh-client-test-runtime'
import type { SessionId } from '@relay-harness/rlh-client-runtime/client'
import { DiscardedDraftRegistry } from '../src/client/input/drafts.ts'
import { InputHub } from '../src/client/input/hub.ts'
import { ConversationController } from '../src/client/service.ts'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'
import { zh } from '../src/client/locales.ts'

const sid = (id: string) => id as SessionId

beforeEach(() => {
  localStorage.clear()
})

describe('DiscardedDraftRegistry', () => {
  it('records, restores, and dismisses per-target tombstones; empty input is never retained', () => {
    const registry = new DiscardedDraftRegistry()
    registry.discard(sid('s1'), '')
    expect(registry.getSnapshot()).toEqual({})
    registry.discard(sid('s1'), 'unsent text')
    expect(registry.getSnapshot()).toEqual({ s1: { text: 'unsent text', at: expect.any(Number) as number } })
    expect(registry.face(sid('s1')).getSnapshot()?.text).toBe('unsent text')
    expect(registry.face(sid('s2')).getSnapshot()).toBeUndefined()
    // Re-recording the same text keeps the original discard time.
    const at = registry.getSnapshot().s1!.at
    registry.discard(sid('s1'), 'unsent text')
    expect(registry.getSnapshot().s1!.at).toBe(at)
    // Explicit restore takes the text back out and clears the entry.
    expect(registry.restore(sid('s1'))).toBe('unsent text')
    expect(registry.getSnapshot()).toEqual({})
    expect(registry.restore(sid('s1'))).toBeUndefined()
    // Explicit discard drops the retained input for good.
    registry.discard(sid('s1'), 'again')
    registry.dismiss(sid('s1'))
    expect(registry.getSnapshot()).toEqual({})
    expect(() => { registry.dismiss(sid('s1')) }).not.toThrow()
  })

  it('bounds retained tombstones by oldest discard time', () => {
    const registry = new DiscardedDraftRegistry()
    for (let index = 0; index < 25; index += 1) {
      registry.discard(sid(`s${index}`), `text-${index}`)
    }
    const entries = registry.getSnapshot()
    expect(Object.keys(entries)).toHaveLength(20)
    expect(entries.s0).toBeUndefined()
    expect(entries.s24!.text).toBe('text-24')
  })

  it('survives a reload through the persisted store', () => {
    const first = new DiscardedDraftRegistry()
    first.discard(sid('s1'), 'kept across reload')
    const second = new DiscardedDraftRegistry()
    expect(second.getSnapshot()['s1']!.text).toBe('kept across reload')
  })
})

describe('InputHub draft lifecycle at scope teardown', () => {
  type PromptResult =
    | { ok: true; value: { accepted: true } }
    | { ok: false; error: { code: 'internal'; message: string; details: Record<string, never> } }

  async function bench() {
    const runtime = await SlotTestRuntime.create()
    const prompt = vi.fn<() => Promise<PromptResult>>(() => Promise.resolve({ ok: true, value: { accepted: true } }))
    await runtime.sessions.add({
      id: 's1',
      session: { prompt, updateQueue: vi.fn(), cancel: vi.fn(), loadOlder: vi.fn() },
    })
    const registry = new DiscardedDraftRegistry()
    const hub = new InputHub(runtime.ctx, makeTranslate(zh, {}), registry)
    const fiber = runtime.ctx.plugin(ConversationController, {
      input: hub,
      blocks: new ComposerBlockRegistry(),
    })
    await fiber.await()
    const shell = hub.shellFor(runtime.sessions.binding('s1')!)
    return { runtime, registry, shell, prompt }
  }

  it('a disposed session scope with unsent input is surfaced as discarded, not silently lost', async () => {
    const b = await bench()
    b.shell.setDraft('unsent text')
    await b.runtime.sessions.remove('s1')
    expect(b.registry.face(sid('s1')).getSnapshot()?.text).toBe('unsent text')
    await b.runtime.dispose()
  })

  it('an explicit submit clears the draft, records no tombstone, and mirrors the clear', async () => {
    const b = await bench()
    b.shell.setDraft('send me')
    b.shell.submit()
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
    expect(b.prompt).toHaveBeenCalledWith([{ type: 'text', text: 'send me' }], 'queue', expect.any(AbortSignal))
    expect(b.shell.snapshot.draft).toBe('')
    await b.runtime.sessions.remove('s1')
    expect(b.registry.getSnapshot()).toEqual({})
    await b.runtime.dispose()
  })

  it('a draft carried or cleared before teardown records no tombstone', async () => {
    const b = await bench()
    b.shell.setDraft('carried away')
    b.shell.setDraft('')
    await b.runtime.sessions.remove('s1')
    expect(b.registry.getSnapshot()).toEqual({})
    await b.runtime.dispose()
  })

  it('a teardown during an in-flight submit defers the tombstone to the settle outcome', async () => {
    const b = await bench()
    const settled = Promise.withResolvers<PromptResult>()
    b.prompt.mockImplementationOnce(() => settled.promise)
    b.shell.setDraft('in-flight text')
    b.shell.submit()
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
    expect(b.prompt).toHaveBeenCalledTimes(1)
    expect(b.shell.submitInFlight).toBe(true)
    // The scope dies mid-submit: the tombstone waits for the Host's answer.
    await b.runtime.sessions.remove('s1')
    expect(b.registry.getSnapshot()).toEqual({})
    // The Host accepted the send: the input was not unsent, so no tombstone.
    settled.resolve({ ok: true, value: { accepted: true } })
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
    expect(b.registry.getSnapshot()).toEqual({})
    await b.runtime.dispose()
  })

  it('a failed in-flight submit at teardown still records the tombstone', async () => {
    const b = await bench()
    const settled = Promise.withResolvers<PromptResult>()
    b.prompt.mockImplementationOnce(() => settled.promise)
    b.shell.setDraft('failed in-flight text')
    b.shell.submit()
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
    await b.runtime.sessions.remove('s1')
    settled.resolve({ ok: false, error: { code: 'internal', message: 'send failed', details: {} } })
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) })
    expect(b.registry.face(sid('s1')).getSnapshot()?.text).toBe('failed in-flight text')
    await b.runtime.dispose()
  })
})
