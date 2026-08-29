// @vitest-environment jsdom
/** Slot registration, generated Remote invocation, compare-before-replace, and component cancellation. */

import { Context } from '@relay-harness/cordis'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PromptEnhancementOutcome } from '@relay-harness/rlh-api-remotes/client'
import { SlotRegistry } from '@relay-harness/rlh-client-runtime/client'
import type { SessionId } from '@relay-harness/rlh-client-runtime/client'
import { LocaleRuntime } from '@relay-harness/rlh-client-locale/client'
import { EnhanceControl } from '../src/client/EnhanceControl.tsx'
import type { EnhanceControlProps } from '../src/client/EnhanceControl.tsx'
import { apply, inject, type PromptEnhancementInjected } from '../src/client/index.ts'
import { en } from '../src/client/locales.ts'
import { apply as nodeApply } from '../src/index.ts'

afterEach(cleanup)

const SID = 'enhance-ui' as SessionId

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: { 'conversation.input.right': { kind: 'list', scope: 'session' } },
  } as never, () => null)
  const enhance = vi.fn((_id: SessionId, originalDraft: string, _signal: AbortSignal) => Promise.resolve({
    ok: true as const,
    value: {
      kind: 'enhanced' as const,
      result: {
        originalDraft,
        enhancedDraft: 'better',
        assumptions: [],
        openQuestions: [],
        model: { provider: 'p', model: 'm' },
      },
    },
  }))
  const promptEnhancement = { enhance }
  ctx.provide('remote', { promptEnhancement })
  ctx.provide('remote.promptEnhancement', promptEnhancement)
  ctx.provide('locale', new LocaleRuntime(ctx))
  return { ctx, slots, enhance }
}

describe('ui-prompt-enhancement browser plugin', () => {
  it('declares its dependencies and keeps the node half inert', () => {
    expect(inject).toEqual(['slots', 'remote', 'remote.promptEnhancement', 'locale'])
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('registers in input.right, calls the Remote, and unregisters', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = b.slots.entries('conversation.input.right')[0]!
    expect(entry.component).toBe(EnhanceControl)
    const injected = (entry.inject as unknown as (id: SessionId) => PromptEnhancementInjected)(SID)
    const signal = new AbortController().signal
    await expect(injected.enhance('original', signal)).resolves.toMatchObject({ kind: 'enhanced' })
    expect(b.enhance).toHaveBeenCalledWith(SID, 'original', signal)
    await fiber.dispose()
    expect(b.slots.entries('conversation.input.right')).toHaveLength(0)
  })
})

const t: EnhanceControlProps['t'] = key => (en as Record<string, string>)[key] ?? key
const session = { sessionId: SID, removed: false } as EnhanceControlProps['session']
const input = { draft: 'original', draftRev: 1, phase: 'plain' } as EnhanceControlProps['input']

describe('EnhanceControl', () => {
  it('shows the proposal without applying it, then applies only after explicit Accept', async () => {
    const setDraft = vi.fn()
    const submit = vi.fn()
    const enhance = vi.fn(() => Promise.resolve({
      kind: 'enhanced' as const,
      result: {
        originalDraft: 'original', enhancedDraft: 'better',
        assumptions: ['The existing test runner remains authoritative.'],
        openQuestions: ['Which browser versions are required?'],
        model: { provider: 'p', model: 'm' },
        contextTrace: {
          purpose: 'prompt_enhancement',
          contributions: [{
            contributorId: 'session-history-context',
            evidence: [{
              resource: { sourceId: 'session-history', key: 'session/enhance-ui/event/4' },
              freshness: 'current',
              verification: 'verified',
              domain: { selectionReasons: ['completed-turn', 'within-history-budget'] },
            }],
          }],
        },
      },
    }))
    const view = render(<EnhanceControl {...({
      session, input, inputActions: { setDraft, submit }, enhance, t,
    } as EnhanceControlProps)} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enhance prompt' })) })
    expect(enhance).toHaveBeenCalledWith('original', expect.any(AbortSignal))
    expect(screen.getByRole('dialog', { name: 'Enhancement proposal' })).toBeTruthy()
    expect(screen.getByText('The existing test runner remains authoritative.')).toBeTruthy()
    const sources = screen.getByRole('region', { name: 'Sources used this time' })
    expect(sources).toBeTruthy()
    expect(screen.getByText('History')).toBeTruthy()
    expect(screen.getByText(/completed-turn · within-history-budget/)).toBeTruthy()
    expect(sources.textContent).toContain('Freshness: Current')
    expect(sources.textContent).toContain('Verification: Verified')
    expect(setDraft).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Accept enhancement' }))
    expect(setDraft).toHaveBeenCalledWith('better')
    expect(submit).not.toHaveBeenCalled()
    view.rerender(<EnhanceControl {...({
      session,
      input: { ...input, draft: 'better', draftRev: 2 },
      inputActions: { setDraft, submit },
      enhance,
      t,
    } as EnhanceControlProps)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Undo enhancement' }))
    expect(setDraft).toHaveBeenNthCalledWith(2, 'original')
    expect(submit).not.toHaveBeenCalled()
  })

  it('explains admitted File, Code, Memory, History, and MCP evidence without guessing unknown sources', async () => {
    const evidence = [
      ['file-reference-content', 'file-reference-local', '/workspace/spec.md', 'unverified', { selectionReason: 'explicit @file' }],
      ['code-context', 'code-index', 'chunk:src/a.ts:1', 'verified', { filePath: 'src/a.ts', reasons: ['semantic match'] }],
      ['memory-agent', 'long-term-memory', 'memory-1', 'partially-verified', { matchedBy: ['exact scope'] }],
      ['session-history-context', 'session-history', 'session/s/event/4', 'verified', { selectionReasons: ['completed-turn'] }],
      ['mcp-catalog', 'mcp:docs', 'mcp://docs/guide', 'verified', { serverName: 'docs', selectionReasons: ['explicit-uri-mention'] }],
      ['unknown', 'private-source', 'opaque', 'verified', { selectionReasons: ['unknown'] }],
    ].map(([contributorId, sourceId, key, verification, domain]) => ({
      contributorId,
      evidence: [{ resource: { sourceId, key }, freshness: 'current', verification, domain }],
    }))
    render(<EnhanceControl {...({
      session,
      input,
      inputActions: { setDraft: vi.fn() },
      enhance: () => Promise.resolve({
        kind: 'enhanced',
        result: {
          originalDraft: 'original', enhancedDraft: 'better', assumptions: [], openQuestions: [],
          model: { provider: 'p', model: 'm' },
          contextTrace: { purpose: 'prompt_enhancement', contributions: evidence },
        },
      }),
      t,
    } as EnhanceControlProps)} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enhance prompt' })) })
    for (const label of ['File', 'Code', 'Memory', 'History', 'MCP']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(screen.getByText('/workspace/spec.md')).toBeTruthy()
    expect(screen.getByText('src/a.ts')).toBeTruthy()
    expect(screen.getByText('docs · mcp://docs/guide')).toBeTruthy()
    expect(screen.queryByText('opaque')).toBeNull()
  })

  it('retains a changed draft, reports provider failure, and cancels on unmount', async () => {
    const setDraft = vi.fn()
    const props = {
      session,
      input,
      inputActions: { setDraft },
      enhance: () => Promise.resolve({
        kind: 'enhanced',
        result: {
          originalDraft: 'original', enhancedDraft: 'better', assumptions: [], openQuestions: [],
          model: { provider: 'p', model: 'm' },
        },
      }),
      t,
    } as EnhanceControlProps
    const changed = render(<EnhanceControl {...props} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enhance prompt' })) })
    expect(setDraft).not.toHaveBeenCalled()
    changed.rerender(<EnhanceControl {...{
      ...props,
      input: { ...input, draft: 'new user edit', draftRev: 2 },
    }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Accept enhancement' }))
    expect(setDraft).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe(en['draft.changed'])
    changed.unmount()

    let seenSignal: AbortSignal | undefined
    const pending = new Promise<never>(() => {})
    const mounted = render(<EnhanceControl {...({
      session,
      input,
      inputActions: { setDraft },
      enhance: (_draft: string, signal: AbortSignal) => { seenSignal = signal; return pending },
      t,
    } as EnhanceControlProps)} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enhance prompt' }))
    expect(seenSignal?.aborted).toBe(false)
    mounted.unmount()
    expect(seenSignal?.aborted).toBe(true)
  })

  it('uses draft revision as the CAS precondition and rejects an ABA edit', async () => {
    const setDraft = vi.fn()
    const props = {
      session,
      input,
      inputActions: { setDraft },
      enhance: () => Promise.resolve({
        kind: 'enhanced',
        result: {
          originalDraft: 'original', enhancedDraft: 'better', assumptions: [], openQuestions: [],
          model: { provider: 'p', model: 'm' },
        },
      }),
      t,
    } as EnhanceControlProps
    const view = render(<EnhanceControl {...props} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enhance prompt' })) })
    view.rerender(<EnhanceControl {...{
      ...props,
      input: { ...input, draft: 'original', draftRev: 3 },
    }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Accept enhancement' }))
    expect(setDraft).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe(en['draft.changed'])
  })

  it('starts at most one request and exposes cooperative cancellation through the Remote signal', async () => {
    const setDraft = vi.fn()
    let signal: AbortSignal | undefined
    const enhance = vi.fn((_draft: string, nextSignal: AbortSignal) => {
      signal = nextSignal
      return new Promise<PromptEnhancementOutcome>((resolve) => {
        nextSignal.addEventListener('abort', () => {
          resolve({ kind: 'preserved', reason: 'cancelled', originalDraft: 'original' })
        }, { once: true })
      })
    })
    render(<EnhanceControl {...({ session, input, inputActions: { setDraft }, enhance, t } as EnhanceControlProps)} />)
    const start = screen.getByRole('button', { name: 'Enhance prompt' })
    fireEvent.click(start)
    expect(enhance).toHaveBeenCalledTimes(1)
    const cancel = await screen.findByRole('button', { name: 'Cancel prompt enhancement' })
    fireEvent.click(cancel)
    expect(enhance).toHaveBeenCalledTimes(1)
    expect(signal?.aborted).toBe(true)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Enhance prompt' })).toBeTruthy()
    })
    expect(setDraft).not.toHaveBeenCalled()
  })

  it('aborts and clears stale work when the session changes, and rejects mismatched host results', async () => {
    const setDraft = vi.fn()
    let oldSignal: AbortSignal | undefined
    let resolveOld!: (value: PromptEnhancementOutcome) => void
    const oldResult = new Promise<PromptEnhancementOutcome>((resolve) => { resolveOld = resolve })
    const enhance = vi.fn((_draft: string, signal: AbortSignal) => {
      oldSignal = signal
      return oldResult
    })
    const props = { session, input, inputActions: { setDraft }, enhance, t } as EnhanceControlProps
    const view = render(<EnhanceControl {...props} />)
    fireEvent.click(screen.getByRole('button', { name: 'Enhance prompt' }))
    view.rerender(<EnhanceControl {...{
      ...props,
      session: { ...session, sessionId: 'other-session' as SessionId },
    }} />)
    expect(oldSignal?.aborted).toBe(true)
    await act(async () => {
      resolveOld({
        kind: 'enhanced',
        result: {
          originalDraft: 'original', enhancedDraft: 'stale', assumptions: [], openQuestions: [],
          model: { provider: 'p', model: 'm' },
        },
      })
      await oldResult
    })
    expect(screen.queryByRole('dialog', { name: 'Enhancement proposal' })).toBeNull()

    const mismatch = vi.fn(() => Promise.resolve({
      kind: 'enhanced' as const,
      result: {
        originalDraft: 'different', enhancedDraft: 'wrong', assumptions: [], openQuestions: [],
        model: { provider: 'p', model: 'm' },
      },
    }))
    view.rerender(<EnhanceControl {...{
      ...props,
      session: { ...session, sessionId: 'other-session' as SessionId },
      enhance: mismatch,
    }} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Enhance prompt' })) })
    expect(screen.queryByRole('dialog', { name: 'Enhancement proposal' })).toBeNull()
    expect(screen.getByRole('status').textContent).toBe(en['result.mismatch'])
  })
})
