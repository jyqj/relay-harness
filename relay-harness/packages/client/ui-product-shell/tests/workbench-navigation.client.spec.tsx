// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState } from '@relay-harness/rlh-client-runtime/client'
import { ProductNavigation, type ProductNavigationProps } from '../src/client/ProductNavigation.tsx'
import { WorkActivity, type WorkActivityProps } from '../src/client/WorkActivity.tsx'
import type { WorkSummary } from '../src/client/work-projection.ts'

const t = ((key: string) => key) as never
afterEach(cleanup)

describe('primary workbench navigation', () => {
  it('keeps all destinations available in both sidebar widths and reports only live attention', () => {
    const openPage = vi.fn()
    const navigation = (wide: boolean, availability: WorkSummary['availability']): ProductNavigationProps => ({
      wide, t, openPage,
      useMainNavigation: (select: (state: { page: string; revision: number }) => unknown) => select({ page: 'work', revision: 1 }),
      useWork: (select: (state: Partial<WorkSummary>) => unknown) => select({ availability, approvals: 1, questions: 2 }),
    }) as unknown as ProductNavigationProps
    const view = render(<ProductNavigation {...navigation(true, 'ready')} />)
    expect(screen.getByRole('navigation', { name: 'nav.primary' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'nav.work' }).getAttribute('aria-current')).toBe('page')
    expect(screen.getByLabelText('nav.attention').textContent).toBe('3')
    fireEvent.click(screen.getByRole('button', { name: 'nav.library' }))
    expect(openPage).toHaveBeenCalledWith('library')
    view.rerender(<ProductNavigation {...navigation(false, 'disconnected')} />)
    expect(screen.queryByLabelText('nav.attention')).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(3)
    fireEvent.click(screen.getByRole('button', { name: 'nav.chat' }))
    expect(openPage).toHaveBeenLastCalledWith('conversation')
  })
})

function activityProps(state: Partial<SessionListState>, openConversation = vi.fn()): WorkActivityProps {
  return { t, openConversation, useSessions: (select: (value: Partial<SessionListState>) => unknown) => select(state) } as unknown as WorkActivityProps
}

describe('work execution relationships', () => {
  it('does not imply success for inactive children and keeps failure and termination distinct', () => {
    const openConversation = vi.fn()
    render(<WorkActivity {...activityProps({
      current: 'root', byId: { root: { displayTitle: 'Root', parentId: 'parent' }, child: { pendingInteraction: 'approval' } },
      subagentsByParent: { root: { entries: [
        { kind: 'child', id: 'child', label: 'Needs access', activity: 'running' },
        { kind: 'child', id: 'idle-child', label: 'Not running child', activity: 'inactive' },
        { kind: 'child', id: 'running-child', label: 'Running child', activity: 'running' },
      ] } },
      jobsBySession: { root: [
        { id: 'failed', label: 'Tests', status: 'failed', detail: 'Assertion failed' },
        { id: 'killed', label: 'Build', status: 'killed' },
        { id: 'completed', label: 'Index', status: 'completed' },
        { id: 'running', label: 'Scan', status: 'running' },
        { id: 'stopping', label: 'Worker', status: 'stopping' },
      ] },
    } as unknown as SessionListState, openConversation)} />)
    expect(screen.getByText('work.activity.waiting')).toBeTruthy()
    expect(screen.getByText('work.activity.inactive')).toBeTruthy()
    expect(screen.getByText('work.job.failed')).toBeTruthy()
    expect(screen.getByText('work.job.killed')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /retry|stop|pause/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Needs access' }))
    fireEvent.click(screen.getByRole('button', { name: 'work.activity.parent' }))
    expect(openConversation.mock.calls).toEqual([['child'], ['parent']])
  })

  it('falls back to direct lineage only when no catalog is available', () => {
    render(<WorkActivity {...activityProps({ current: 'root', byId: {
      root: { displayTitle: 'Root' }, child: { id: 'child', parentId: 'root', displayTitle: 'Lineage child', running: false },
      unrelated: { id: 'unrelated', displayTitle: 'Unrelated', running: true },
    }, subagentsByParent: {}, jobsBySession: {} } as unknown as SessionListState)} />)
    expect(screen.getByRole('button', { name: 'Lineage child' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Unrelated' })).toBeNull()
  })

  it('does not turn a missing selected Session into an empty successful execution', () => {
    const view = render(<WorkActivity {...activityProps({ current: undefined })} />)
    expect(view.container.textContent).toBe('')
    view.rerender(<WorkActivity {...activityProps({ current: 'root', byId: {}, subagentsByParent: {}, jobsBySession: {} } as unknown as SessionListState)} />)
    expect(screen.getByText('work.activity.empty')).toBeTruthy()
  })
})
