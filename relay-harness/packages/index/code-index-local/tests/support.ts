/** Shared fixtures: disposable workspaces and open derived stores. */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/** Every created root; disposed after each suite's afterEach sweep. */
const trackedRoots: string[] = []

export interface WorkspaceSpec {
  /** Relative path → UTF-8 contents; directories are created as needed. */
  readonly files: Readonly<Record<string, string>>
  /** Raw `.gitignore` text placed at the workspace root, when given. */
  readonly gitignore?: string
}

/**
 * Materialize one disposable fixture workspace.
 * @param prefix - mkdtemp name prefix.
 * @param spec - files (and optional root `.gitignore`) to create before returning.
 */
export async function makeWorkspace(prefix: string, spec: WorkspaceSpec): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  trackedRoots.push(root)
  for (const [relPath, contents] of Object.entries(spec.files)) {
    const absolute = join(root, relPath)
    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, contents)
  }
  if (spec.gitignore !== undefined) await writeFile(join(root, '.gitignore'), spec.gitignore)
  return root
}

/** Remove every tracked fixture root (call from afterEach). */
export async function sweepWorkspaces(): Promise<void> {
  for (const root of trackedRoots.splice(0)) await rm(root, { recursive: true, force: true })
}

/**
 * Open one admitted in-memory store pre-shaped by the shared sqlite package,
 * matching what the runtime uses in production.
 */
