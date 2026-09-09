// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MemoryCenterDetail, MemoryCenterSnapshot } from '@relay-harness/rlh-api-remotes/client'
import type { SessionId, SessionListState } from '@relay-harness/rlh-client-runtime/client'
import { MemoryCenterSection } from '../src/client/MemoryCenterSection.tsx'
import type { MemoryCenterSectionInjected, MemoryCenterSectionProps } from '../src/client/MemoryCenterSection.tsx'
import { en, type MemoryCenterLocaleKey } from '../src/client/locales.ts'
import { memory, snapshot } from './memory-fixtures.client.ts'

afterEach(cleanup)
const t = (key: MemoryCenterLocaleKey): string => en[key]

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
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
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


describe('memory detail request ownership', () => {
  it('can dismiss a loading detail and does not reopen it when the response arrives', async () => {
    const held = Promise.withResolvers<MemoryCenterDetail>()
    render(<MemoryCenterSection {...props({ read: () => held.promise })} />)
    fireEvent.click((await screen.findByText('Always show context provenance.')).closest('button')!)
    const dialog = await screen.findByRole('dialog', { name: en.details })
    fireEvent.click(within(dialog).getAllByRole('button', { name: en.close })[0]!)
    expect(screen.queryByRole('dialog', { name: en.details })).toBeNull()
    await act(async () => { held.resolve(memory()); await held.promise })
    expect(screen.queryByRole('dialog', { name: en.details })).toBeNull()
  })

  it.each(['resolve', 'reject'] as const)('does not let a dismissed older detail %s affect a newer selection', async (outcome) => {
    const held = Promise.withResolvers<MemoryCenterDetail>()
    const first = memory()
    const second: MemoryCenterDetail = {
      ...first,
      memory: { ...first.memory, entry: { ...first.memory.entry, id: 'm2' as never, content: 'Second memory.' } },
    }
    render(<MemoryCenterSection {...props({
      list: async () => ({ ...snapshot(), entries: [first.memory, second.memory], total: 2 }),
      read: request => request.id === 'm1' ? held.promise : Promise.resolve(second),
    })} />)
    fireEvent.click((await screen.findByText('Always show context provenance.')).closest('button')!)
    const loading = await screen.findByRole('dialog', { name: en.details })
    fireEvent.click(within(loading).getAllByRole('button', { name: en.close })[0]!)
    fireEvent.click(screen.getByText('Second memory.').closest('button')!)
    const dialog = await screen.findByRole('dialog', { name: en.details })
    expect(await within(dialog).findByText('Second memory.')).toBeTruthy()
    await act(async () => {
      if (outcome === 'resolve') held.resolve(first)
      else held.reject(new Error('Dismissed detail failed'))
      await held.promise.catch(() => undefined)
    })
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(within(dialog).getByText('Second memory.')).toBeTruthy()
    expect(within(dialog).queryByText('Always show context provenance.')).toBeNull()
  })
})

it.each(['sync', 'async'] as const)('keeps %s detail-read failure visible and retries the same selected record', async (mode) => {
  const read = vi.fn<MemoryCenterSectionInjected['read']>()
    .mockImplementationOnce(() => {
      const error = new Error('fixture read failure')
      if (mode === 'async') return Promise.reject(error)
      throw error
    })
    .mockResolvedValue(memory())
  render(<MemoryCenterSection {...props({ read })} />)
  fireEvent.click((await screen.findByText('Always show context provenance.')).closest('button')!)
  expect((await screen.findByRole('alert')).textContent).toContain(en.error)
  const dialog = screen.getByRole('dialog', { name: en.details })
  fireEvent.click(within(dialog).getByRole('button', { name: en.retry }))
  expect(await within(dialog).findByText('Always show context provenance.')).toBeTruthy()
  expect(read).toHaveBeenNthCalledWith(2, { workspaceId: '/work', sessionId: 'session', id: 'm1' }, true)
})

it('clears loading detail when the attached Session disappears', async () => {
  const held = Promise.withResolvers<MemoryCenterDetail>()
  const bindings = props({ read: () => held.promise })
  const view = render(<MemoryCenterSection {...bindings} />)
  fireEvent.click((await screen.findByText('Always show context provenance.')).closest('button')!)
  expect(await screen.findByRole('dialog', { name: en.details })).toBeTruthy()
  const detached = { ...sessions(), current: undefined }
  view.rerender(<MemoryCenterSection {...bindings} useSessions={selector => selector(detached)} />)
  expect(await screen.findByText(en.noSession)).toBeTruthy()
  expect(screen.queryByRole('dialog', { name: en.details })).toBeNull()
  await act(async () => { held.resolve(memory()); await held.promise })
  expect(screen.queryByRole('dialog', { name: en.details })).toBeNull()
})

it('does not dismiss a governed mutation while its acknowledgement is pending', async () => {
  const held = Promise.withResolvers<MemoryCenterDetail>()
  const approve = vi.fn(() => held.promise)
  render(<MemoryCenterSection {...props({ approve })} />)
  fireEvent.click((await screen.findByText('Always show context provenance.')).closest('button')!)
  const dialog = await screen.findByRole('dialog', { name: en.details })
  fireEvent.click(within(dialog).getByRole('button', { name: en.approve }))
  fireEvent.click(within(dialog).getAllByRole('button', { name: en.close })[0]!)
  expect(screen.getByRole('dialog', { name: en.details })).toBeTruthy()
  expect(approve).toHaveBeenCalledTimes(1)
  await act(async () => { held.resolve(memory('active')); await held.promise })
  expect(within(dialog).getByText(en.active)).toBeTruthy()
  fireEvent.click(within(dialog).getAllByRole('button', { name: en.close })[0]!)
  expect(screen.queryByRole('dialog', { name: en.details })).toBeNull()
})

describe('memory editor validation', () => {
  it.each([
    { label: en.confidence, value: '' },
    { label: en.confidence, value: '1.5' },
    { label: en.importance, value: '2.5' },
    { label: en.importance, value: '0' },
    { label: en.validUntilOptional, value: '2000-01-01T00:00' },
  ])('rejects invalid $label input $value visibly without revision writes', async ({ label, value }) => {
    const revise = vi.fn(async () => memory('active'))
    render(<MemoryCenterSection {...props({ revise })} />)
    fireEvent.click((await screen.findByText('Always show context provenance.')).closest('button')!)
    const dialog = await screen.findByRole('dialog', { name: en.details })
    fireEvent.click(within(dialog).getByRole('button', { name: en.edit }))
    fireEvent.change(within(dialog).getByLabelText(label), { target: { value } })
    fireEvent.click(within(dialog).getByRole('button', { name: en.save }))
    expect(revise).not.toHaveBeenCalled()
    expect((await within(dialog).findByRole('alert')).textContent)
      .toContain('Enter valid importance, confidence, and a future expiry time.')
  })
})


it.each([{ importance: '1', confidence: '0', expiry: false }, { importance: '4', confidence: '1', expiry: true }])('saves valid boundary values and clears optional fields: %j', async ({ importance, confidence, expiry }) => {
  const detail = memory()
  const selected: MemoryCenterDetail = {
    ...detail,
    memory: {
      ...detail.memory,
      entry: { ...detail.memory.entry, ...(expiry ? { validUntil: new Date(2035, 0, 2, 3, 4).getTime() } : {}) },
    },
  }
  const revise = vi.fn(async () => memory('active'))
  render(<MemoryCenterSection {...props({ read: async () => selected, revise })} />)
  fireEvent.click((await screen.findByText('Always show context provenance.')).closest('button')!)
  const dialog = await screen.findByRole('dialog', { name: en.details })
  fireEvent.click(within(dialog).getByRole('button', { name: en.edit }))
  const expiryInput = within(dialog).getByLabelText<HTMLInputElement>(en.validUntilOptional)
  expect(expiryInput.value).toBe(expiry ? '2035-01-02T03:04' : '')
  fireEvent.change(within(dialog).getByLabelText(en.content), { target: { value: '  revised content  ' } })
  fireEvent.change(within(dialog).getByLabelText(en.summary), { target: { value: '  ' } })
  fireEvent.change(within(dialog).getByLabelText(en.importance), { target: { value: importance } })
  fireEvent.change(within(dialog).getByLabelText(en.confidence), { target: { value: '' } })
  fireEvent.click(within(dialog).getByRole('button', { name: en.save }))
  expect(await within(dialog).findByRole('alert')).toBeTruthy()
  fireEvent.change(within(dialog).getByLabelText(en.confidence), { target: { value: confidence } })
  expect(within(dialog).queryByRole('alert')).toBeNull()
  fireEvent.change(expiryInput, { target: { value: '' } })
  fireEvent.click(within(dialog).getByRole('button', { name: en.save }))
  await waitFor(() => { expect(revise).toHaveBeenCalledWith('session', 'm1', 1, {
    content: '  revised content  ', summary: null, importance: Number(importance), confidence: Number(confidence), validUntil: null,
  }) })
})

it('preserves the loaded page and visibly retries a failed next page at the same offset', async () => {
  const first = memory()
  const second: MemoryCenterDetail = {
    ...first, memory: { ...first.memory, entry: { ...first.memory.entry, id: 'm2' as never, content: 'Next page memory.' } },
  }
  const list = vi.fn<MemoryCenterSectionInjected['list']>()
    .mockResolvedValueOnce({ ...snapshot(first), total: 2, hasMore: true })
    .mockRejectedValueOnce(new Error('fixture page failure'))
    .mockResolvedValueOnce({ ...snapshot(second), total: 2, offset: 1 })
  render(<MemoryCenterSection {...props({ list })} />)
  fireEvent.click(await screen.findByRole('button', { name: en.loadMore }))
  expect(await screen.findByRole('alert')).toBeTruthy()
  expect(screen.getByText('Always show context provenance.')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  expect(await screen.findByText('Next page memory.')).toBeTruthy()
  expect(screen.getByText('Always show context provenance.')).toBeTruthy()
  expect(list.mock.calls[1]?.[0].offset).toBe(1)
  expect(list.mock.calls[2]?.[0].offset).toBe(1)
})

it('trims search and resets status filters without confusing empty and filtered results', async () => {
  const list = vi.fn<MemoryCenterSectionInjected['list']>()
    .mockResolvedValue({ ...snapshot(), entries: [], total: 0 })
  render(<MemoryCenterSection {...props({ list })} />)
  expect(await screen.findByText(en.empty)).toBeTruthy()
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '  provenance  ' } })
  expect(await screen.findByText(en.noResults)).toBeTruthy()
  expect(list.mock.lastCall?.[0]).toEqual({
    workspaceId: '/work', sessionId: 'session', query: 'provenance', includeExpired: true, offset: 0, limit: 50,
  })
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'active' } })
  await waitFor(() => { expect(list.mock.lastCall?.[0].statuses).toEqual(['active']) })
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: '  ' } })
  expect(await screen.findByText(en.noResults)).toBeTruthy()
  expect(list.mock.lastCall?.[0].query).toBeUndefined()
  fireEvent.change(screen.getByRole('combobox'), { target: { value: 'all' } })
  expect(await screen.findByText(en.empty)).toBeTruthy()
  expect(list.mock.lastCall?.[0].statuses).toBeUndefined()
})

it.each(['resolve', 'reject'] as const)('does not replace a filtered result with an older initial list %s', async (outcome) => {
  const held = Promise.withResolvers<MemoryCenterSnapshot>()
  const list = vi.fn<MemoryCenterSectionInjected['list']>()
    .mockReturnValueOnce(held.promise)
    .mockResolvedValue({ ...snapshot(), entries: [], total: 0 })
  render(<MemoryCenterSection {...props({ list })} />)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
  expect(await screen.findByText(en.noResults)).toBeTruthy()
  await act(async () => {
    if (outcome === 'resolve') held.resolve(snapshot())
    else held.reject(new Error('Obsolete list failed'))
    await held.promise.catch(() => undefined)
  })
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText(en.noResults)).toBeTruthy()
  expect(screen.queryByText('Always show context provenance.')).toBeNull()
})

it('disables duplicate pagination and discards its late result after a filter change', async () => {
  const held = Promise.withResolvers<MemoryCenterSnapshot>()
  const list = vi.fn<MemoryCenterSectionInjected['list']>()
    .mockResolvedValueOnce({ ...snapshot(), total: 2, hasMore: true })
    .mockReturnValueOnce(held.promise)
    .mockResolvedValue({ ...snapshot(), entries: [], total: 0 })
  render(<MemoryCenterSection {...props({ list })} />)
  fireEvent.click(await screen.findByRole('button', { name: en.loadMore }))
  const loading = screen.getByRole<HTMLButtonElement>('button', { name: en.loading })
  expect(loading.disabled).toBe(true)
  fireEvent.click(loading)
  expect(list).toHaveBeenCalledTimes(2)
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'missing' } })
  expect(await screen.findByText(en.noResults)).toBeTruthy()
  await act(async () => { held.resolve(snapshot()); await held.promise })
  expect(screen.getByText(en.noResults)).toBeTruthy()
  expect(screen.queryByText('Always show context provenance.')).toBeNull()
  expect(screen.queryByRole('button', { name: en.loadMore })).toBeNull()
})

it.each([new Error('Revision changed'), new Error(''), 'transport rejected'])('retains deletion reason after failure and retries the displayed revision: %j', async (failure) => {
  const tombstone = vi.fn<MemoryCenterSectionInjected['tombstone']>()
    .mockRejectedValueOnce(failure)
    .mockResolvedValueOnce(memory('tombstoned'))
  render(<MemoryCenterSection {...props({ tombstone })} />)
  fireEvent.click((await screen.findByText('Always show context provenance.')).closest('button')!)
  const dialog = await screen.findByRole('dialog', { name: en.details })
  const reason = within(dialog).getByLabelText<HTMLInputElement>(en.reason)
  const remove = within(dialog).getByRole<HTMLButtonElement>('button', { name: en.delete })
  fireEvent.change(reason, { target: { value: '   ' } })
  expect(remove.disabled).toBe(true)
  fireEvent.click(remove)
  expect(tombstone).not.toHaveBeenCalled()
  fireEvent.change(reason, { target: { value: '  Incorrect inference  ' } })
  fireEvent.click(remove)
  expect((await within(dialog).findByRole('alert')).textContent)
    .toBe(failure instanceof Error && failure.message !== '' ? failure.message : en.deleteFailed)
  expect(reason.value).toBe('  Incorrect inference  ')
  expect(remove.disabled).toBe(false)
  fireEvent.click(remove)
  expect(await within(dialog).findByText(en.tombstoned)).toBeTruthy()
  expect(tombstone.mock.calls).toEqual([
    ['session', 'm1', 1, '  Incorrect inference  '], ['session', 'm1', 1, '  Incorrect inference  '],
  ])
  expect(within(dialog).queryByRole('button', { name: en.delete })).toBeNull()
  expect(within(dialog).queryByRole('button', { name: en.edit })).toBeNull()
  expect(within(dialog).queryByRole('alert')).toBeNull()
})

it.each(['resolve', 'reject'] as const)('ignores a late governance %s after switching the attached Session', async (outcome) => {
  const held = Promise.withResolvers<MemoryCenterDetail>()
  const list = vi.fn(async () => snapshot())
  const injected = props({ list, approve: () => held.promise })
  const rendered = render(<MemoryCenterSection {...injected} />)
  fireEvent.click((await screen.findByText('Always show context provenance.')).closest('button')!)
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.approve }))
  const otherId = 'other-session' as SessionId
  const otherState: SessionListState = { ...sessions(), current: otherId,
    byId: { [otherId]: { ...sessions().byId['session' as SessionId]!, id: otherId, cwd: '/other' } }, ids: [otherId] }
  rendered.rerender(<MemoryCenterSection {...injected} useSessions={selector => selector(otherState)} />)
  await waitFor(() => { expect(list.mock.calls).toHaveLength(2) })
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => {
    if (outcome === 'resolve') held.resolve(memory('active'))
    else held.reject(new Error('Old session failure'))
    await held.promise.catch(() => undefined)
  })
  expect(list.mock.calls).toHaveLength(2)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(await screen.findByText('Always show context provenance.')).toBeTruthy()
})

it.each([
  ['supersedes', en.supersedes], ['superseded-by', en.supersededBy], ['exact-duplicate', en.exactDuplicate],
  ['normalized-summary-collision', en.summaryCollision], ['semantic-conflict', en.semanticConflict],
] as const)('shows attributed %s comparisons rather than presenting the score as canonical truth', async (relation, label) => {
  const original = memory()
  const compared = { ...original.memory, entry: { ...original.memory.entry, id: 'comparison' as never, content: 'Compared preference' } }
  const detail: MemoryCenterDetail = { ...original,
    conflicts: [{ relation, entry: compared, detectorId: 'fixture-detector', score: 0.75, reasons: ['review required'] }] }
  render(<MemoryCenterSection {...props({ read: async () => detail })} />)
  fireEvent.click((await screen.findByText('Always show context provenance.')).closest('button')!)
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText(`${label}:`).closest('li')?.textContent)
    .toContain('Compared preference fixture-detector · 75% · review required')
})

it.each(['complete', 'partial', 'unavailable'] as const)('distinguishes absent evidence from %s usage coverage', async (coverage) => {
  const original = memory('tombstoned')
  const detail: MemoryCenterDetail = {
    ...original, memory: { ...original.memory, entry: { ...original.memory.entry, evidence: [] }, whyUsed: [] },
    signals: [], outcomes: [], outcomeCoverage: 'unavailable',
    usageCoverage: { status: coverage, sessionsScanned: 2, sessionsFailed: coverage === 'complete' ? 0 : 1 },
  }
  render(<MemoryCenterSection {...props({ read: async () => detail })} />)
  fireEvent.click((await screen.findByText('Always show context provenance.')).closest('button')!)
  const dialog = await screen.findByRole('dialog')
  for (const label of [en.noEvidence, en.noSignals, en.noOutcomes, en.outcomesUnavailable,
    coverage === 'complete' ? en.whyUsedEmpty : en.whyUsedUnavailable]) {
    expect(within(dialog).getByText(label)).toBeTruthy()
  }
  expect(within(dialog).queryByRole('button', { name: en.approve })).toBeNull()
  expect(within(dialog).queryByLabelText(en.reason)).toBeNull()
})

it('retries an initial list failure freshly and refreshes an already loaded list', async () => {
  const list = vi.fn<MemoryCenterSectionInjected['list']>()
    .mockRejectedValueOnce(new Error('List unavailable'))
    .mockResolvedValue(snapshot())
  render(<MemoryCenterSection {...props({ list })} />)
  expect(await screen.findByRole('alert')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: en.retry }))
  expect(await screen.findByText('Always show context provenance.')).toBeTruthy()
  expect(list.mock.calls[1]?.[1]).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: en.refresh }))
  expect(await screen.findByText('Always show context provenance.')).toBeTruthy()
  expect(list.mock.calls[2]?.[1]).toBe(true)
})

it('cancels an edited draft without revising and restores the persisted content when reopened', async () => {
  const revise = vi.fn(async () => memory())
  render(<MemoryCenterSection {...props({ revise })} />)
  fireEvent.click((await screen.findByText('Always show context provenance.')).closest('button')!)
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: en.edit }))
  fireEvent.change(within(dialog).getByLabelText(en.content), { target: { value: 'Unsaved draft' } })
  fireEvent.click(within(dialog).getByRole('button', { name: en.cancel }))
  expect(within(dialog).queryByLabelText(en.content)).toBeNull()
  expect(within(dialog).getByText('Always show context provenance.')).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: en.edit }))
  expect(within(dialog).getByLabelText<HTMLTextAreaElement>(en.content).value).toBe('Always show context provenance.')
  expect(revise).not.toHaveBeenCalled()
})

it('shows unknown usage revision and optional source metadata without inventing attribution', async () => {
  const original = memory('active')
  const { summary: _summary, ...entry } = original.memory.entry
  const { excerpt: _excerpt, ...evidence } = entry.evidence[0]!
  const { memoryRevision: _revision, ...usage } = original.memory.whyUsed[0]!
  const { sessionId: _sessionId, ...signal } = original.signals[0]!
  const detail: MemoryCenterDetail = {
    ...original,
    memory: {
      ...original.memory,
      entry: { ...entry, validUntil: Date.UTC(2030, 0, 1), evidence: [{ ...evidence, callId: 'call-fixture' as never }] },
      whyUsed: [{ ...usage, revisionState: 'unknown' }],
    },
    signals: [signal],
    outcomes: [{ ...original.outcomes[0]!, kind: 'assistant-negative', impact: 'negative', sourceRef: 'fixture-feedback-source' }],
    outcomeSummary: { positive: 0, negative: 1, neutral: 0, rankingAdjustment: -0.025 },
  }
  render(<MemoryCenterSection {...props({ list: async () => snapshot(detail), read: async () => detail })} />)
  fireEvent.click((await screen.findByText(entry.content)).closest('button')!)
  const dialog = await screen.findByRole('dialog')
  expect(within(dialog).getByText('agent-proposal · call-fixture')).toBeTruthy()
  expect(within(dialog).queryByText(en.noExpiry)).toBeNull()
  expect(within(dialog).queryByText('Show provenance')).toBeNull()
  expect(within(dialog).getByText(/revision \? \(unknown\)/u)).toBeTruthy()
  expect(within(dialog).getByText(/injected · Session —/u)).toBeTruthy()
  expect(within(dialog).getByText(/fixture-feedback-source/u)).toBeTruthy()
  expect(within(dialog).getByText(/ranking adjustment -2.5%/u)).toBeTruthy()
})

it('saves a future expiry and nonempty summary while preventing edits during acknowledgement', async () => {
  const original = memory('active')
  const { summary: _summary, ...entry } = original.memory.entry
  const detail: MemoryCenterDetail = { ...original, memory: { ...original.memory, entry } }
  const acknowledgement = Promise.withResolvers<MemoryCenterDetail>()
  const revise = vi.fn(() => acknowledgement.promise)
  render(<MemoryCenterSection {...props({ read: async () => detail, revise })} />)
  fireEvent.click((await screen.findByText(entry.content)).closest('button')!)
  const dialog = await screen.findByRole('dialog')
  fireEvent.click(within(dialog).getByRole('button', { name: en.edit }))
  const summary = within(dialog).getByLabelText<HTMLTextAreaElement>(en.summary)
  expect(summary.value).toBe('')
  const expiry = new Date(Date.now() + 86_400_000)
  expiry.setSeconds(0, 0)
  const pad = (value: number): string => String(value).padStart(2, '0')
  const localInput = `${expiry.getFullYear()}-${pad(expiry.getMonth() + 1)}-${pad(expiry.getDate())}T${pad(expiry.getHours())}:${pad(expiry.getMinutes())}`
  fireEvent.change(summary, { target: { value: '  retained summary  ' } })
  fireEvent.change(within(dialog).getByLabelText(en.validUntilOptional), { target: { value: localInput } })
  fireEvent.click(within(dialog).getByRole('button', { name: en.save }))
  expect(revise).toHaveBeenCalledWith('session', 'm1', 1, {
    content: entry.content, summary: '  retained summary  ', importance: 3, confidence: 0.8, validUntil: expiry.getTime(),
  })
  expect(summary.disabled).toBe(true)
  expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: en.cancel }).disabled).toBe(true)
  expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: en.pending }).disabled).toBe(true)
  await act(async () => { acknowledgement.resolve(detail); await acknowledgement.promise })
  expect(within(dialog).queryByLabelText(en.validUntilOptional)).toBeNull()
})
