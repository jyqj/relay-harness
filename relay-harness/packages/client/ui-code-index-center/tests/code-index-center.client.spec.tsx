// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CodeIndexCenterSection } from '../src/client/CodeIndexCenterSection.tsx'

const labels: Record<string, string> = {
  title: 'Code Index Center', intro: 'intro', refresh: 'Refresh index', reconcile: 'Reconcile coverage',
  rebuild: 'Force rebuild', rebuildTitle: 'Confirm force rebuild', rebuildHint: 'Type REBUILD', confirm: 'Confirm rebuild',
  cancel: 'Cancel', loading: 'Loading', error: 'Error', noWorkspace: 'Select workspace', workspace: 'Workspace',
  files: 'Files', chunks: 'Chunks', health: 'Health', epochs: 'Epochs', generations: 'Embedding Generations',
  noGenerations: 'No generations', backlog: 'Backlog', failed: 'Failed', coverage: 'Coverage', lastError: 'Last error',
  build: 'Latest BuildExplain', search: 'Search debug', searchPlaceholder: 'Query', run: 'Run', noHits: 'No hits',
  score: 'Score', reasons: 'Reasons',
}

function status(sessionId: string) {
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
    const listeners = new Set<() => void>()
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
    render(<CodeIndexCenterSection {...({
      currentSessionId: () => current,
      subscribeSession: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      status: async (sessionId: string) => status(sessionId),
      refresh: async (sessionId: string) => status(sessionId),
      reconcile: async (sessionId: string) => status(sessionId),
      rebuild,
      search,
      t: (key: string) => labels[key] ?? key,
    } as unknown as Parameters<typeof CodeIndexCenterSection>[0])}/>)
    expect(await screen.findByText(/\/workspace\/a/u)).toBeTruthy()
    current = 'b'
    for (const listener of listeners) listener()
    expect(await screen.findByText(/\/workspace\/b/u)).toBeTruthy()
    fireEvent.change(screen.getByPlaceholderText('Query'), { target: { value: 'needle' } })
    fireEvent.click(screen.getByText('Run'))
    expect(await screen.findByText(/b\/src.ts/u)).toBeTruthy()
    expect(search).toHaveBeenCalledWith('b', 'needle')
    fireEvent.click(screen.getByText('Force rebuild'))
    expect((screen.getByText('Confirm rebuild').closest('button') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('REBUILD'), { target: { value: 'REBUILD' } })
    fireEvent.click(screen.getByText('Confirm rebuild'))
    await waitFor(() => { expect(rebuild).toHaveBeenCalledWith('b') })
  })

  it('does not render a late status response from the previously selected Session', async () => {
    let current: string | undefined = 'a'
    const listeners = new Set<() => void>()
    let resolveA!: (value: ReturnType<typeof status>) => void
    const statusCall = vi.fn((sessionId: string) => sessionId === 'a'
      ? new Promise<ReturnType<typeof status>>((resolve) => { resolveA = resolve })
      : Promise.resolve(status(sessionId)))
    render(<CodeIndexCenterSection {...({
      currentSessionId: () => current,
      subscribeSession: (listener: () => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      status: statusCall,
      refresh: async (sessionId: string) => status(sessionId),
      reconcile: async (sessionId: string) => status(sessionId),
      rebuild: async (sessionId: string) => status(sessionId),
      search: vi.fn(),
      t: (key: string) => labels[key] ?? key,
    } as unknown as Parameters<typeof CodeIndexCenterSection>[0])}/>)
    await waitFor(() => { expect(statusCall).toHaveBeenCalledWith('a', false) })
    current = 'b'
    for (const listener of listeners) listener()
    expect(await screen.findByText(/\/workspace\/b/u)).toBeTruthy()
    resolveA(status('a'))
    await Promise.resolve()
    expect(screen.queryByText(/\/workspace\/a/u)).toBeNull()
  })
})
