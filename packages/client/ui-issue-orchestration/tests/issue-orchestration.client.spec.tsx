// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@relay-harness/cordis'
import InvariantRegistry from '@relay-harness/rlh-invariants'
import type { IssueOrchestrationSnapshot } from '@relay-harness/rlh-api-remotes/client'
import type { SessionId } from '@relay-harness/rlh-client-connection/client'
import { IssueOrchestrationAction, type IssueOrchestrationActionProps } from '../src/client/IssueOrchestrationAction.tsx'
import { IssueOrchestrationPanel, type IssueOrchestrationPanelProps } from '../src/client/IssueOrchestrationPanel.tsx'
import { IssueDashboardController, type IssueDashboardState } from '../src/client/state.ts'
import { zh } from '../src/client/locales.ts'
import { apply } from '../src/client/index.ts'
import { apply as applyHost } from '../src/index.ts'
import * as Invariant from '../src/invariant.ts'

afterEach(cleanup)

const snapshot: IssueOrchestrationSnapshot = {
  revision: 3,
  workflowRevision: '0123456789abcdef',
  checking: false,
  nextPollAt: Date.now() + 1000,
  running: [{
    issue: { id: 'run' as never, identifier: 'ENG-1', title: 'Running issue', state: 'In Progress', labels: [], blockedBy: [], dispatchable: true },
    status: 'running', attempt: 1, workspacePath: '/work/ENG-1', sessionId: 'session-1' as SessionId,
    startedAt: 1, lastProgressAt: 2, updatedAt: 2,
  }],
  retrying: [{
    issue: { id: 'retry' as never, identifier: 'ENG-2', title: 'Retry issue', state: 'Todo', labels: [], blockedBy: [], dispatchable: true },
    status: 'retrying', attempt: 2, nextRetryAt: Date.now() + 2000, error: 'network', updatedAt: 3,
  }],
  blocked: [{
    issue: { id: 'blocked' as never, identifier: 'ENG-3', title: 'Blocked issue', state: 'Todo', labels: [], blockedBy: [], dispatchable: true },
    status: 'blocked', attempt: 2, error: 'needs input', updatedAt: 4,
  }],
}

const t = (key: keyof typeof zh, values?: Record<string, unknown>): string => {
  let text: string = zh[key]
  for (const [name, value] of Object.entries(values ?? {})) text = text.replace(`{{${name}}}`, String(value))
  return text
}

function hook(state: IssueDashboardState) {
  return <T,>(selector: (value: IssueDashboardState) => T): T => selector(state)
}

describe('IssueDashboardController', () => {
  it('keeps the host half as a no-op package marker', () => {
    applyHost()
  })

  it('reserves the package invariant ownership', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(Invariant)
    await ctx.fiber.dispose()
  })

  it('publishes open, loading, loaded, failure, and close states', () => {
    const controller = new IssueDashboardController()
    controller.open(); controller.loading(); controller.loaded(snapshot)
    expect(controller.state.getSnapshot()).toMatchObject({ open: true, loading: false, snapshot })
    controller.failed('offline')
    expect(controller.state.getSnapshot()).toMatchObject({ error: 'offline', loading: false })
    controller.close()
    expect(controller.state.getSnapshot().open).toBe(false)
  })
})

describe('issue orchestration presentation', () => {
  it('shows a titlebar count and opens the dashboard', () => {
    const openDashboard = vi.fn()
    const props = {
      useIssueDashboard: hook({ open: false, loading: false, snapshot }), openDashboard, t,
    } as unknown as IssueOrchestrationActionProps
    render(<IssueOrchestrationAction {...props} />)
    expect(screen.getByText('3')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '工单自动化' }))
    expect(openDashboard).toHaveBeenCalledOnce()

    const { rerender } = render(<IssueOrchestrationAction {...({
      useIssueDashboard: hook({ open: false, loading: false }), openDashboard, t,
    } as unknown as IssueOrchestrationActionProps)} />)
    expect(screen.queryByText('0')).toBeNull()
    rerender(<IssueOrchestrationAction {...({
      useIssueDashboard: hook({
        open: false, loading: false,
        snapshot: { ...snapshot, running: Array.from({ length: 100 }, () => snapshot.running[0]!) },
      }),
      openDashboard,
      t,
    } as unknown as IssueOrchestrationActionProps)} />)
    expect(screen.getByText('99+')).toBeTruthy()
  })

  it('renders all states and executes retry, release, refresh, navigation, and close', async () => {
    const callbacks = {
      closeDashboard: vi.fn(), refreshDashboard: vi.fn(async () => {}),
      retryIssue: vi.fn(async () => {}), releaseIssue: vi.fn(async () => {}), openSession: vi.fn(),
    }
    const props = {
      useIssueDashboard: hook({ open: true, loading: false, snapshot }), t, ...callbacks,
    } as unknown as IssueOrchestrationPanelProps
    render(<IssueOrchestrationPanel {...props} />)
    expect(screen.getByText('Running issue')).toBeTruthy()
    expect(screen.getByText('Retry issue')).toBeTruthy()
    expect(screen.getByText('Blocked issue')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '立即刷新' }))
    fireEvent.click(screen.getAllByRole('button', { name: '重试' })[0]!)
    await waitFor(() => { expect(callbacks.retryIssue).toHaveBeenCalled() })
    fireEvent.click(screen.getAllByRole('button', { name: '释放' })[0]!)
    fireEvent.click(screen.getByRole('button', { name: '打开会话' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭工单自动化' }))
    await waitFor(() => {
      expect(callbacks.refreshDashboard).toHaveBeenCalledOnce()
      expect(callbacks.releaseIssue).toHaveBeenCalled()
    })
    expect(callbacks.openSession).toHaveBeenCalledWith('session-1')
    expect(callbacks.closeDashboard).toHaveBeenCalledOnce()
  })

  it('renders loading, empty, and load/action failures', async () => {
    const failed = vi.fn(async () => { throw new Error('action offline') })
    const loadingProps = {
      useIssueDashboard: hook({ open: true, loading: true }), t,
      closeDashboard: vi.fn(), refreshDashboard: vi.fn(async () => {}), retryIssue: failed,
      releaseIssue: vi.fn(async () => {}), openSession: vi.fn(),
    } as unknown as IssueOrchestrationPanelProps
    const { rerender } = render(<IssueOrchestrationPanel {...loadingProps} />)
    expect(screen.getByText('正在读取调度状态…')).toBeTruthy()
    const empty = { ...snapshot, running: [], retrying: [], blocked: [] }
    const emptyProps = {
      useIssueDashboard: hook({ open: true, loading: false, snapshot: empty, error: 'host offline' }), t,
      closeDashboard: vi.fn(), refreshDashboard: vi.fn(async () => {}), retryIssue: failed,
      releaseIssue: vi.fn(async () => {}), openSession: vi.fn(),
    } as unknown as IssueOrchestrationPanelProps
    rerender(<IssueOrchestrationPanel {...emptyProps} />)
    expect(screen.getByText('当前没有运行、重试或阻塞的工单。')).toBeTruthy()
    expect(screen.getByText(/读取失败：host offline/)).toBeTruthy()

    const blocked = { ...snapshot, checking: true, running: [], retrying: [], blocked: snapshot.blocked }
    const failureProps = {
      useIssueDashboard: hook({ open: true, loading: false, snapshot: blocked }), t,
      closeDashboard: vi.fn(), refreshDashboard: vi.fn(async () => {}), retryIssue: failed,
      releaseIssue: vi.fn(async () => {}), openSession: vi.fn(),
    } as unknown as IssueOrchestrationPanelProps
    rerender(<IssueOrchestrationPanel {...failureProps} />)
    expect(screen.getByText(/正在对账/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(screen.getByText(/操作失败：action offline/)).toBeTruthy() })
    const stringFailureProps = {
      ...failureProps,
      retryIssue: vi.fn(async () => { throw 'string failure' }),
    }
    rerender(<IssueOrchestrationPanel {...stringFailureProps} />)
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    await waitFor(() => { expect(screen.getByText(/操作失败：string failure/)).toBeTruthy() })

    fireEvent.mouseDown(document.querySelector('[data-shell-modal-overlay]')!)
    expect(failureProps.closeDashboard).toHaveBeenCalledOnce()
    fireEvent.mouseDown(screen.getByRole('dialog'))
    expect(failureProps.closeDashboard).toHaveBeenCalledOnce()
  })

  it('renders nothing while closed', () => {
    const { container } = render(<IssueOrchestrationPanel {...({
      useIssueDashboard: hook({ open: false, loading: false }), t,
    } as unknown as IssueOrchestrationPanelProps)} />)
    expect(container.childElementCount).toBe(0)
  })

  it('wires Remote refresh, commands, updates, errors, navigation, and close through apply', async () => {
    const ctx = new Context()
    let onChanged: (() => void) | undefined
    let snapshotResult: unknown = { ok: true, value: snapshot }
    const snapshotFailure: { current?: unknown } = {}
    const retry = vi.fn(async () => ({ ok: true, value: undefined }))
    const release = vi.fn(async () => ({ ok: true, value: undefined }))
    const refresh = vi.fn(async () => ({ ok: true, value: { queued: true, coalesced: false, requestedAt: 1 } }))
    ctx.provide('remote', {
      issueOrchestration: {
        snapshot: () => {
          if (snapshotFailure.current !== undefined) throw snapshotFailure.current
          return Promise.resolve(snapshotResult)
        },
        retry,
        release,
        refresh,
      },
      $on: (_name: string, callback: () => void) => { onChanged = callback; return () => {} },
    } as never)
    const open = vi.fn()
    ctx.provide('sessions', { open } as never)
    ctx.provide('locale', { register: () => () => {} } as never)
    const registrations: Array<{ name: string; inject: () => unknown }> = []
    ctx.provide('slots', {
      inject: (_name: string, callback: () => void) => { callback(); return () => {} },
      register: (spec: { name: string; inject: () => unknown }) => {
        registrations.push(spec)
        return () => {}
      },
    } as never)
    apply(ctx)
    await waitFor(() => { expect(registrations).toHaveLength(2) })
    const action = registrations.find(entry => entry.name === 'shell.titlebar.trailing')!.inject() as {
      hooks: { issueDashboard: { getSnapshot(): IssueDashboardState } }
      openDashboard(): void
    }
    const panel = registrations.find(entry => entry.name === 'shell.overlay')!.inject() as {
      closeDashboard(): void
      refreshDashboard(): Promise<void>
      retryIssue(id: string): Promise<void>
      releaseIssue(id: string): Promise<void>
      openSession(id: SessionId): void
    }
    await waitFor(() => { expect(action.hooks.issueDashboard.getSnapshot().snapshot).toEqual(snapshot) })
    action.openDashboard()
    panel.openSession('session-1' as SessionId)
    await panel.refreshDashboard()
    await panel.retryIssue('retry')
    await panel.releaseIssue('blocked')
    panel.closeDashboard()
    expect(open).toHaveBeenCalledWith('session-1')
    expect(retry).toHaveBeenCalled()
    expect(release).toHaveBeenCalled()

    snapshotResult = { ok: false, error: { code: 'OFFLINE', message: 'host offline' } }
    onChanged?.()
    await waitFor(() => { expect(action.hooks.issueDashboard.getSnapshot().error).toContain('OFFLINE') })
    snapshotFailure.current = 'wire offline'
    onChanged?.()
    await waitFor(() => { expect(action.hooks.issueDashboard.getSnapshot().error).toBe('wire offline') })
    retry.mockResolvedValueOnce({ ok: false, error: { code: 'DENIED', message: 'no' } } as never)
    await expect(panel.retryIssue('retry')).rejects.toThrow(/DENIED/)
    refresh.mockResolvedValueOnce({ ok: false, error: { code: 'OFFLINE', message: 'no' } } as never)
    await expect(panel.refreshDashboard()).rejects.toThrow(/OFFLINE/)
  })
})
