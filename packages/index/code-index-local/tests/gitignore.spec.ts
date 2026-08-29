/** Rule matrix for the minimal gitignore evaluator the scanner stacks. */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {

  exclusionFilterFromPatterns,
  inclusionMatcherFromPatterns,
  loadWorkspaceGitIgnore,
  parseGitignoreRules,
} from '../src/gitignore.ts'

const scratchDirs: string[] = []

afterEach(async () => {
  for (const dir of scratchDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('parseGitignoreRules', () => {
  it('drops blank lines and comments and keeps rule order', () => {
    const rules = parseGitignoreRules([
      '# header comment',
      '',
      '   ',
      'build',
      '  # indented comment',
    ].join('\n'))
    expect(rules.map(rule => rule.pattern)).toEqual(['build'])
  })

  it('reads modifiers off each pattern line', () => {
    const rules = parseGitignoreRules([
      '!keep.log',
      'logs/',
      '/rooted-dir',
      'plain',
      '\\#literal-hash',
    ].join('\n'))
    expect(rules[0]).toMatchObject({ negated: true, directoryOnly: false, anchored: false, pattern: 'keep.log' })
    expect(rules[1]).toMatchObject({ negated: false, directoryOnly: true, anchored: false, pattern: 'logs' })
    expect(rules[2]).toMatchObject({ negated: false, directoryOnly: false, anchored: true, pattern: '/rooted-dir' })
    expect(rules[3]).toMatchObject({ anchored: false })
    expect(rules[4]).toMatchObject({ pattern: '#literal-hash' })
  })

  it('ignores a line that is only an escaped marker or bare slash', () => {
    expect(parseGitignoreRules('\\!\n/\n')).toEqual([])
  })
})

describe('exclusion filter semantics', () => {
  it('matches plain components at any depth and implies pruning below them', () => {
    const filter = exclusionFilterFromPatterns(['logs'])
    expect(filter.excludes('logs', true)).toBe(true)
    expect(filter.excludes('a/logs/cache.bin', false)).toBe(true)
    expect(filter.excludes('catalogs/list.md', false)).toBe(false)
  })

  it('bounds wildcards to one segment', () => {
    const filter = exclusionFilterFromPatterns(['temp*'])
    expect(filter.excludes('temp123.txt', false)).toBe(true)
    expect(filter.excludes('deep/temp/x.md', false)).toBe(true)
    // Component-wide matching is genuine gitignore semantics for wildcards.
    expect(filter.excludes('x/tempo/y.log', false)).toBe(true)
  })

  it('anchors patterns containing slashes to the root and honors ? metachars', () => {
    const filter = exclusionFilterFromPatterns(['/dist', 'gen?.ts'])
    expect(filter.excludes('dist/out.js', false)).toBe(true)
    expect(filter.excludes('packages/dist/out.js', false)).toBe(false)
    expect(filter.excludes('src/gen1.ts', false)).toBe(true)
    expect(filter.excludes('src/gen12.ts', false)).toBe(false)
  })

  it('applies directory-only rules through ancestors of files but not file basenames', () => {
    const filter = exclusionFilterFromPatterns(['build/'])
    expect(filter.excludes('build', true)).toBe(true)
    expect(filter.excludes('nested/build', true)).toBe(true)
    expect(filter.excludes('build/index.js', false)).toBe(true)
    expect(filter.excludes('tools/build', false)).toBe(false)
  })

  it('interior globstars span zero or more segments; trailing ones collapse', () => {
    const filter = exclusionFilterFromPatterns(['**/.git/**'])
    expect(filter.excludes('.git', true)).toBe(true)
    expect(filter.excludes('a/b/.git/config', false)).toBe(true)
    expect(filter.excludes('.git/modules/sub/config', false)).toBe(true)
    expect(filter.excludes('digitgit/file.md', false)).toBe(false)

    const wide = exclusionFilterFromPatterns(['archive/**'])
    expect(wide.excludes('archive/2024/a.log', false)).toBe(true)
    expect(wide.excludes('archives/2024/a.log', false)).toBe(false)
  })

  it('expands anchored interior globstars across zero or more middle segments', () => {
    const filter = exclusionFilterFromPatterns(['a/**/keep.zx'])
    expect(filter.excludes('a/keep.zx', false)).toBe(true)
    expect(filter.excludes('a/mid/deep/keep.zx', false)).toBe(true)
    expect(filter.excludes('b/a/keep.zx', false)).toBe(false)
  })

  it('lets a later negation resurrect a previously excluded path', () => {
    const filter = exclusionFilterFromPatterns(['*.log\n!important.log'])
    expect(filter.excludes('noise.log', false)).toBe(true)
    expect(filter.excludes('important.log', false)).toBe(false)
    // Re-exclusion flips again when an even later rule matches.
    const flipped = exclusionFilterFromPatterns(['*.log\n!important.log\ndeep/*.log'])
    expect(flipped.excludes('deep/important.log', false)).toBe(true)
  })

  it('directory-only rules with interior globs match nested dirs via any-depth prefix', () => {
    const filter = exclusionFilterFromPatterns(['packages/*/fixtures/'])
    expect(filter.excludes('packages/app/fixtures/data.json', false)).toBe(true)
    expect(filter.excludes('packages/app/fixtures', true)).toBe(true)
    expect(filter.excludes('packages/fixtures', false)).toBe(false)
  })
})

describe('loadWorkspaceGitIgnore', () => {
  it('reports a non-ENOENT read failure loud instead of treating it as absence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-gi-'))
    scratchDirs.push(root)
    await mkdir(join(root, '.gitignore'))
    // A directory squatting on the .gitignore name yields EISDIR.
    await expect(loadWorkspaceGitIgnore(root)).rejects.toThrow()
  })
})

describe('inclusion matcher', () => {
  it('accepts files matching any include glob at any depth', () => {
    const include = inclusionMatcherFromPatterns(['**/*.py', '**/Dockerfile', '**/*.md'])
    expect(include.matches('main.py')).toBe(true)
    expect(include.matches('src/nested/mod.py')).toBe(true)
    expect(include.matches(['docs', 'readme.md'].join('/'))).toBe(true)
    expect(include.matches('Dockerfile')).toBe(true)
    expect(include.matches('notes.txt')).toBe(false)
    expect(include.matches('dir/Dockerfile2')).toBe(false)
  })
})
