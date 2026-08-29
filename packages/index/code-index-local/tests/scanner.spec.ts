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
    expect(DEFAULT_INCLUDE_PATTERNS.length).toBe(31)
  })

  it('admits every JavaScript and TypeScript module extension classified by the parser', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-scan-js-modules-'))
    roots.push(root)
    await Promise.all([
      writeFile(join(root, 'module.mjs'), 'export const esm = 1\n'),
      writeFile(join(root, 'module.cjs'), 'exports.cjs = 1\n'),
      writeFile(join(root, 'module.mts'), 'export const esm: number = 1\n'),
      writeFile(join(root, 'module.cts'), 'exports.cts = 1\n'),
    ])
    const scan = await collectWorkspaceEntries(root, DEFAULT_INCLUDE_PATTERNS, [])
    expect(scan.entries.map(entry => entry.path)).toEqual([
      'module.cjs',
      'module.cts',
      'module.mjs',
      'module.mts',
    ])
  })

  it('applies repository-local excludes below root gitignore rules', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-scan-git-info-'))
    roots.push(root)
    await mkdir(join(root, '.git', 'info'), { recursive: true })
    await mkdir(join(root, 'private-reference'))
    await Promise.all([
      writeFile(join(root, '.git', 'info', 'exclude'), '/private-reference/\n*.private.ts\n'),
      writeFile(join(root, '.gitignore'), '!keep.private.ts\n'),
      writeFile(join(root, 'private-reference', 'hidden.ts'), 'hidden\n'),
      writeFile(join(root, 'drop.private.ts'), 'drop\n'),
      writeFile(join(root, 'keep.private.ts'), 'keep\n'),
    ])
    const scan = await collectWorkspaceEntries(root, DEFAULT_INCLUDE_PATTERNS, [])
    expect(scan.entries.map(entry => entry.path)).toEqual(['keep.private.ts'])
  })

  it('loads nested gitignore documents, honors child negation, and prunes a scoped walk', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-scan-nested-'))
    roots.push(root)
    await writeFile(join(root, '.gitignore'), '*.generated.ts\n')
    await writeFile(join(root, 'root.generated.ts'), 'ignored\n')
    await mkdir(join(root, 'src/private'), { recursive: true })
    await writeFile(join(root, 'src/.gitignore'), '!keep.generated.ts\nprivate/\n')
    await writeFile(join(root, 'src/keep.generated.ts'), 'kept\n')
    await writeFile(join(root, 'src/drop.generated.ts'), 'ignored\n')
    await writeFile(join(root, 'src/other.ts'), 'outside scope\n')
    await writeFile(join(root, 'src/private/secret.ts'), 'ignored\n')

    const full = await collectWorkspaceEntries(root, ['**/*.ts'], [])
    expect(full.entries.map(entry => entry.path)).toEqual(['src/keep.generated.ts', 'src/other.ts'])

    const scoped = await collectWorkspaceEntries(root, ['**/*.ts'], [], { paths: ['src/keep.generated.ts'] })
    expect(scoped.entries.map(entry => entry.path)).toEqual(['src/keep.generated.ts'])
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
