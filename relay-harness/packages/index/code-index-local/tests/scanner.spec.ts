/** Scanner walk: three-layer exclusion pruning, includes, batching, symlink counting. */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_HARD_EXCLUDES,
  DEFAULT_INCLUDE_PATTERNS,
  collectWorkspaceEntries,
  walkWorkspace,
} from '../src/scanner.ts'
import { exclusionFilterFromPatterns, loadWorkspaceGitIgnore } from '../src/gitignore.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function makeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rlh-scan-'))
  roots.push(root)
  await writeFile(join(root, 'app.ts'), 'export const a = 1\n')
  await writeFile(join(root, 'README.md'), '# doc\n')
  await mkdir(join(root, 'target/release'), { recursive: true })
  // Hard-exclude bait carrying an include-matching extension proves physical pruning.
  await writeFile(join(root, 'target/release/app.ts'), '')
  await mkdir(join(root, 'hidden'), { recursive: true })
  // Gitignore bait likewise (.rb is an included language).
  await writeFile(join(root, 'hidden/extra.rb'), '')
  await writeFile(join(root, '.gitignore'), 'hidden/\n')
  await mkdir(join(root, 'src/nested'), { recursive: true })
  await writeFile(join(root, 'src/deep.ts'), 'export const b = 2\n')
  await writeFile(join(root, 'src/nested/inner.py'), 'x = 1\n')
  await symlink(join(root, 'src'), join(root, 'src-link'))
  await symlink(join(root, 'app.ts'), join(root, 'alias-file.ts'))
  await symlink(join(root, 'no-such-target'), join(root, 'broken'))
  return root
}

describe('collectWorkspaceEntries', () => {
  it('walks breadth-first, prunes excluded directories before descending, and counts dir symlinks', async () => {
    const root = await makeFixture()
    const configLayer = exclusionFilterFromPatterns(['**/*.md'])

    const scan = await collectWorkspaceEntries(
      root,
      DEFAULT_INCLUDE_PATTERNS,
      [
        exclusionFilterFromPatterns(DEFAULT_HARD_EXCLUDES),
        (await loadWorkspaceGitIgnore(root)) ?? exclusionFilterFromPatterns([]),
        configLayer,
      ],
    )

    expect(scan.entries.map(entry => entry.path)).toEqual([
      'app.ts',
      'src/deep.ts',
      'src/nested/inner.py',
    ])
    expect(scan.directorySymlinksSkipped).toBe(1)
    const firstEntry = scan.entries[0]
    expect(firstEntry?.size).toBeGreaterThan(0)
    expect(firstEntry?.mtimeMs).toBeGreaterThan(0)
  })

  it('yields one batch per contributing directory through the generator', async () => {
    const root = await makeFixture()
    const batches: string[][] = []
    for await (const batch of walkWorkspace(root, ['**/*.ts'], [])) {
      batches.push(batch.map(entry => entry.path))
    }
    // With no filters the bait directories are traversed too; each contributing
    // directory produces exactly one batch in breadth-first queue order.
    expect(batches).toEqual([
      ['app.ts'],
      ['src/deep.ts'],
      ['target/release/app.ts'],
    ])
    expect(DEFAULT_HARD_EXCLUDES.length).toBe(15)
    expect(DEFAULT_INCLUDE_PATTERNS.length).toBe(27)
  })
})

describe('non-regular children', () => {
  it('skips sockets without treating them as files or directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-scan-sock-'))
    roots.push(root)
    await writeFile(join(root, 'keep.py'), 'y = 2\n')
    const socketPath = join(root, 'daemon.sock')
    const server = net.createServer(() => {})
    await new Promise<void>(resolvePromise => server.listen(socketPath, resolvePromise))
    try {
      const scan = await collectWorkspaceEntries(root, ['**/*.py'], [])
      expect(scan.entries.map(entry => entry.path)).toEqual(['keep.py'])
    } finally {
      await new Promise<void>((resolvePromise) => {
        server.close(() => {
          resolvePromise()
        })
      })
    }
  })
})
