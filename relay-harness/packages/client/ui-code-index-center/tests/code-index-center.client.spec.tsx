// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CodeIndexManagementStatus, CodeIndexSearchDebugResult } from '@relay-harness/rlh-api-remotes/client'
import type { SessionId, SessionListState } from '@relay-harness/rlh-client-runtime/client'
import { CodeIndexCenterSection } from '../src/client/CodeIndexCenterSection.tsx'

afterEach(cleanup)

const labels: Record<string, string> = {
  title: 'Code Index Center', intro: 'intro', refresh: 'Refresh index', reconcile: 'Reconcile coverage',
  rebuild: 'Force rebuild', rebuildTitle: 'Confirm force rebuild', rebuildHint: 'Type REBUILD', confirm: 'Confirm rebuild',
  cancel: 'Cancel', loading: 'Loading', error: 'Error', noWorkspace: 'Select workspace', workspace: 'Workspace',
  files: 'Files', chunks: 'Chunks', health: 'Health', epochs: 'Epochs', generations: 'Embedding Generations',
  noGenerations: 'No generations', backlog: 'Backlog', failed: 'Failed', coverage: 'Coverage', lastError: 'Last error',
  build: 'Latest BuildExplain', search: 'Search debug', searchPlaceholder: 'Query', run: 'Run', noHits: 'No hits',
  score: 'Score', reasons: 'Reasons',
}

function status(sessionId: string): CodeIndexManagementStatus {
  return {
    workspaceRoot: `/workspace/${sessionId}`,
    indexedFileCount: 2,
    chunkCount: 4,
    tier: 'tiny',
    epochs: { indexEpoch: 1, evidenceEpoch: 0, embeddingEpoch: 2 },
    degraded: false,
    generations: [{
      generationId: 'g1', providerId: 'p', endpointIdentity: 'local', model: 'embed', dimensionMode: 'fixed',
      configuredDimensions: 3, vectorizedChunks: 4, pendingJobs: 0, runningJobs: 0, failedJobs: 0,
    }],
    lastRefresh: {
      reason: 'manual', changedFiles: 1, removedFiles: 0, chunksWritten: 2, durationMs: 3,
      epochsAfter: { indexEpoch: 1, evidenceEpoch: 0, embeddingEpoch: 2 },
      explain: {
        scope: 'full' as const, requestedPaths: 0, pass: 'ran' as const, degraded: false,
        degradationReasons: [], dirty: null, embedding: null,
      },
    },
  }
}

describe('CodeIndexCenterSection', () => {
  it('follows Session switches, searches the selected workspace, and requires typed destructive approval', async () => {
    let current: string | undefined = 'a'
    const rebuild = vi.fn(async (sessionId: string) => status(sessionId))
    const search = vi.fn(async (sessionId: string) => ({
      executedTopK: 10,
      result: {
        query: 'needle', tier: 'tiny', candidateCount: 1, epochs: status(sessionId).epochs,
        truncated: false, degraded: false, readErrors: [],
        hits: [{
          chunkId: 'c', filePath: `${sessionId}/src.ts`, language: 'typescript', contentHash: 'h',
          startLine: 1, endLine: 2, score: 1, rank: 1, reasons: ['vector@1'], scoreTrace: [],
          parserTier: 'semantic', parserConfidence: 1,
        }],
      },
    }))
    const input = ({
      useSessions: (selector: (state: SessionListState) => unknown) => selector(sessionState(current)),
      status: async (sessionId: string) => status(sessionId),
      refresh: async (sessionId: string) => status(sessionId),
      reconcile: async (sessionId: string) => status(sessionId),
      rebuild,
      search,
      t: (key: string) => labels[key] ?? key,
    } as unknown as Parameters<typeof CodeIndexCenterSection>[0])
    const { rerender } = render(<CodeIndexCenterSection {...input}/>)
    expect(await screen.findByText(/\/workspace\/a/u)).toBeTruthy()
    current = 'b'
    rerender(<CodeIndexCenterSection {...input}/>)
    expect(await screen.findByText(/\/workspace\/b/u)).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('Query'), { target: { value: 'needle' } })
    fireEvent.keyDown(screen.getByPlaceholderText('Query'), { key: 'ArrowRight' })
    expect(search).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Run'))
    expect(await screen.findByText(/b\/src.ts/u)).toBeTruthy()
    expect(search).toHaveBeenCalledWith('b', 'needle')
    fireEvent.click(screen.getByText('Force rebuild'))
    expect((screen.getByText('Confirm rebuild').closest('button') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('REBUILD'), { target: { value: 'REBUILD' } })
    fireEvent.click(screen.getByText('Confirm rebuild'))
    await waitFor(() => { expect(rebuild).toHaveBeenCalledWith('b') })
  })

  it.each(['resolve', 'reject'] as const)('does not render a late status %s from the previously selected Session', async (outcome) => {
    let current: string | undefined = 'a'
    const held = Promise.withResolvers<CodeIndexManagementStatus>()
    const statusCall = vi.fn((sessionId: string) => sessionId === 'a'
      ? held.promise
      : Promise.resolve(status(sessionId)))
    const input = ({
      useSessions: (selector: (state: SessionListState) => unknown) => selector(sessionState(current)),
      status: statusCall,
      refresh: async (sessionId: string) => status(sessionId),
      reconcile: async (sessionId: string) => status(sessionId),
      rebuild: async (sessionId: string) => status(sessionId),
      search: vi.fn(),
      t: (key: string) => labels[key] ?? key,
    } as unknown as Parameters<typeof CodeIndexCenterSection>[0])
    const { rerender } = render(<CodeIndexCenterSection {...input}/>)
    await waitFor(() => { expect(statusCall).toHaveBeenCalledWith('a', false) })
    current = 'b'
    rerender(<CodeIndexCenterSection {...input}/>)
    expect(await screen.findByText(/\/workspace\/b/u)).toBeTruthy()
    await act(async () => {
      if (outcome === 'resolve') held.resolve(status('a'))
      else held.reject(new Error('Old status failed'))
      await held.promise.catch(() => undefined)
    })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/\/workspace\/a/u)).toBeNull()
  })
})

it('retires destructive confirmation and its token when the selected Session changes', async () => {
  let current: string | undefined = 'a'
  const rebuild = vi.fn(async (sessionId: string) => status(sessionId))
  const input = ({
    useSessions: (selector: (state: SessionListState) => unknown) => selector(sessionState(current)),
    status: async (sessionId: string) => status(sessionId),
    refresh: async (sessionId: string) => status(sessionId),
    reconcile: async (sessionId: string) => status(sessionId),
    rebuild, search: vi.fn(), t: (key: string) => labels[key] ?? key,
  } as unknown as Parameters<typeof CodeIndexCenterSection>[0])
  const { rerender } = render(<CodeIndexCenterSection {...input}/>)
  expect(await screen.findByText(/\/workspace\/a/u)).toBeTruthy()
  fireEvent.click(screen.getByText('Force rebuild'))
  fireEvent.change(screen.getByLabelText('REBUILD'), { target: { value: 'REBUILD' } })
  current = 'b'
  rerender(<CodeIndexCenterSection {...input}/>)
  expect(await screen.findByText(/\/workspace\/b/u)).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(rebuild).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Force rebuild'))
  expect(screen.getByLabelText<HTMLInputElement>('REBUILD').value).toBe('')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Confirm rebuild' }).disabled).toBe(true)
})

function sessionState(current: string | undefined): SessionListState {
  return {
    ids: [], byId: {}, current: current as SessionId | undefined, phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  }
}

it.each(['status', 'refresh', 'reconcile', 'rebuild', 'search'] as const)('recovers from a rejected %s request without losing the selected workspace', async (operation) => {
  const debug = {
    executedTopK: 10,
    result: { query: 'needle', tier: 'tiny', candidateCount: 0, epochs: status('a').epochs,
      truncated: false, degraded: false, readErrors: [], hits: [] },
  }
  const callbacks = {
    status: vi.fn(async () => status('a')),
    refresh: vi.fn(async () => status('a')),
    reconcile: vi.fn(async () => status('a')),
    rebuild: vi.fn(async () => status('a')),
    search: vi.fn(async () => debug),
  }
  callbacks[operation].mockRejectedValueOnce(new Error('Remote unavailable'))
  const input = {
    ...callbacks,
    useSessions: (selector: (state: SessionListState) => unknown) => selector(sessionState('a')),
    t: (key: string) => labels[key] ?? key,
  } as unknown as Parameters<typeof CodeIndexCenterSection>[0]
  render(<CodeIndexCenterSection {...input}/>)
  const trigger = async () => {
    if (operation === 'status' || operation === 'refresh') fireEvent.click(screen.getByText('Refresh index'))
    else if (operation === 'reconcile') fireEvent.click(screen.getByText('Reconcile coverage'))
    else if (operation === 'search') {
      fireEvent.change(screen.getByPlaceholderText('Query'), { target: { value: '  needle  ' } })
      fireEvent.click(screen.getByText('Run'))
    } else {
      fireEvent.click(screen.getByText('Force rebuild'))
      fireEvent.change(screen.getByLabelText('REBUILD'), { target: { value: 'REBUILD' } })
      fireEvent.click(screen.getByRole('button', { name: 'Confirm rebuild' }))
    }
  }
  if (operation !== 'status') {
    expect(await screen.findByText(/\/workspace\/a/u)).toBeTruthy()
    await trigger()
  }
  expect(await screen.findByRole('alert')).toBeTruthy()
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh index' }).disabled).toBe(false) })
  await trigger()
  await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
  expect(await screen.findByText(/\/workspace\/a/u)).toBeTruthy()
  if (operation === 'search') {
    expect(await screen.findByText('No hits')).toBeTruthy()
    expect(callbacks.search).toHaveBeenLastCalledWith('a', 'needle')
  } else {
    const retried = operation === 'status' ? callbacks.refresh : callbacks[operation]
    expect(retried).toHaveBeenLastCalledWith('a')
  }
})

it('sends no status, search or maintenance request without a selected Session', async () => {
  const statusCall = vi.fn()
  const refresh = vi.fn()
  const reconcile = vi.fn()
  const rebuild = vi.fn()
  const search = vi.fn()
  render(<CodeIndexCenterSection {...({
    useSessions: (selector: (state: SessionListState) => unknown) => selector(sessionState(undefined)),
    status: statusCall, refresh, reconcile, rebuild, search,
    t: (key: string) => labels[key] ?? key,
  } as unknown as Parameters<typeof CodeIndexCenterSection>[0])}/>)
  expect(screen.getByText('Select workspace')).toBeTruthy()
  for (const name of ['Refresh index', 'Reconcile coverage', 'Force rebuild', 'Run']) {
    expect(screen.getByRole<HTMLButtonElement>('button', { name }).disabled).toBe(true)
  }
  fireEvent.change(screen.getByPlaceholderText('Query'), { target: { value: 'needle' } })
  fireEvent.keyDown(screen.getByPlaceholderText('Query'), { key: 'Enter' })
  for (const callback of [statusCall, refresh, reconcile, rebuild, search]) expect(callback).not.toHaveBeenCalled()
})

it.each(['resolve', 'reject'] as const)('discards a late search %s after switching Session', async (outcome) => {
  let current = 'a'
  const held = Promise.withResolvers<CodeIndexSearchDebugResult>()
  const input = {
    useSessions: (selector: (state: SessionListState) => unknown) => selector(sessionState(current)),
    status: async (sessionId: string) => status(sessionId),
    refresh: async (sessionId: string) => status(sessionId),
    reconcile: async (sessionId: string) => status(sessionId),
    rebuild: vi.fn(), search: vi.fn(() => held.promise),
    t: (key: string) => labels[key] ?? key,
  } as unknown as Parameters<typeof CodeIndexCenterSection>[0]
  const { rerender } = render(<CodeIndexCenterSection {...input}/>)
  expect(await screen.findByText(/\/workspace\/a/u)).toBeTruthy()
  fireEvent.change(screen.getByPlaceholderText('Query'), { target: { value: 'needle' } })
  fireEvent.keyDown(screen.getByPlaceholderText('Query'), { key: 'Enter' })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run' }).disabled).toBe(true)
  current = 'b'
  rerender(<CodeIndexCenterSection {...input}/>)
  expect(await screen.findByText(/\/workspace\/b/u)).toBeTruthy()
  await act(async () => {
    if (outcome === 'resolve') held.resolve({ executedTopK: 10, result: {
      query: 'needle', tier: 'tiny', candidateCount: 0, epochs: status('a').epochs,
      truncated: false, degraded: false, readErrors: [], hits: [],
    } })
    else held.reject(new Error('Old search failed'))
    await held.promise.catch(() => undefined)
  })
  expect(screen.queryByText('No hits')).toBeNull()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByText(/\/workspace\/b/u)).toBeTruthy()
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run' }).disabled).toBe(false)
})

it.each(['empty', 'failed-generation'] as const)('renders %s status without inventing successful build or embedding evidence', async (mode) => {
  const initial = status('a')
  const { lastRefresh: _lastRefresh, ...base } = initial
  const detail: CodeIndexManagementStatus = {
    ...base,
    degraded: true,
    epochs: { indexEpoch: 3, evidenceEpoch: 0 },
    generations: mode === 'empty' ? [] : [{ ...initial.generations[0]!, pendingJobs: 2, runningJobs: 1, failedJobs: 4, lastError: 'Embedding endpoint unavailable' }],
    lastError: 'Watcher unavailable',
  }
  render(<CodeIndexCenterSection {...({
    useSessions: (selector: (state: SessionListState) => unknown) => selector(sessionState('a')),
    status: async () => detail, refresh: vi.fn(), reconcile: vi.fn(), rebuild: vi.fn(), search: vi.fn(),
    t: (key: string) => labels[key] ?? key,
  } as unknown as Parameters<typeof CodeIndexCenterSection>[0])}/>)
  expect(await screen.findByText('degraded')).toBeTruthy()
  expect(screen.getByText('3/0')).toBeTruthy()
  expect(screen.getByText('Last error: Watcher unavailable')).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Latest BuildExplain' })).toBeNull()
  if (mode === 'empty') expect(screen.getByText('No generations')).toBeTruthy()
  else {
    expect(screen.getByText('Embedding endpoint unavailable')).toBeTruthy()
    expect(screen.getByText(/Backlog: 3 · Failed: 4/u)).toBeTruthy()
  }
})

it.each(['button', 'escape'] as const)('cancels rebuild by %s without dispatch and requires a fresh token on reopening', async (method) => {
  const rebuild = vi.fn()
  render(<CodeIndexCenterSection {...({
    useSessions: (selector: (state: SessionListState) => unknown) => selector(sessionState('a')),
    status: async () => status('a'), refresh: vi.fn(), reconcile: vi.fn(), rebuild, search: vi.fn(),
    t: (key: string) => labels[key] ?? key,
  } as unknown as Parameters<typeof CodeIndexCenterSection>[0])}/>)
  expect(await screen.findByText(/\/workspace\/a/u)).toBeTruthy()
  fireEvent.click(screen.getByText('Force rebuild'))
  let dialog = screen.getByRole('dialog')
  fireEvent.change(within(dialog).getByLabelText('REBUILD'), { target: { value: 'REBUILD' } })
  if (method === 'button') fireEvent.click(within(dialog).getAllByRole('button', { name: 'Cancel' }).at(-1)!)
  else fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(rebuild).not.toHaveBeenCalled()
  fireEvent.click(screen.getByText('Force rebuild'))
  dialog = screen.getByRole('dialog')
  expect(within(dialog).getByLabelText<HTMLInputElement>('REBUILD').value).toBe('')
  expect(within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Confirm rebuild' }).disabled).toBe(true)
})
