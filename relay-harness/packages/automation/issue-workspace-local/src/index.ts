/**
 * Local filesystem/subprocess provider for deterministic per-issue workspaces.
 * @module @deepseek-ai/dsh-issue-workspace-local
 */

import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { IssueWorkspaceProvisioner, type IssueWorkspace } from '@deepseek-ai/dsh-issue-workspace'
import type { TrackerIssue } from '@deepseek-ai/dsh-tracker'
import type {} from '@deepseek-ai/dsh-subprocess'

/** Lifecycle scripts run in the workspace through the managed subprocess seam. */
export interface Config {
  /** Absolute parent directory containing every issue workspace. */
  readonly root: string
  /** Shell script run once after a new directory is created. */
  readonly afterCreate?: string
  /** Attempt-blocking shell script run immediately before the Agent starts. */
  readonly beforeRun?: string
  /** Best-effort shell script run after every published attempt settles. */
  readonly afterRun?: string
  /** Best-effort shell script run before terminal directory removal. */
  readonly beforeRemove?: string
  /** Silence deadline for each hook process in milliseconds. */
  readonly hookTimeoutMs?: number
  /** TERM-to-KILL process-tree cleanup grace in milliseconds. */
  readonly processGraceMs?: number
  /** Per-stream in-memory diagnostic cap in bytes. */
  readonly maxOutputBytes?: number
}

export const Config: z<Config> = z.object({
  root: z.string(),
  afterCreate: z.string(),
  beforeRun: z.string(),
  afterRun: z.string(),
  beforeRemove: z.string(),
  hookTimeoutMs: z.natural().min(1).default(60_000),
  processGraceMs: z.natural().min(1).default(3_000),
  maxOutputBytes: z.natural().min(1).default(64 * 1024),
})

type ResolvedConfig = Required<Pick<Config, 'root' | 'hookTimeoutMs' | 'processGraceMs' | 'maxOutputBytes'>> & Config

/**
 * Stable collision-resistant directory key for a human tracker identifier.
 * @param identifier Provider-owned human issue identifier.
 * @returns A filesystem-safe deterministic key.
 */
export function issueWorkspaceKey(identifier: string): string {
  const safe = identifier.replace(/[^A-Za-z0-9._-]/g, '_') || 'issue'
  if (safe === identifier) return safe
  const hash = createHash('sha256').update(identifier).digest('hex').slice(0, 16)
  return `${safe}--${hash}`
}

/** Whether `candidate` is a strict descendant of `root`. */
function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path.length > 0 && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(path)
}

/** Local provider that revalidates canonical containment before every destructive operation. */
export class LocalIssueWorkspaceProvisioner extends IssueWorkspaceProvisioner {
  static inject = ['subprocess']
  static Config = Config
  private readonly config: ResolvedConfig
  private rootReady: Promise<string> | undefined

  constructor(ctx: Context, config: Config) {
    super(ctx)
    if (!isAbsolute(config.root)) throw new Error('issue-workspace-local: root must be an absolute path')
    this.config = {
      root: resolve(config.root),
      ...(config.afterCreate === undefined ? {} : { afterCreate: config.afterCreate }),
      ...(config.beforeRun === undefined ? {} : { beforeRun: config.beforeRun }),
      ...(config.afterRun === undefined ? {} : { afterRun: config.afterRun }),
      ...(config.beforeRemove === undefined ? {} : { beforeRemove: config.beforeRemove }),
      hookTimeoutMs: config.hookTimeoutMs ?? 60_000,
      processGraceMs: config.processGraceMs ?? 3_000,
      maxOutputBytes: config.maxOutputBytes ?? 64 * 1024,
    }
  }

  private canonicalRoot(): Promise<string> {
    return (this.rootReady ??= (async () => {
      try {
        await mkdir(this.config.root, { recursive: true })
      } catch (error: unknown) {
        // An existing non-directory can surface as EEXIST before the explicit type diagnosis below.
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      const root = await realpath(this.config.root)
      const stat = await lstat(root)
      if (!stat.isDirectory()) throw new Error('issue-workspace-local: root is not a directory')
      return root
    })())
  }

  private async validatePath(path: string, allowMissing: boolean): Promise<{ root: string; path: string }> {
    const root = await this.canonicalRoot()
    const expanded = resolve(path)
    if (!contained(root, expanded)) throw new Error(`issue workspace ${JSON.stringify(expanded)} is outside root ${JSON.stringify(root)}`)
    try {
      const canonical = await realpath(expanded)
      if (!contained(root, canonical)) {
        throw new Error(`issue workspace ${JSON.stringify(expanded)} escapes root through a symbolic link`)
      }
      return { root, path: canonical }
    } catch (error: unknown) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') return { root, path: expanded }
      throw error
    }
  }

  override async prepare(issue: TrackerIssue, signal?: AbortSignal): Promise<IssueWorkspace> {
    signal?.throwIfAborted()
    const root = await this.canonicalRoot()
    const requested = join(root, issueWorkspaceKey(issue.identifier))
    const validated = await this.validatePath(requested, true)
    let created = false
    try {
      const stat = await lstat(validated.path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(`issue workspace ${JSON.stringify(validated.path)} is not a plain directory`)
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await mkdir(validated.path)
      created = true
    }
    const canonical = await this.validatePath(validated.path, false)
    const workspace: IssueWorkspace = {
      issueId: issue.id,
      path: canonical.path,
      created,
      preparedAt: Date.now(),
    }
    if (!created || this.config.afterCreate === undefined) return workspace
    try {
      await this.runHook('after-create', this.config.afterCreate, workspace, issue, signal)
      return workspace
    } catch (error: unknown) {
      await rm(workspace.path, { recursive: true, force: true })
      throw error
    }
  }

  override async locate(issue: TrackerIssue, signal?: AbortSignal): Promise<IssueWorkspace> {
    signal?.throwIfAborted()
    const root = await this.canonicalRoot()
    const requested = join(root, issueWorkspaceKey(issue.identifier))
    const validated = await this.validatePath(requested, true)
    return { issueId: issue.id, path: validated.path, created: false, preparedAt: Date.now() }
  }

  override beforeRun(workspace: IssueWorkspace, issue: TrackerIssue, signal?: AbortSignal): Promise<void> {
    return this.runOptionalHook('before-run', this.config.beforeRun, workspace, issue, signal)
  }

  override async afterRun(workspace: IssueWorkspace, issue: TrackerIssue): Promise<void> {
    try {
      await this.runOptionalHook('after-run', this.config.afterRun, workspace, issue)
    } catch (error: unknown) {
      this.ctx.logger.warn(`issue workspace after-run hook failed for ${issue.identifier}: ${String(error)}`)
    }
  }

  override async remove(workspace: IssueWorkspace, issue: TrackerIssue): Promise<void> {
    try {
      await this.runOptionalHook('before-remove', this.config.beforeRemove, workspace, issue)
    } catch (error: unknown) {
      this.ctx.logger.warn(`issue workspace before-remove hook failed for ${issue.identifier}: ${String(error)}`)
    }
    const validated = await this.validatePath(workspace.path, true)
    await rm(validated.path, { recursive: true, force: true })
  }

  private runOptionalHook(
    name: string,
    command: string | undefined,
    workspace: IssueWorkspace,
    issue: TrackerIssue,
    signal?: AbortSignal,
  ): Promise<void> {
    return command === undefined ? Promise.resolve() : this.runHook(name, command, workspace, issue, signal)
  }

  private async runHook(
    name: string,
    command: string,
    workspace: IssueWorkspace,
    issue: TrackerIssue,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.validatePath(workspace.path, false)
    signal?.throwIfAborted()
    const shell = await this.ctx.subprocess.resolveExecutable('sh', undefined, signal)
    const timeout = AbortSignal.timeout(this.config.hookTimeoutMs)
    const hookSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    const child = this.ctx.subprocess.spawn({
      argv: [shell, '-lc', command],
      cwd: workspace.path,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: this.config.maxOutputBytes },
        stderr: { maxBytes: this.config.maxOutputBytes },
      },
      graceMs: this.config.processGraceMs,
      signal: hookSignal,
      env: {
        DSH_ISSUE_ID: issue.id,
        DSH_ISSUE_IDENTIFIER: issue.identifier,
        DSH_ISSUE_TITLE: issue.title,
      },
    })
    const outcome = await child.done
    if (timeout.aborted) throw new Error(`issue workspace ${name} hook timed out after ${this.config.hookTimeoutMs} ms`)
    signal?.throwIfAborted()
    if (outcome.exitCode === 0) return
    /* v8 ignore next -- collect-mode stdout is present by the subprocess contract. */
    const stdout = child.collected.stdout?.readFrom(0).text ?? ''
    /* v8 ignore next -- collect-mode stderr is present by the subprocess contract. */
    const stderr = child.collected.stderr?.readFrom(0).text ?? ''
    throw new Error(
      `issue workspace ${name} hook failed with exit ${String(outcome.exitCode)} signal ${String(outcome.signal)}: `
      + `${stdout}${stderr}`.trim(),
    )
  }
}

export default LocalIssueWorkspaceProvisioner
