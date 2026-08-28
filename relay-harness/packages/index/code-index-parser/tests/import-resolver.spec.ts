import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { resolveImport } from '../src/import-resolver.ts'

const root = mkdtempSync(join(tmpdir(), 'rlh-parser-resolver-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function seed(relativePath: string): void {
  const target = join(root, relativePath)
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, '')
}

describe('import resolution', () => {
  it('resolves python dotted modules to a module file, preferring it over the package', () => {
    seed('foo/bar.py')
    expect(resolveImport(root, 'main.py', 'from foo.bar import baz')).toBe('foo/bar.py')
    expect(resolveImport(root, 'main.py', 'import foo.bar')).toBe('foo/bar.py')
    expect(resolveImport(root, 'main.py', 'foo.bar')).toBe('foo/bar.py')
  })

  it('falls back to the python package __init__', () => {
    seed('pkg/__init__.py')
    expect(resolveImport(root, 'main.py', 'from pkg import thing')).toBe('pkg/__init__.py')
  })

  it('returns null for python modules that do not exist', () => {
    expect(resolveImport(root, 'main.py', 'from missing import thing')).toBeNull()
  })

  it('returns null for degenerate python specifiers', () => {
    expect(resolveImport(root, 'main.py', 'from ')).toBeNull()
  })

  it('resolves extensionless js specifiers through the extension order', () => {
    seed('src/utils/helper.ts')
    seed('src/utils/other.tsx')
    expect(resolveImport(root, 'src/main.ts', './utils/helper')).toBe('src/utils/helper.ts')
    expect(resolveImport(root, 'src/main.ts', './utils/other')).toBe('src/utils/other.tsx')
  })

  it('prefers a direct file match over an index module', () => {
    seed('src/thing.js')
    seed('src/thing/index.ts')
    expect(resolveImport(root, 'src/main.ts', './thing')).toBe('src/thing.js')
  })

  it('resolves extensionless directories through their index modules', () => {
    seed('src/dep/index.mjs')
    expect(resolveImport(root, 'src/main.ts', './dep')).toBe('src/dep/index.mjs')
  })

  it('resolves specifiers that already carry an extension exactly', () => {
    seed('src/dep/index.jsx')
    expect(resolveImport(root, 'src/main.ts', './dep/index.jsx')).toBe('src/dep/index.jsx')
  })

  it('normalizes . segments and parent traversal', () => {
    seed('src/utils/helper.ts')
    expect(resolveImport(root, 'src/main.ts', '../src/./utils/helper')).toBe('src/utils/helper.ts')
  })

  it('returns null when a .. escapes above the project root', () => {
    seed('etc')
    expect(resolveImport(root, 'src/a.ts', '../../etc')).toBeNull()
    expect(resolveImport(root, 'a.ts', '../b.ts')).toBeNull()
  })

  it('returns null for bare module specifiers and non-relative imports in js files', () => {
    expect(resolveImport(root, 'src/a.ts', 'lodash')).toBeNull()
    expect(resolveImport(root, 'src/a.ts', '@scope/pkg')).toBeNull()
  })

  it('returns null for specifiers that normalize to an empty path', () => {
    expect(resolveImport(root, 'a.ts', '.')).toBeNull()
  })

  it('returns null when nothing matches on disk', () => {
    expect(resolveImport(root, 'src/main.ts', './nowhere')).toBeNull()
  })
})
