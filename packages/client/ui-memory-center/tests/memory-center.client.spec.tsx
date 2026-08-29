// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemoryCenterDetail, MemoryCenterSnapshot } from '@relay-harness/rlh-api-remotes/client'
import type { SessionId, SessionListState } from '@relay-harness/rlh-client-runtime/client'
import { MemoryCenterSection } from '../src/client/MemoryCenterSection.tsx'
import type { MemoryCenterSectionInjected, MemoryCenterSectionProps } from '../src/client/MemoryCenterSection.tsx'
import { en, type MemoryCenterLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)
const t = (key: MemoryCenterLocaleKey): string => en[key]

function memory(status: 'candidate' | 'active' | 'tombstoned' = 'candidate'): MemoryCenterDetail {
  return {
    memory: {
      freshness: 'current',
      whyUsed: [{ sessionId: 'session', turn: 2, step: 1, eventSeq: 9, eventTime: 10, evidenceId: 'memory:m1:1', memoryRevision: 1, revisionState: 'current' }],
      entry: {
        id: 'm1' as never,
        revision: 1,
        scope: { workspaceId: '/work', userId: 'user', agentId: 'agent' },
        kind: 'preference',
        status,
        trust: status === 'active' ? 'user-stated' : 'agent-proposed',
        content: 'Always show context provenance.',
        summary: 'Show provenance',
        importance: 3,
        confidence: 0.8,
        createdAt: 1,
        updatedAt: 2,
        evidence: [{
          sessionId: 'session' as never,
          eventSeqs: [4],
          verification: 'agent-proposal',
          excerpt: 'show context provenance',
        }],
        accessCount: 1,
        usefulAccessCount: 2,
      },
    },
    conflicts: [],
    signals: [{
      id: 'signal-1', memoryId: 'm1' as never, kind: 'injected', sessionId: 'session' as never,
      turn: 2, eventSeqs: [], createdAt: 10,
    }],
    outcomes: [{
      id: 'outcome-1', memoryId: 'm1' as never,
      scope: { workspaceId: '/work', userId: 'user', agentId: 'agent' },
      sessionId: 'session' as never, turn: 2, kind: 'assistant-positive', impact: 'positive',
      sourceEventSeqs: [9, 10], observedAt: 11,
    }],
    outcomeSummary: { positive: 1, negative: 0, neutral: 0, rankingAdjustment: 0.025 },
    outcomeCoverage: 'complete',
    usageCoverage: { status: 'complete', sessionsScanned: 2, sessionsFailed: 0 },
  }
}

function snapshot(detail = memory()): MemoryCenterSnapshot {
  return {
    scope: detail.memory.entry.scope,
    entries: [detail.memory],
    total: 1,
    offset: 0,
    hasMore: false,
    usageCoverage: { status: 'complete', sessionsScanned: 2, sessionsFailed: 0 },
  }
}

function sessions(): SessionListState {
  const id = 'session' as SessionId
  return {
    ids: [id],
    byId: { [id]: { id, displayTitle: 'work', cwd: '/work', running: false, blank: false, updatedAt: 0 } },
    current: id,
    phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
}

function props(overrides: Partial<MemoryCenterSectionInjected> = {}): MemoryCenterSectionProps {
  return {
    t,
    useSessions: selector => selector(sessions()),
    list: async () => snapshot(),
    read: async () => memory(),
    approve: async () => memory('active'),
    reject: async () => memory('tombstoned'),
    revise: async () => memory('active'),
    tombstone: async () => memory('tombstoned'),
    ...overrides,
  } as MemoryCenterSectionProps
}

describe('MemoryCenterSection', () => {
  it('does not issue an unscoped governance read without an attached Session', async () => {
    const list = vi.fn(async () => snapshot())
    const state = { ...sessions(), current: undefined }
    render(<MemoryCenterSection {...props({ list })} useSessions={selector => selector(state)} />)
    expect(await screen.findByText(en.noSession)).toBeTruthy()
    expect(list).not.toHaveBeenCalled()
  })

  it('renders governance status, evidence, why-used trace, and approves a candidate', async () => {
    const approve = vi.fn(async () => memory('active'))
    render(<MemoryCenterSection {...props({ approve })} />)
    const rowText = await screen.findByText('Always show context provenance.')
    fireEvent.click(rowText.closest('button')!)
    const dialog = await screen.findByRole('dialog', { name: en.details })
    expect(within(dialog).getByText('show context provenance')).toBeTruthy()
    expect(within(dialog).getByText('Session session · Turn 2 / Step 1 · context/prepared #9 · revision 1 (current)')).toBeTruthy()
    expect(within(dialog).getByText(/assistant-positive · positive/)).toBeTruthy()
    expect(within(dialog).getByText(/injected · Session session/)).toBeTruthy()
    fireEvent.click(within(dialog).getByRole('button', { name: en.approve }))
    await waitFor(() => { expect(approve).toHaveBeenCalledWith('session', 'm1', 1) })
    expect(await within(dialog).findByText(en.active)).toBeTruthy()
  })

  it('requires an auditable reason before rejecting or tombstoning', async () => {
    const reject = vi.fn(async () => memory('tombstoned'))
    render(<MemoryCenterSection {...props({ reject })} />)
    fireEvent.click((await screen.findByText('Always show context provenance.')).closest('button')!)
    const dialog = await screen.findByRole('dialog', { name: en.details })
    const rejectButton = within(dialog).getByRole<HTMLButtonElement>('button', { name: en.reject })
    expect(rejectButton.disabled).toBe(true)
    fireEvent.change(within(dialog).getByLabelText(en.reason), { target: { value: 'Incorrect inference' } })
    expect(rejectButton.disabled).toBe(false)
    fireEvent.click(rejectButton)
    await waitFor(() => { expect(reject).toHaveBeenCalledWith('session', 'm1', 1, 'Incorrect inference') })
  })
})
