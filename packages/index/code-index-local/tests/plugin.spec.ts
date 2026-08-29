/**
 * Plugin class: config fail-loud rules, service lifecycle, invalidation wiring, default path math.
 *
 * `node:fs.watch` is replaced for the whole file so the enabled-watcher test
 * can deterministically exercise the platform-refusal degradation path; every
 * other `node:fs` binding passes through untouched, and no other test in this
 * file enables the watcher.
 */

import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@relay-harness/cordis'
import CodeIndexLocal, { defaultDatabasePath } from '../src/index.ts'
import { makeWorkspace, sweepWorkspaces } from './support.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    watch: () => {
      throw new Error('ENOSYS: watch unavailable on this platform')
    },
  }
})

const contexts: Context[] = []
const extraDirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of extraDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  await sweepWorkspaces()
})

describe('defaultDatabasePath', () => {
  it('derives a workspace-suffixed file under the harness home', () => {
    const path = defaultDatabasePath('/tmp/work-a', '/home/.rlh')
    expect(path).toMatch(/^\/home\/\.rlh\/index\/code-index-[0-9a-f]{12}\.sqlite3$/u)
    // A different workspace maps to a different derived file.
    expect(defaultDatabasePath('/tmp/work-b', '/home/.rlh')).not.toBe(path)
  })
})

describe('configuration resolution', () => {
  it('rejects a missing or non-directory workspace root at construction', async () => {
    const root = await makeWorkspace('rlh-plug-cfg-', { files: {} })
    // Each attempt owns a fresh context: one registration claim per instance.
    expect(() => new CodeIndexLocal(new Context(), { workspaceRoot: join(root, 'absent') })).toThrow('must be an existing directory')
    await writeFile(join(root, '.placeholder'), '')
    expect(() => new CodeIndexLocal(new Context(), { workspaceRoot: join(root, '.placeholder') })).toThrow('existing directory')
  })

  it('rejects bad numeric knobs and blank exclude entries', async () => {
    const root = await makeWorkspace('rlh-plug-num-', { files: {} })
    expect(() => new CodeIndexLocal(new Context(), { workspaceRoot: root, maxFileBytes: 0 })).toThrow('maxFileBytes')
    expect(() => new CodeIndexLocal(new Context(), { workspaceRoot: root, debounceMs: 0 })).toThrow('debounceMs')
    expect(() => new CodeIndexLocal(new Context(), { workspaceRoot: root, dirtyPropagationMaxFiles: 0 }))
      .toThrow('dirtyPropagationMaxFiles')
    expect(() => new CodeIndexLocal(new Context(), { workspaceRoot: root, exclude: ['ok', '   '] })).toThrow('exclude')
  })

  it('rejects an explicitly empty database path', async () => {
    const root = await makeWorkspace('rlh-plug-emptypath-', { files: {} })
    expect(() => new CodeIndexLocal(new Context(), { workspaceRoot: root, databasePath: '' })).toThrow('databasePath must not be empty')
  })

})
