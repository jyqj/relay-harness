// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within, act } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { SessionId, SessionListState } from '@relay-harness/rlh-client-runtime/client'
import { createSnapshotStore } from '@relay-harness/rlh-client-runtime/client'
import type { GitActionsProps } from '../src/client/GitActionsControl.tsx'
import { GitActionsControl } from '../src/client/GitActionsControl.tsx'
import type { VcsStatus } from '../src/client/git-logic.ts'
import { en } from '../src/client/locales.ts'

const SID = 'session-git' as SessionId
const t: GitActionsProps['t'] = (key, params) => {
  const template = (en as Record<string, string>)[key] ?? key
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (
    name in params ? String(params[name]) : match
  ))
}
const neverWorkspaces = (() => { throw new Error('git actions must not read useWorkspaces') }) as never

function sessionList(cwd: string | undefined): SessionListState {
  const current = cwd === undefined ? undefined : SID
  const byId = current === undefined
    ? {}
    : {
      [SID]: {
        id: SID,
        displayTitle: 'proj',
        running: false,
        blank: false,
        updatedAt: 1,
        ...(cwd ? { cwd } : {}),
      },
    }
  return {
    ids: current === undefined ? [] : [SID],
    byId,
    current,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  }
}

function useSessionsStub(list: SessionListState): GitActionsProps['useSessions'] {
  return sel => sel(list)
}

function status(overrides: Partial<VcsStatus> = {}): VcsStatus {
  return {
    refName: 'feature/test',
    hasWorkingTreeChanges: false,
    hasUpstream: true,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    isDefaultRef: false,
    hasPrimaryRemote: true,
    isRepo: true,
    sourceControlProvider: {
      kind: 'github',
      name: 'GitHub',
      baseUrl: 'https://github.com',
    },
    workingTree: { files: [], insertions: 0, deletions: 0 },
    ...overrides,
  }
}

function filesTree(files: Array<{ path: string; insertions: number; deletions: number }>) {
  return {
    files,
    insertions: files.reduce((sum, file) => sum + file.insertions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  }
}

function mount(opts: {
  useSessions?: GitActionsProps['useSessions']
  cwd?: string | undefined
  git?: VcsStatus | null
  gitStatus?: GitActionsProps['gitStatus']
  gitFetchForStatus?: GitActionsProps['gitFetchForStatus']
  gitReadPullRequest?: GitActionsProps['gitReadPullRequest']
  gitInit?: GitActionsProps['gitInit']
  gitCommit?: GitActionsProps['gitCommit']
  gitPush?: GitActionsProps['gitPush']
  gitPull?: GitActionsProps['gitPull']
  gitCreateChangeRequest?: GitActionsProps['gitCreateChangeRequest']
  gitPublishRepository?: GitActionsProps['gitPublishRepository']
  gitBranchList?: GitActionsProps['gitBranchList']
  gitSwitchBranch?: GitActionsProps['gitSwitchBranch']
  gitCreateBranch?: GitActionsProps['gitCreateBranch']
  openWorkspacePath?: GitActionsProps['openWorkspacePath']
  openExternal?: GitActionsProps['openExternal']
  onGitProgress?: GitActionsProps['onGitProgress']
  density?: GitActionsProps['density']
  titlebarGit?: boolean
  useTitlebarGit?: GitActionsProps['useTitlebarGit']
} = {}) {
  const gitStatus = opts.gitStatus ?? vi.fn(async () => opts.git ?? null)
  const gitFetchForStatus = opts.gitFetchForStatus ?? vi.fn(async () => opts.git ?? null)
  const gitReadPullRequest = opts.gitReadPullRequest ?? vi.fn(async () => ({
    ok: true,
    pr: (opts.git ?? status()).pr,
  }))
  const gitInit = opts.gitInit ?? vi.fn(async () => ({ ok: true }))
  const gitCommit = opts.gitCommit ?? vi.fn(async () => ({ ok: true }))
  const gitPush = opts.gitPush ?? vi.fn(async () => ({ ok: true }))
  const gitPull = opts.gitPull ?? vi.fn(async () => ({ ok: true }))
  const gitCreateChangeRequest = opts.gitCreateChangeRequest ?? vi.fn(async () => ({ ok: true }))
  const gitPublishRepository = opts.gitPublishRepository ?? vi.fn(async () => ({ ok: true }))
  const gitBranchList = opts.gitBranchList ?? vi.fn(async () => ({ ok: true, branches: [] }))
  const gitSwitchBranch = opts.gitSwitchBranch ?? vi.fn(async () => ({ ok: true }))
  const gitCreateBranch = opts.gitCreateBranch ?? vi.fn(async () => ({ ok: true }))
  const openWorkspacePath = opts.openWorkspacePath ?? vi.fn(async () => ({ ok: true }))
  const onGitProgress = opts.onGitProgress ?? vi.fn(() => () => {})
  const openExternal = opts.openExternal ?? vi.fn(async () => true)
  const view = render(
    <GitActionsControl
      surfaces={0}
      terminalDrawer={0}
      {...(opts.density === undefined ? {} : { density: opts.density })}
      useSessions={opts.useSessions ?? useSessionsStub(sessionList(opts.cwd))}
      useWorkspaces={neverWorkspaces}
      gitStatus={gitStatus}
      gitFetchForStatus={gitFetchForStatus}
      gitReadPullRequest={gitReadPullRequest}
      gitInit={gitInit}
      gitCommit={gitCommit}
      gitPush={gitPush}
      gitPull={gitPull}
      gitCreateChangeRequest={gitCreateChangeRequest}
      gitPublishRepository={gitPublishRepository}
      gitBranchList={gitBranchList}
      gitSwitchBranch={gitSwitchBranch}
      gitCreateBranch={gitCreateBranch}
      onGitProgress={onGitProgress}
      openExternal={openExternal}
      openWorkspacePath={openWorkspacePath}
      useTitlebarGit={opts.useTitlebarGit ?? (sel => sel(opts.titlebarGit !== false))}
      t={t}
    />,
  )
  return {
    gitStatus, gitFetchForStatus, gitReadPullRequest, gitInit, gitCommit, gitPush, gitPull, gitCreateChangeRequest,
    gitPublishRepository, gitBranchList, gitSwitchBranch, gitCreateBranch, openWorkspacePath,
    onGitProgress, openExternal, rerender: view.rerender,
  }
}

afterEach(cleanup)

describe('GitActionsControl', () => {
  it('disables the main button when the current session has no cwd', () => {
    const b = mount({ cwd: undefined })
    const main = screen.getByRole<HTMLButtonElement>('button', { name: 'Commit' })
    expect(main.disabled).toBe(true)
    expect(b.gitStatus).not.toHaveBeenCalled()
  })

  it('disables the main button and shows the unavailable hint when status is null', async () => {
    mount({ cwd: '/work', git: null })
    const main = await screen.findByRole<HTMLButtonElement>('button', { name: 'Commit' })
    expect(main.disabled).toBe(true)
    fireEvent.focus(main)
    expect(await screen.findByText('Git status is unavailable.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Git actions' }))
    expect(screen.queryByRole('menuitem', { name: 'Publish repository' })).toBeNull()
  })

  it('labels the main button Commit & push when the default ref has local changes', async () => {
    mount({
      cwd: '/work',
      git: status({
        refName: 'main',
        hasWorkingTreeChanges: true,
        isDefaultRef: true,
      }),
    })
    expect((await screen.findByRole<HTMLButtonElement>('button', { name: 'Commit & push' })).disabled).toBe(false)
  })

  it('labels the main button Push when the default ref is clean and ahead', async () => {
    mount({
      cwd: '/work',
      git: status({
        refName: 'main',
        aheadCount: 2,
        isDefaultRef: true,
      }),
    })
    expect((await screen.findByRole<HTMLButtonElement>('button', { name: 'Push' })).disabled).toBe(false)
  })

  it('opens a menu with Commit, Push, and Create PR', async () => {
    mount({
      cwd: '/work',
      git: status({ aheadCount: 2 }),
    })
    await screen.findByRole('button', { name: 'Push & create PR' })
    fireEvent.click(screen.getByRole('button', { name: 'Git actions' }))
    expect(await screen.findByRole('menuitem', { name: 'Commit' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Push' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Create PR' })).toBeTruthy()
  })

  it('shows why a disabled menu row is unavailable and a behind-upstream footer', async () => {
    mount({ cwd: '/work', git: status({ behindCount: 1 }) })
    fireEvent.click(await screen.findByRole('button', { name: 'Git actions' }))
    const push = await screen.findByRole('menuitem', { name: 'Push' })
    expect(push).toHaveProperty('disabled', true)
    fireEvent.mouseEnter(push.parentElement!)
    expect((await screen.findByRole('tooltip')).textContent).toBe(
      'Branch is behind upstream. Pull/rebase before pushing.',
    )
    expect(screen.getByText('Behind upstream. Pull/rebase first.')).toBeTruthy()
  })

  it('shows the detached HEAD menu footer', async () => {
    mount({ cwd: '/work', git: status({ refName: null }) })
    fireEvent.click(await screen.findByRole('button', { name: 'Git actions' }))
    expect(await screen.findByText(
      'Detached HEAD: create and checkout a branch to enable push and pull request actions.',
    )).toBeTruthy()
  })

  it('asks for confirmation before pushing on the default ref', async () => {
    const b = mount({
      cwd: '/work',
      git: status({
        refName: 'main',
        aheadCount: 2,
        isDefaultRef: true,
      }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Push' }))
    expect(await screen.findByRole('dialog', { name: 'Push to default ref?' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Checkout feature branch & continue' })).toBeNull()
    expect(screen.getByText(
      'This action will push local commits on "main". You can continue on this ref or create a feature ref and run the same action there.',
    )).toBeTruthy()
    expect(b.gitPush).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Push to main' }))
    await waitFor(() => { expect(b.gitPush).toHaveBeenCalledWith('/work', expect.any(Number)) })
  })

  it('keeps a stable useSessions hook count when a session cwd appears', async () => {
    const gitStatus = vi.fn(async () => status({ aheadCount: 2 }))
    const shared = {
      surfaces: 0,
      terminalDrawer: 0,
      useWorkspaces: neverWorkspaces,
      gitStatus,
      gitFetchForStatus: vi.fn(async () => status({ aheadCount: 2 })),
      gitReadPullRequest: vi.fn(async () => ({ ok: true, pr: null })),
      gitInit: vi.fn(async () => ({ ok: true })),
      gitCommit: vi.fn(async () => ({ ok: true })),
      gitPush: vi.fn(async () => ({ ok: true })),
      gitPull: vi.fn(async () => ({ ok: true })),
      gitCreateChangeRequest: vi.fn(async () => ({ ok: true })),
      gitPublishRepository: vi.fn(async () => ({ ok: true })),
      gitBranchList: vi.fn(async () => ({ ok: true, branches: [] })),
      gitSwitchBranch: vi.fn(async () => ({ ok: true })),
      gitCreateBranch: vi.fn(async () => ({ ok: true })),
      onGitProgress: vi.fn(() => () => {}),
      openExternal: vi.fn(async () => true),
      openWorkspacePath: vi.fn(async () => ({ ok: true })),
      useTitlebarGit: sel => sel(true),
      t,
    } satisfies Omit<GitActionsProps, 'useSessions'>
    const { rerender } = render(
      <GitActionsControl {...shared} useSessions={useSessionsStub(sessionList(undefined))} />,
    )
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Commit' }).disabled).toBe(true)
    expect(gitStatus).not.toHaveBeenCalled()
    rerender(
      <GitActionsControl {...shared} useSessions={useSessionsStub(sessionList('/work'))} />,
    )
    expect(await screen.findByRole('button', { name: 'Push & create PR' })).toBeTruthy()
  })

  it('shows the IPC failure on the same progress toast', async () => {
    const gitPush = vi.fn(async () => ({ ok: false, message: 'origin rejected the push.' }))
    mount({
      cwd: '/work',
      git: status({
        refName: 'main',
        aheadCount: 2,
        isDefaultRef: true,
      }),
      gitPush,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Push' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Push to main' }))
    expect(await screen.findByRole('status', { name: 'Action failed' })).toBeTruthy()
    expect(screen.getByText('origin rejected the push.')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Action failed' })).toBeNull()
  })

  it('refreshes git status on window focus', async () => {
    const gitStatus = vi.fn(async () => status({ aheadCount: 2 }))
    mount({ cwd: '/work', gitStatus })
    await waitFor(() => { expect(gitStatus).toHaveBeenCalledTimes(1) })
    fireEvent(window, new Event('focus'))
    await waitFor(() => { expect(gitStatus).toHaveBeenCalledTimes(2) }, { timeout: 1000 })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => { expect(gitStatus).toHaveBeenCalledTimes(3) }, { timeout: 1000 })
  })

  it('opens the publish dialog and submits gh repo create', async () => {
    const gitPublishRepository = vi.fn(async () => ({ ok: true, url: 'https://github.com/org/work' }))
    mount({
      cwd: '/work',
      git: status({
        hasUpstream: false,
        hasPrimaryRemote: false,
      }),
      gitPublishRepository,
    })
    const main = await screen.findByRole<HTMLButtonElement>('button', { name: 'Publish repository' })
    expect(main.disabled).toBe(false)
    fireEvent.click(main)
    expect(await screen.findByRole('dialog', { name: 'Publish repository' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
    expect(screen.queryByRole('dialog', { name: 'Publish repository' })).toBeNull()
    await waitFor(() => {
      expect(gitPublishRepository).toHaveBeenCalledWith('/work', {
        name: 'work',
        visibility: 'private',
      }, expect.any(Number))
    })
  })

  it('closes the publish dialog while publishing and reopens it on failure', async () => {
    let finish = (value: { ok: boolean; message?: string }) => { void value }
    const gitPublishRepository = vi.fn(() => new Promise<{ ok: boolean; message?: string }>((resolve) => {
      finish = resolve
    }))
    mount({
      cwd: '/work',
      git: status({
        hasUpstream: false,
        hasPrimaryRemote: false,
      }),
      gitPublishRepository,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Publish repository' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Publish' }))
    expect(screen.queryByRole('dialog', { name: 'Publish repository' })).toBeNull()
    expect(screen.getByRole('status', { name: 'Publishing repository...' })).toBeTruthy()
    finish({ ok: false, message: 'gh is unavailable.' })
    expect(await screen.findByRole('status', { name: 'Action failed' })).toBeTruthy()
    expect(await screen.findByRole('dialog', { name: 'Publish repository' })).toBeTruthy()
  })

  it('offers Publish repository in the menu when there is no origin', async () => {
    mount({
      cwd: '/work',
      git: status({
        hasWorkingTreeChanges: true,
        hasUpstream: false,
        hasPrimaryRemote: false,
      }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Git actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Publish repository' }))
    expect(await screen.findByRole('dialog', { name: 'Publish repository' })).toBeTruthy()
  })

  it('keeps a PR failure on the toast after a successful push', async () => {
    const gitCommit = vi.fn(async () => ({ ok: true, commitSha: 'abc', subject: 'Add files' }))
    const gitPush = vi.fn(async () => ({ ok: true, status: 'pushed', branch: 'feature/test' }))
    const gitCreateChangeRequest = vi.fn(async () => ({ ok: false, message: 'gh is unavailable.' }))
    mount({
      cwd: '/work',
      git: status({ hasWorkingTreeChanges: true }),
      gitCommit,
      gitPush,
      gitCreateChangeRequest,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Commit, push & PR' }))
    expect(await screen.findByRole('status', { name: 'Action failed' })).toBeTruthy()
    expect(screen.getByText('gh is unavailable.')).toBeTruthy()
    expect(gitCreateChangeRequest).toHaveBeenCalledWith('/work', {}, expect.any(Number))
  })

  it('shows Initialize Git when the cwd is not a repository', async () => {
    mount({
      cwd: '/work',
      git: status({
        isRepo: false,
        refName: null,
        hasPrimaryRemote: false,
      }),
    })
    expect(await screen.findByRole('button', { name: 'Initialize Git' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Git actions' })).toBeNull()
  })

  it('hides the branch ref name at compact density', async () => {
    mount({ cwd: '/work', git: status({ refName: 'master' }), density: 'compact' })
    const trigger = await screen.findByRole('button', { name: 'Switch branch' })
    expect(trigger.textContent).not.toContain('master')
    expect(screen.getByRole('button', { name: 'Commit' }).textContent).toContain('Commit')
  })

  it('hides Initialize Git text at compact density', async () => {
    mount({
      cwd: '/work',
      git: status({ isRepo: false, refName: null, hasPrimaryRemote: false }),
      density: 'compact',
    })
    const init = await screen.findByRole('button', { name: 'Initialize Git' })
    expect(init.textContent).not.toContain('Initialize Git')
  })

  it('runs gitInit when Initialize Git is clicked', async () => {
    const gitInit = vi.fn(async () => ({ ok: true }))
    const gitStatus = vi.fn()
      .mockResolvedValueOnce(status({ isRepo: false, refName: null, hasPrimaryRemote: false }))
      .mockResolvedValue(status({ isRepo: true, hasWorkingTreeChanges: true }))
    mount({ cwd: '/work', gitStatus, gitInit })
    fireEvent.click(await screen.findByRole('button', { name: 'Initialize Git' }))
    await waitFor(() => { expect(gitInit).toHaveBeenCalledWith('/work') })
    await waitFor(() => { expect(gitStatus).toHaveBeenCalledTimes(2) })
  })

  it('shows Initializing and the IPC failure when gitInit fails', async () => {
    let finish: (result: { ok: boolean; message: string }) => void = () => {}
    const gitInit = vi.fn(() => new Promise<{ ok: boolean; message: string }>((resolve) => {
      finish = resolve
    }))
    mount({
      cwd: '/work',
      git: status({ isRepo: false, refName: null, hasPrimaryRemote: false }),
      gitInit,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Initialize Git' }))
    expect(await screen.findByRole('status', { name: 'Initializing...' })).toBeTruthy()
    finish({ ok: false, message: 'cannot init' })
    expect(await screen.findByRole('status', { name: 'Action failed' })).toBeTruthy()
    expect(screen.getByText('cannot init')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Action failed' })).toBeNull()
  })

  it('labels the main button Pull when the ref is behind', async () => {
    mount({ cwd: '/work', git: status({ behindCount: 1 }) })
    expect((await screen.findByRole<HTMLButtonElement>('button', { name: 'Pull' })).disabled).toBe(false)
  })

  it('labels the main button View PR when an open change request exists', async () => {
    mount({
      cwd: '/work',
      git: status({
        pr: {
          number: 1,
          title: 'x',
          url: 'https://example.com/1',
          baseRef: 'main',
          headRef: 'feature/test',
          state: 'open',
        },
      }),
    })
    expect(await screen.findByRole('button', { name: 'View PR' })).toBeTruthy()
  })

  it('toasts when View PR has no URL from the menu or the main button', async () => {
    const missingUrl = status({
      pr: {
        number: 1,
        title: 'x',
        url: '',
        baseRef: 'main',
        headRef: 'feature/test',
        state: 'open',
      },
    })
    mount({ cwd: '/work', git: missingUrl })
    fireEvent.click(await screen.findByRole('button', { name: 'View PR' }))
    expect(await screen.findByRole('status', { name: 'Action failed' })).toBeTruthy()
    expect(screen.getByText('No open PR URL.')).toBeTruthy()
  })

  it('labels the main button Sync branch when the ref has diverged', async () => {
    mount({ cwd: '/work', git: status({ aheadCount: 1, behindCount: 1 }) })
    const main = await screen.findByRole<HTMLButtonElement>('button', { name: 'Sync branch' })
    expect(main.disabled).toBe(true)
  })

  it('labels the main button Commit, push & PR on a feature ref with local changes', async () => {
    mount({ cwd: '/work', git: status({ hasWorkingTreeChanges: true }) })
    expect(await screen.findByRole('button', { name: 'Commit, push & PR' })).toBeTruthy()
  })

  it('still runs gitCommit for Commit, push & PR when live porcelain looks clean', async () => {
    const preview = status({ hasWorkingTreeChanges: true })
    const live = status({ hasWorkingTreeChanges: false, aheadCount: 1 })
    const gitStatus = vi.fn(async () => live)
    const gitCommit = vi.fn(async () => ({ ok: true, skipped: true, status: 'skipped' }))
    const gitPush = vi.fn(async () => ({ ok: true, status: 'pushed' }))
    const gitCreateChangeRequest = vi.fn(async () => ({
      ok: true,
      status: 'created',
      url: 'https://github.com/acme/demo/pull/1',
    }))
    mount({ cwd: '/work', git: preview, gitStatus, gitCommit, gitPush, gitCreateChangeRequest })
    fireEvent.click(await screen.findByRole('button', { name: 'Commit, push & PR' }))
    await waitFor(() => { expect(gitCommit).toHaveBeenCalled() })
    expect(gitPush).toHaveBeenCalled()
    expect(gitCreateChangeRequest).toHaveBeenCalled()
  })

  it('commit dialog file list follows live status.workingTree while open', async () => {
    let files = [{ path: 'a.ts', insertions: 1, deletions: 0 }]
    const gitStatus = vi.fn(async () => status({
      hasWorkingTreeChanges: true,
      workingTree: filesTree(files),
    }))
    mount({ cwd: '/work', gitStatus })
    fireEvent.click(await screen.findByRole('button', { name: 'Git actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Commit' }))
    expect(await screen.findByRole('dialog', { name: 'Commit changes' })).toBeTruthy()
    expect(screen.getByText('a.ts')).toBeTruthy()
    files = [{ path: 'b.ts', insertions: 2, deletions: 0 }]
    fireEvent(window, new Event('focus'))
    await waitFor(() => {
      expect(screen.getByText('b.ts')).toBeTruthy()
    })
    expect(screen.queryByText('a.ts')).toBeNull()
  })

  it('opens the commit review dialog from status.workingTree files', async () => {
    const gitCommit = vi.fn(async () => ({ ok: true }))
    mount({
      cwd: '/work',
      git: status({
        hasWorkingTreeChanges: true,
        refName: 'large-bird',
        workingTree: {
          files: [{ path: 'src/demo.ts', insertions: 2, deletions: 1 }],
          insertions: 2,
          deletions: 1,
        },
      }),
      gitCommit,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Git actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Commit' }))
    expect(await screen.findByRole('dialog', { name: 'Commit changes' })).toBeTruthy()
    expect(screen.getAllByText('large-bird').length).toBeGreaterThan(0)
    expect(screen.getByText('src/demo.ts')).toBeTruthy()
    expect(screen.getAllByText('+2').length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    await waitFor(() => { expect(gitCommit).toHaveBeenCalledWith('/work', '', undefined, expect.any(Number), undefined) })
  })

  it('creates a feature ref before commit when Commit on new branch is used', async () => {
    const gitBranchList = vi.fn(async () => ({
      ok: true,
      branches: [{ name: 'main', isRemote: false, isCurrent: false }],
    }))
    const gitCreateBranch = vi.fn(async () => ({ ok: true, refName: 'feature/update' }))
    const gitCommit = vi.fn(async () => ({ ok: true }))
    mount({
      cwd: '/work',
      git: status({
        hasWorkingTreeChanges: true,
        refName: 'main',
        isDefaultRef: true,
        workingTree: filesTree([{ path: 'a.ts', insertions: 1, deletions: 0 }]),
      }),
      gitBranchList,
      gitCreateBranch,
      gitCommit,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Git actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Commit' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Commit on new branch' }))
    await waitFor(() => {
      expect(gitCommit).toHaveBeenCalledWith('/work', '', undefined, expect.any(Number), { featureBranch: true })
    })
    expect(gitCreateBranch).not.toHaveBeenCalled()
  })

  it('opens the commit review dialog from the Commit-only main button', async () => {
    mount({
      cwd: '/work',
      git: status({
        hasWorkingTreeChanges: true,
        hasUpstream: false,
        hasPrimaryRemote: false,
        workingTree: filesTree([{ path: 'only.ts', insertions: 1, deletions: 0 }]),
      }),
    })
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Commit' }).disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    expect(await screen.findByRole('dialog', { name: 'Commit changes' })).toBeTruthy()
    expect(screen.getByText('only.ts')).toBeTruthy()
  })

  it('opens the commit dialog with none when workingTree has no files', async () => {
    mount({
      cwd: '/work',
      git: status({ hasWorkingTreeChanges: true }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Git actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Commit' }))
    expect(await screen.findByRole('dialog', { name: 'Commit changes' })).toBeTruthy()
    expect(screen.getByText('none')).toBeTruthy()
  })

  it('commits only the files that remain selected after Edit', async () => {
    const gitCommit = vi.fn(async () => ({ ok: true }))
    mount({
      cwd: '/work',
      git: status({
        hasWorkingTreeChanges: true,
        refName: 'large-bird',
        workingTree: filesTree([
          { path: 'keep.ts', insertions: 1, deletions: 0 },
          { path: 'skip.ts', insertions: 2, deletions: 0 },
        ]),
      }),
      gitCommit,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Git actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Commit' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Files' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Files' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'skip.ts' }))
    fireEvent.change(screen.getByPlaceholderText('Leave empty to auto-generate'), {
      target: { value: 'keep only' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    await waitFor(() => {
      expect(gitCommit).toHaveBeenCalledWith('/work', 'keep only', ['keep.ts'], expect.any(Number), undefined)
    })
  })

  it('passes featureBranch into gitCommit for Commit on new branch', async () => {
    const gitCommit = vi.fn(async () => ({ ok: false, message: 'cannot create ref.' }))
    mount({
      cwd: '/work',
      git: status({
        hasWorkingTreeChanges: true,
        workingTree: filesTree([{ path: 'a.ts', insertions: 1, deletions: 0 }]),
      }),
      gitCommit,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Git actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Commit' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Commit on new branch' }))
    expect(await screen.findByRole('status', { name: 'Action failed' })).toBeTruthy()
    expect(screen.getByText('cannot create ref.')).toBeTruthy()
    expect(gitCommit).toHaveBeenCalledWith('/work', '', undefined, expect.any(Number), { featureBranch: true })
  })

  it('shows a live progress toast as soon as Commit, push & PR starts', async () => {
    const initial = status({ hasWorkingTreeChanges: true })
    let resolveLive: (value: VcsStatus | null) => void = () => {}
    let statusCalls = 0
    const gitStatus = vi.fn(() => {
      statusCalls += 1
      if (statusCalls === 1) return Promise.resolve(initial)
      return new Promise<VcsStatus | null>((resolve) => {
        resolveLive = resolve
      })
    })
    const gitCommit = vi.fn(async () => ({ ok: false, message: 'lefthook failed\noxfmt --check' }))
    mount({
      cwd: '/work',
      git: initial,
      gitStatus,
      gitCommit,
    })
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Commit, push & PR' }).disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Commit, push & PR' }))
    expect(await screen.findByRole('status', { name: 'Generating commit message...' })).toBeTruthy()
    expect(screen.getByText('Waiting for Git...')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Action failed' })).toBeNull()
    expect(gitCommit).not.toHaveBeenCalled()
    resolveLive(initial)
    expect(await screen.findByRole('status', { name: 'Action failed' })).toBeTruthy()
    expect(screen.getByText('lefthook failed')).toBeTruthy()
  })

  it('replaces the loading toast with hook output from onGitProgress', async () => {
    let send: ((event: {
      actionId: number
      kind: string
      title?: string
      text?: string
    }) => void) | undefined
    const onGitProgress = vi.fn((handler: (event: {
      actionId: number
      kind: string
      title?: string
      text?: string
    }) => void) => {
      send = handler
      return () => {}
    })
    let finish: (result: { ok: boolean }) => void = () => {}
    const gitCommit = vi.fn((
      _cwd: string,
      _message: string,
      _filePaths: readonly string[] | undefined,
      _actionId: number | undefined,
      _options?: { featureBranch?: boolean }  ,
    ) => new Promise<{ ok: boolean }>((resolve) => {
      finish = resolve
    }))
    const gitPush = vi.fn(async () => ({ ok: true }))
    const gitCreateChangeRequest = vi.fn(async () => ({ ok: true }))
    mount({
      cwd: '/work',
      git: status({ hasWorkingTreeChanges: true }),
      gitCommit,
      gitPush,
      gitCreateChangeRequest,
      onGitProgress,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Commit, push & PR' }))
    await waitFor(() => { expect(gitCommit).toHaveBeenCalled() })
    const actionId = gitCommit.mock.calls[0]?.[3] as number
    send?.({ actionId, kind: 'hook', title: 'Running pre-commit...', text: 'lefthook v2.1.10' })
    expect(await screen.findByText('Running pre-commit...')).toBeTruthy()
    expect(screen.getByText('lefthook v2.1.10')).toBeTruthy()
    send?.({ actionId, kind: 'hook_finished', title: 'Finished pre-commit', text: 'pre-commit finished' })
    expect(await screen.findByText('Generating commit message...')).toBeTruthy()
    expect(screen.queryByText('pre-commit finished')).toBeNull()
    finish({ ok: true })
    expect(await screen.findByRole('status', { name: 'Created PR' })).toBeTruthy()
  })

  it('creates a feature ref from the default-ref confirm when the action includes a commit', async () => {
    let phase: 'before' | 'after' = 'before'
    const before = status({
      refName: 'main',
      hasWorkingTreeChanges: true,
      isDefaultRef: true,
    })
    const after = status({
      refName: 'feature/add-files',
      hasWorkingTreeChanges: false,
      isDefaultRef: false,
      hasUpstream: true,
      aheadCount: 0,
    })
    const gitStatus = vi.fn(async () => (phase === 'before' ? before : after))
    const gitFetchForStatus = vi.fn(async () => (phase === 'before' ? before : after))
    const gitReadPullRequest = vi.fn(async () => ({ ok: true, pr: null }))
    const gitCommit = vi.fn(async () => {
      phase = 'after'
      return { ok: true, commitSha: 'abcdef1', subject: 'Add files' }
    })
    const gitPush = vi.fn(async () => ({
      ok: true,
      status: 'pushed',
      upstreamBranch: 'origin/feature/add-files',
    }))
    mount({
      cwd: '/work',
      gitStatus,
      gitFetchForStatus,
      gitReadPullRequest,
      gitCommit,
      gitPush,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Commit & push' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Checkout feature branch & continue' }))
    await waitFor(() => {
      expect(gitCommit).toHaveBeenCalledWith('/work', '', undefined, expect.any(Number), { featureBranch: true })
    })
    expect(await screen.findByRole('button', { name: 'Create PR' })).toBeTruthy()
  })

  it('shows a commit-only success toast without waiting for fetch', async () => {
    const gitCommit = vi.fn(async () => ({ ok: true, commitSha: 'abc1234', subject: 'Add files' }))
    const initial = status({
      hasWorkingTreeChanges: true,
      hasUpstream: false,
      hasPrimaryRemote: false,
      workingTree: filesTree([{ path: 'only.ts', insertions: 1, deletions: 0 }]),
    })
    let fetchCalls = 0
    const gitFetchForStatus = vi.fn(async () => {
      fetchCalls += 1
      if (fetchCalls === 1) return initial
      return new Promise<VcsStatus | null>(() => {})
    })
    mount({
      cwd: '/work',
      git: initial,
      gitCommit,
      gitFetchForStatus,
    })
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Commit' }).disabled).toBe(false)
    })
    fireEvent.click(screen.getByRole('button', { name: 'Commit' }))
    const dialog = await screen.findByRole('dialog', { name: 'Commit changes' })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Commit' }))
    expect(await screen.findByRole('status', { name: 'Committed abc1234' })).toBeTruthy()
  })

  it('shows switch failure on the progress toast', async () => {
    const gitBranchList = vi.fn(async () => ({
      ok: true,
      branches: [
        { name: 'feature/test', isRemote: false, isCurrent: true },
        { name: 'main', isRemote: false, isCurrent: false },
      ],
    }))
    const gitSwitchBranch = vi.fn(async () => ({ ok: false, message: 'checkout failed' }))
    mount({
      cwd: '/work',
      git: status({ hasWorkingTreeChanges: true }),
      gitBranchList,
      gitSwitchBranch,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Switch branch' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'main' }))
    expect(await screen.findByRole('status', { name: 'Failed to switch branch.' })).toBeTruthy()
    expect(screen.getByText('checkout failed')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Action failed' })).toBeNull()
  })

  it('shows an open-file failure on the progress toast', async () => {
    const openWorkspacePath = vi.fn(async () => ({ ok: false, message: 'no handler' }))
    mount({
      cwd: '/work',
      git: status({
        hasWorkingTreeChanges: true,
        workingTree: filesTree([{ path: 'only.ts', insertions: 1, deletions: 0 }]),
      }),
      openWorkspacePath,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Git actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Commit' }))
    fireEvent.click(await screen.findByRole('button', { name: 'only.ts' }))
    expect(await screen.findByRole('status', { name: 'Unable to open file' })).toBeTruthy()
    expect(screen.getByText('no handler')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Action failed' })).toBeNull()
  })

  it('disables the branch picker while a stacked action is running', async () => {
    const pending = Promise.withResolvers<{ ok: boolean }>()
    const gitPush = vi.fn(() => pending.promise)
    mount({
      cwd: '/work',
      git: status({
        refName: 'main',
        aheadCount: 2,
        isDefaultRef: true,
      }),
      gitPush,
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Push' }))
    fireEvent.click(screen.getByRole('button', { name: 'Push to main' }))
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Switch branch' }).disabled).toBe(true)
    })
    pending.resolve({ ok: true })
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Switch branch' }).disabled).toBe(false)
    })
  })

  it('hides and restores the titlebar cluster from the live Interface preference', async () => {
    const titlebarGit = createSnapshotStore(true)
    mount({
      cwd: '/work',
      git: status(),
      // oxlint-disable-next-line typescript/unbound-method -- snapshot store methods do not read `this`
      useTitlebarGit: sel => useSyncExternalStore(titlebarGit.subscribe, () => sel(titlebarGit.getSnapshot())),
    })
    expect(await screen.findByRole('button', { name: 'Commit' })).toBeTruthy()
    act(() => { titlebarGit.set(false) })
    expect(screen.queryByRole('button', { name: 'Commit' })).toBeNull()
    act(() => { titlebarGit.set(true) })
    expect(screen.getByRole('button', { name: 'Commit' })).toBeTruthy()
  })

  it('keeps the init toast after Interface settings hide the cluster', async () => {
    const titlebarGit = createSnapshotStore(true)
    let finish: (result: { ok: boolean; message: string }) => void = () => {}
    const gitInit = vi.fn(() => new Promise<{ ok: boolean; message: string }>((resolve) => {
      finish = resolve
    }))
    mount({
      cwd: '/work',
      git: status({ isRepo: false, refName: null, hasPrimaryRemote: false }),
      gitInit,
      // oxlint-disable-next-line typescript/unbound-method -- snapshot store methods do not read `this`
      useTitlebarGit: sel => useSyncExternalStore(titlebarGit.subscribe, () => sel(titlebarGit.getSnapshot())),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Initialize Git' }))
    expect(await screen.findByRole('status', { name: 'Initializing...' })).toBeTruthy()
    act(() => { titlebarGit.set(false) })
    expect(screen.queryByRole('button', { name: 'Initialize Git' })).toBeNull()
    expect(screen.getByRole('status', { name: 'Initializing...' })).toBeTruthy()
    finish({ ok: false, message: 'cannot init' })
    expect(await screen.findByRole('status', { name: 'Action failed' })).toBeTruthy()
  })

  it('keeps the commit dialog after Interface settings hide the cluster', async () => {
    const titlebarGit = createSnapshotStore(true)
    mount({
      cwd: '/work',
      gitStatus: vi.fn(async () => status({
        hasWorkingTreeChanges: true,
        workingTree: filesTree([{ path: 'a.ts', insertions: 1, deletions: 0 }]),
      })),
      // oxlint-disable-next-line typescript/unbound-method -- snapshot store methods do not read `this`
      useTitlebarGit: sel => useSyncExternalStore(titlebarGit.subscribe, () => sel(titlebarGit.getSnapshot())),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Git actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Commit' }))
    expect(await screen.findByRole('dialog', { name: 'Commit changes' })).toBeTruthy()
    act(() => { titlebarGit.set(false) })
    expect(screen.queryByRole('button', { name: 'Git actions' })).toBeNull()
    expect(screen.getByRole('dialog', { name: 'Commit changes' })).toBeTruthy()
  })
})

describe('Git transport rejection handling', () => {
  it('settles initial transport rejection into unavailable rather than permanent loading', async () => {
    mount({ cwd: '/work', gitStatus: vi.fn(async () => { throw new Error('fixture disconnected') }) })
    const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'Commit' })
    fireEvent.focus(button)
    expect(await screen.findByText('Git status is unavailable.')).toBeTruthy()
    expect(button.disabled).toBe(true)
  })

  it('preserves local commit availability when background status enrichment rejects', async () => {
    const b = mount({
      cwd: '/work', git: status({ hasWorkingTreeChanges: true, refName: 'main', isDefaultRef: true }),
      gitFetchForStatus: vi.fn(async () => { throw new Error('fixture fetch unavailable') }),
      gitReadPullRequest: vi.fn(async () => { throw new Error('fixture PR unavailable') }),
    })
    const button = await screen.findByRole<HTMLButtonElement>('button', { name: 'Commit & push' })
    expect(button.disabled).toBe(false)
    expect(b.gitCommit).not.toHaveBeenCalled()
  })

  it('shows rejected action transport on the existing failure surface and clears busy state', async () => {
    const gitPush = vi.fn(async () => { throw new Error('fixture push transport lost') })
    mount({ cwd: '/work', git: status({ aheadCount: 2, isDefaultRef: true, refName: 'main' }), gitPush })
    fireEvent.click(await screen.findByRole('button', { name: 'Push' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Push to main' }))
    expect(await screen.findByRole('status', { name: 'Action failed' })).toBeTruthy()
    expect(screen.getByText('fixture push transport lost')).toBeTruthy()
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Push' }).disabled).toBe(false) })
    expect(gitPush).toHaveBeenCalledTimes(1)
  })
})


it('keeps successful mutation feedback when post-action status refresh rejects', async () => {
  let pushed = false
  const known = status({ aheadCount: 2, isDefaultRef: true, refName: 'main' })
  const b = mount({
    cwd: '/work',
    gitStatus: vi.fn(async () => { if (pushed) throw new Error('fixture status unavailable'); return known }),
    gitFetchForStatus: vi.fn(async () => { if (pushed) throw new Error('fixture fetch unavailable'); return known }),
    gitReadPullRequest: vi.fn(async () => { if (pushed) throw new Error('fixture PR unavailable'); return { ok: true, pr: null } }),
    gitPush: vi.fn(async () => { pushed = true; return { ok: true, status: 'pushed' as const, branch: 'main' } }),
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Push' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Push to main' }))
  expect(await screen.findByRole('status', { name: 'Pushed to main' })).toBeTruthy()
  expect(screen.queryByRole('status', { name: 'Action failed' })).toBeNull()
  expect(b.gitPush).toHaveBeenCalledTimes(1)
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Commit' }).disabled).toBe(true) })
})


describe('Git workspace ownership', () => {
  function changingSessions() {
    const sessions = createSnapshotStore(sessionList('/a'))
    const useSessions: GitActionsProps['useSessions'] = selector =>
      // oxlint-disable-next-line typescript/unbound-method -- snapshot store methods do not read this
      useSyncExternalStore(sessions.subscribe, () => selector(sessions.getSnapshot()))
    return { sessions, useSessions }
  }

  it('does not let completion in the old workspace overwrite the selected workspace status', async () => {
    const { sessions, useSessions } = changingSessions()
    const held = Promise.withResolvers<{ ok: true; status: 'pushed'; branch: string }>()
    const a = status({ refName: 'main', isDefaultRef: true, aheadCount: 2 })
    const b = status({ refName: 'release', isDefaultRef: true })
    const read = vi.fn(async (cwd: string) => cwd === '/a' ? a : b)
    const bench = mount({ useSessions, gitStatus: read, gitFetchForStatus: read, gitPush: vi.fn(() => held.promise) })
    fireEvent.click(await screen.findByRole('button', { name: 'Push' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Push to main' }))
    await waitFor(() => { expect(bench.gitPush).toHaveBeenCalledTimes(1) })
    act(() => { sessions.set(sessionList('/b')) })
    expect(await screen.findByText('release')).toBeTruthy()
    await act(async () => { held.resolve({ ok: true, status: 'pushed', branch: 'main' }); await held.promise })
    await waitFor(() => { expect(screen.getByRole('status', { name: 'Pushed to main' })).toBeTruthy() })
    expect(screen.getByText('release')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Commit' }).disabled).toBe(true)
    expect(bench.gitPush).toHaveBeenCalledWith('/a', expect.any(Number))
  })

  it('closes a pending default-branch confirmation when the workspace changes', async () => {
    const { sessions, useSessions } = changingSessions()
    const read = vi.fn(async (cwd: string) => status({ refName: cwd === '/a' ? 'main' : 'release', isDefaultRef: true, aheadCount: 2 }))
    const bench = mount({ useSessions, gitStatus: read, gitFetchForStatus: read })
    fireEvent.click(await screen.findByRole('button', { name: 'Push' }))
    expect(await screen.findByRole('dialog', { name: 'Push to default ref?' })).toBeTruthy()
    act(() => { sessions.set(sessionList('/b')) })
    expect(await screen.findByText('release')).toBeTruthy()
    expect(screen.queryByRole('dialog', { name: 'Push to default ref?' })).toBeNull()
    expect(bench.gitPush).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Push' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Push to release' }))
    await waitFor(() => { expect(bench.gitPush).toHaveBeenCalledWith('/b', expect.any(Number)) })
  })
})

it('does not publish an old workspace follow-up action after navigation', async () => {
  const sessions = createSnapshotStore(sessionList('/a'))
  const held = Promise.withResolvers<{ ok: true; status: 'pushed'; branch: string }>()
  const a = status({ refName: 'feature/old', aheadCount: 2 })
  const b = status({ refName: 'main', isDefaultRef: true })
  const read = vi.fn(async (cwd: string) => cwd === '/a' ? a : b)
  const bench = mount({
    // oxlint-disable-next-line typescript/unbound-method -- snapshot store methods do not read this
    useSessions: selector => useSyncExternalStore(sessions.subscribe, () => selector(sessions.getSnapshot())),
    gitStatus: read, gitFetchForStatus: read, gitPush: vi.fn(() => held.promise),
  })
  fireEvent.click(await screen.findByRole('button', { name: 'Git actions' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Push' }))
  await waitFor(() => { expect(bench.gitPush).toHaveBeenCalledTimes(1) })
  act(() => { sessions.set(sessionList('/b')) })
  expect(await screen.findByText('main')).toBeTruthy()
  await act(async () => { held.resolve({ ok: true, status: 'pushed', branch: 'feature/old' }); await held.promise })
  expect(await screen.findByRole('status', { name: 'Pushed to feature/old' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Create PR' })).toBeNull()
  expect(bench.gitCreateChangeRequest).not.toHaveBeenCalled()
})

describe('Git auxiliary transport rejection', () => {
  it.each([
    { kind: 'init', mode: 'sync' }, { kind: 'init', mode: 'async' },
    { kind: 'pull', mode: 'sync' }, { kind: 'pull', mode: 'async' },
    { kind: 'publish', mode: 'sync' }, { kind: 'publish', mode: 'async' },
  ] as const)('reports a $mode rejected $kind and releases busy state', async ({ kind, mode }) => {
    const reject = vi.fn(() => {
      const error = new Error(`fixture ${kind} unavailable`)
      if (mode === 'async') return Promise.reject(error)
      throw error
    })
    const options = kind === 'init'
      ? { git: status({ isRepo: false }), gitInit: reject }
      : kind === 'pull'
        ? { git: status({ behindCount: 1 }), gitPull: reject }
        : { git: status({ hasPrimaryRemote: false, hasUpstream: false }), gitPublishRepository: reject }
    mount({ cwd: '/work', ...options })
    const label = kind === 'init' ? 'Initialize Git' : kind === 'pull' ? 'Pull' : 'Publish repository'
    fireEvent.click(await screen.findByRole('button', { name: label }))
    if (kind === 'publish') fireEvent.click(await screen.findByRole('button', { name: 'Publish' }))
    expect(await screen.findByRole('status', { name: 'Action failed' })).toBeTruthy()
    expect(screen.getByText(`fixture ${kind} unavailable`)).toBeTruthy()
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: label, hidden: true }).disabled).toBe(false) })
    expect(reject).toHaveBeenCalledTimes(1)
    if (kind === 'publish') expect(screen.getByRole('dialog', { name: 'Publish repository' })).toBeTruthy()
  })

  it('reports a rejected file-open request without leaving an unhandled promise', async () => {
    mount({
      cwd: '/work',
      git: status({ hasWorkingTreeChanges: true, workingTree: filesTree([{ path: 'only.ts', insertions: 1, deletions: 0 }]) }),
      openWorkspacePath: vi.fn(async () => { throw new Error('fixture opener unavailable') }),
    })
    fireEvent.click(await screen.findByRole('button', { name: 'Git actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Commit' }))
    fireEvent.click(await screen.findByRole('button', { name: 'only.ts' }))
    expect(await screen.findByRole('status', { name: 'Unable to open file' })).toBeTruthy()
    expect(screen.getByText('fixture opener unavailable')).toBeTruthy()
  })
})


it.each(['false', 'sync', 'async'] as const)('reports external link opener failure %s', async (kind) => {
  const openExternal = vi.fn(() => {
    if (kind === 'false') return Promise.resolve(false)
    const error = new Error('fixture external opener failed')
    if (kind === 'async') return Promise.reject(error)
    throw error
  })
  mount({
    cwd: '/work', openExternal,
    git: status({ pr: { number: 1, title: 'fixture', url: 'https://example.test/pr/1', baseRef: 'main', headRef: 'feature/test', state: 'open' } }),
  })
  fireEvent.click(await screen.findByRole('button', { name: 'View PR' }))
  expect(await screen.findByRole('status', { name: 'Action failed' })).toBeTruthy()
  expect(screen.getByText(kind === 'false' ? 'Unable to open link.' : 'fixture external opener failed')).toBeTruthy()
  expect(openExternal).toHaveBeenCalledWith('https://example.test/pr/1')
})


it.each(['file', 'link'] as const)('ignores late %s opener errors after workspace navigation', async (kind) => {
  const sessions = createSnapshotStore(sessionList('/a'))
  const held = Promise.withResolvers<never>()
  const opener = vi.fn(() => held.promise)
  const a = kind === 'file'
    ? status({ refName: 'old', hasWorkingTreeChanges: true, workingTree: filesTree([{ path: 'only.ts', insertions: 1, deletions: 0 }]) })
    : status({ refName: 'old', pr: { number: 1, title: 'fixture', url: 'https://example.test/pr/1', baseRef: 'main', headRef: 'old', state: 'open' } })
  const read = vi.fn(async (cwd: string) => cwd === '/a' ? a : status({ refName: 'new', isDefaultRef: true }))
  mount({
    // oxlint-disable-next-line typescript/unbound-method -- snapshot store methods do not read this
    useSessions: selector => useSyncExternalStore(sessions.subscribe, () => selector(sessions.getSnapshot())),
    gitStatus: read, gitFetchForStatus: read,
    gitReadPullRequest: vi.fn(async (cwd: string) => ({ ok: true, pr: cwd === '/a' ? a.pr : null })),
    ...(kind === 'file' ? { openWorkspacePath: opener } : { openExternal: opener }),
  })
  if (kind === 'file') {
    fireEvent.click(await screen.findByRole('button', { name: 'Git actions' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Commit' }))
    fireEvent.click(await screen.findByRole('button', { name: 'only.ts' }))
  } else fireEvent.click(await screen.findByRole('button', { name: 'View PR' }))
  expect(opener).toHaveBeenCalledTimes(1)
  act(() => { sessions.set(sessionList('/b')) })
  expect(await screen.findByText('new')).toBeTruthy()
  await act(async () => { held.reject(new Error('fixture late opener failure')); await Promise.resolve() })
  expect(screen.queryByText('fixture late opener failure')).toBeNull()
  expect(screen.getByText('new')).toBeTruthy()
})

it.each([true, false])('publishes normalized draft fields and exposes only an available repository link: %s', async (withUrl) => {
  const url = 'https://example.test/team/project'
  const publish = vi.fn(async () => ({ ok: true, ...(withUrl ? { url } : {}) }))
  const b = mount({ cwd: '/work', git: status({ hasPrimaryRemote: false, hasUpstream: false }), gitPublishRepository: publish })
  fireEvent.click(await screen.findByRole('button', { name: 'Publish repository' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Repository name' }), { target: { value: '  project  ' } })
  fireEvent.change(screen.getByRole('textbox', { name: 'Remote URL (optional)' }), { target: { value: '  https://example.test/team/project.git  ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Public' }))
  fireEvent.click(screen.getByRole('button', { name: 'Publish' }))
  expect(await screen.findByRole('status', { name: 'Publish repository' })).toBeTruthy()
  expect(publish).toHaveBeenCalledWith('/work', {
    name: 'project', visibility: 'public', remoteUrl: 'https://example.test/team/project.git',
  }, expect.any(Number))
  expect(screen.queryByRole('dialog', { name: 'Publish repository' })).toBeNull()
  if (withUrl) {
    fireEvent.click(screen.getByRole('button', { name: 'Open repository' }))
    await waitFor(() => { expect(b.openExternal).toHaveBeenCalledWith(url) })
  } else expect(screen.queryByRole('button', { name: 'Open repository' })).toBeNull()
})

describe('Git branch intent binding', () => {
  it('stops before mutation if preflight discovers a different branch', async () => {
    let current = status({ refName: 'feature/old', aheadCount: 2 })
    let changeOnNextFetch = false
    const read = vi.fn(async () => current)
    const fetchStatus = vi.fn(async () => {
      if (changeOnNextFetch) {
        changeOnNextFetch = false
        current = status({ refName: 'main', isDefaultRef: true, aheadCount: 2 })
      }
      return current
    })
    const b = mount({ cwd: '/work', gitStatus: read, gitFetchForStatus: fetchStatus })
    await waitFor(() => { expect(fetchStatus).toHaveBeenCalledTimes(1) })
    fireEvent.click(await screen.findByRole('button', { name: 'Git actions' }))
    await waitFor(() => { expect(fetchStatus).toHaveBeenCalledTimes(2) })
    changeOnNextFetch = true
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Push' }))
    expect(await screen.findByRole('status', { name: 'Action failed' })).toBeTruthy()
    expect(screen.getByText('Branch changed while preparing the action. Review the current branch and try again.')).toBeTruthy()
    expect(b.gitPush).not.toHaveBeenCalled()
    expect(screen.getByText('main')).toBeTruthy()
  })

  it('does not reinterpret confirmation for one branch as confirmation for another', async () => {
    let current = status({ refName: 'main', isDefaultRef: true, aheadCount: 2 })
    const read = vi.fn(async () => current)
    const b = mount({ cwd: '/work', gitStatus: read, gitFetchForStatus: read })
    fireEvent.click(await screen.findByRole('button', { name: 'Push' }))
    expect(await screen.findByRole('button', { name: 'Push to main' })).toBeTruthy()
    current = status({ refName: 'release', isDefaultRef: true, aheadCount: 2 })
    fireEvent(window, new Event('focus'))
    expect(await screen.findByText('release')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Push to main' }))
    expect(await screen.findByRole('status', { name: 'Action failed' })).toBeTruthy()
    expect(b.gitPush).not.toHaveBeenCalled()
  })
})
