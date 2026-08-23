import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import LocalSubprocessRuntime from '@relay-harness/rlh-subprocess-local'
import { TrackerIssueId, type TrackerIssue } from '@relay-harness/rlh-tracker'
import LocalIssueWorkspaceProvisioner, { issueWorkspaceKey } from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function issue(identifier = 'ENG/42'): TrackerIssue {
  return {
    id: TrackerIssueId('issue-42'),
    identifier,
    title: 'Provision a safe workspace',
    state: 'Todo',
    labels: [],
    blockedBy: [],
    dispatchable: true,
  }
}

async function boot(config: ConstructorParameters<typeof LocalIssueWorkspaceProvisioner>[1]) {
  const ctx = new Context()
  const subprocess = ctx.plugin(LocalSubprocessRuntime)
  await subprocess
  const provisioner = ctx.plugin(LocalIssueWorkspaceProvisioner, config)
  await provisioner
  return { ctx, subprocess, provisioner }
}

describe('issueWorkspaceKey', () => {
  it('preserves safe identifiers and disambiguates sanitized values', () => {
    expect(issueWorkspaceKey('ENG-42')).toBe('ENG-42')
    expect(issueWorkspaceKey('ENG/42')).toMatch(/^ENG_42--[0-9a-f]{16}$/)
    expect(issueWorkspaceKey('ENG/42')).not.toBe(issueWorkspaceKey('ENG:42'))
    expect(issueWorkspaceKey('')).toMatch(/^issue--[0-9a-f]{16}$/)
  })
})

describe('LocalIssueWorkspaceProvisioner', () => {
  it('runs one-time setup, reuses the directory, and runs per-attempt hooks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-issue-workspace-'))
    roots.push(root)
    const { ctx, subprocess } = await boot({
      root,
      afterCreate: 'printf setup > setup.txt',
      beforeRun: 'printf "$RLH_ISSUE_IDENTIFIER" > before.txt',
      afterRun: 'printf after > after.txt',
      beforeRemove: 'printf remove > ../removed.txt',
    })
    const target = issue()
    const first = await ctx.issueWorkspace.prepare(target)
    expect(first.created).toBe(true)
    expect(await readFile(join(first.path, 'setup.txt'), 'utf8')).toBe('setup')
    await ctx.issueWorkspace.beforeRun(first, target)
    expect(await readFile(join(first.path, 'before.txt'), 'utf8')).toBe('ENG/42')
    await ctx.issueWorkspace.afterRun(first, target)
    expect(await readFile(join(first.path, 'after.txt'), 'utf8')).toBe('after')

    const second = await ctx.issueWorkspace.prepare(target)
    expect(second.created).toBe(false)
    await ctx.issueWorkspace.remove(second, target)
    expect(await readFile(join(root, 'removed.txt'), 'utf8')).toBe('remove')
    await subprocess.dispose()
  })

  it('removes a new partial workspace when after-create fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-issue-workspace-'))
    roots.push(root)
    const { ctx, subprocess } = await boot({ root, afterCreate: 'exit 7' })
    await expect(ctx.issueWorkspace.prepare(issue('ENG-7'))).rejects.toThrow(/exit 7/)
    const { access } = await import('node:fs/promises')
    await expect(access(join(root, 'ENG-7'))).rejects.toMatchObject({ code: 'ENOENT' })
    await subprocess.dispose()
  })

  it('rejects an existing symlink that escapes the configured root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-issue-workspace-'))
    const outside = await mkdtemp(join(tmpdir(), 'rlh-issue-outside-'))
    roots.push(root, outside)
    await writeFile(join(outside, 'sentinel'), 'keep')
    await symlink(outside, join(root, 'ENG-9'))
    const { ctx, subprocess } = await boot({ root })
    await expect(ctx.issueWorkspace.prepare(issue('ENG-9'))).rejects.toThrow(/escapes root|plain directory/)
    expect(await readFile(join(outside, 'sentinel'), 'utf8')).toBe('keep')
    await subprocess.dispose()
  })

  it('locates without creation and rejects relative roots and destructive paths outside root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-issue-workspace-'))
    roots.push(root)
    const ctx = new Context()
    expect(() => new LocalIssueWorkspaceProvisioner(ctx, { root: 'relative' })).toThrow(/absolute/)
    const defaultsCtx = new Context()
    expect(new LocalIssueWorkspaceProvisioner(defaultsCtx, { root })).toBeDefined()
    await defaultsCtx.fiber.dispose()
    const { ctx: mounted, subprocess } = await boot({
      root, hookTimeoutMs: 1000, processGraceMs: 50, maxOutputBytes: 1024,
    })
    const located = await mounted.issueWorkspace.locate(issue('ENG-LOCATE'))
    const { access } = await import('node:fs/promises')
    await expect(access(located.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await mounted.issueWorkspace.beforeRun(located, issue('ENG-LOCATE'))
    await expect(mounted.issueWorkspace.remove({ ...located, path: outsidePath(root) }, issue('ENG-LOCATE')))
      .rejects.toThrow(/outside root/)
    await subprocess.dispose()
  })

  it('propagates root creation failures other than an existing non-directory', async () => {
    const ctx = new Context()
    const provisioner = new LocalIssueWorkspaceProvisioner(ctx, { root: '/\0invalid-root' })
    await expect(provisioner.locate(issue('ENG-INVALID'))).rejects.toThrow()
    await ctx.fiber.dispose()
  })

  it('rejects a root resolving to a file and an existing non-directory issue path', async () => {
    const base = await mkdtemp(join(tmpdir(), 'rlh-issue-workspace-'))
    roots.push(base)
    const file = join(base, 'root-file')
    const link = join(base, 'root-link')
    await writeFile(file, 'file')
    await symlink(file, link)
    const first = await boot({ root: link })
    await expect(first.ctx.issueWorkspace.locate(issue('ENG-FILE'))).rejects.toThrow(/not a directory/)
    await first.subprocess.dispose()

    const root = join(base, 'real-root')
    await mkdir(root)
    await writeFile(join(root, 'ENG-FILE'), 'file')
    const second = await boot({ root })
    await expect(second.ctx.issueWorkspace.prepare(issue('ENG-FILE'))).rejects.toThrow(/plain directory/)
    await second.subprocess.dispose()
  })

  it('contains best-effort hook failures and times out a blocking hook', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-issue-workspace-'))
    roots.push(root)
    const { ctx, subprocess } = await boot({
      root,
      afterRun: 'printf after-error >&2; exit 2',
      beforeRemove: 'printf remove-error >&2; exit 3',
      beforeRun: 'printf before',
      hookTimeoutMs: 1000,
    })
    const target = issue('ENG-HOOKS')
    const workspace = await ctx.issueWorkspace.prepare(target)
    await ctx.issueWorkspace.beforeRun(workspace, target, new AbortController().signal)
    await expect(ctx.issueWorkspace.afterRun(workspace, target)).resolves.toBeUndefined()
    await expect(ctx.issueWorkspace.remove(workspace, target)).resolves.toBeUndefined()
    await subprocess.dispose()

    const timed = await boot({ root, beforeRun: 'sleep 1', hookTimeoutMs: 10, processGraceMs: 10 })
    const timedWorkspace = await timed.ctx.issueWorkspace.prepare(issue('ENG-TIMEOUT'))
    await expect(timed.ctx.issueWorkspace.beforeRun(timedWorkspace, issue('ENG-TIMEOUT'))).rejects.toThrow(/timed out/)
    await timed.subprocess.dispose()
  })
})

function outsidePath(root: string): string {
  return join(root, '..', 'outside-workspace')
}
