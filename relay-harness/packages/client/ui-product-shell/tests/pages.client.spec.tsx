// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { LibraryPage } from '../src/client/LibraryPage.tsx'
import { WorkPage } from '../src/client/WorkPage.tsx'
import type { WorkSummary } from '../src/client/work-projection.ts'

afterEach(cleanup)
const t = ((key: string) => key) as never
const unused = (() => undefined) as never

describe('product navigation pages', () => {
  it('Library uses Files and Settings selection callbacks rather than local placeholders', () => {
    const openFiles = vi.fn()
    const openSettings = vi.fn()
    render(<LibraryPage
      wide
      expandSidebar={vi.fn()}
      useSessions={((select: (value: unknown) => unknown) => select({ current: 's1' })) as never}
      useWorkspaces={unused}
      openFiles={openFiles}
      openSettings={openSettings}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button', { name: 'library.files' }))
    fireEvent.click(screen.getByRole('button', { name: 'library.memory' }))
    fireEvent.click(screen.getByRole('button', { name: 'library.index' }))
    expect(openFiles).toHaveBeenCalledOnce()
    expect(openSettings.mock.calls).toEqual([['memory'], ['code-index']])
  })

  it('Work renders every composed projection family from one live summary', () => {
    const openDeliverable = vi.fn()
    const summary: WorkSummary = {
      sessionId: 's1',
      goal: { objective: 'Ship', phase: 'active' },
      plan: { active: true, pending: false },
      jobs: { total: 2, running: 1 },
      trajectoryRecords: 8,
      deliverables: ['out.md'],
      approvals: 1,
      questions: 2,
      completion: 'running',
      cwd: '/work',
    }
    render(<WorkPage
      wide
      expandSidebar={vi.fn()}
      useSessions={unused}
      useWorkspaces={unused}
      useWork={select => select(summary)}
      openDeliverable={openDeliverable}
      openFiles={vi.fn()}
      t={t}
    />)
    expect(screen.getByText('Ship')).toBeTruthy()
    expect(screen.getByText('work.completion.running')).toBeTruthy()
    expect(screen.getByText('1/2')).toBeTruthy()
    expect(screen.getByText('8')).toBeTruthy()
    expect(screen.getAllByText('1')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: 'out.md' }))
    expect(openDeliverable).toHaveBeenCalledWith('out.md')
  })
})
