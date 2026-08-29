/** Snapshot diff: fast-path classification and hash-confirmed change sets. */

import { describe, expect, it } from 'vitest'
import type { ScanEntry } from '../src/scanner.ts'
import { confirmChangedByHash, planSnapshotDiff } from '../src/diff.ts'
import type { IndexedSnapshotRow } from '../src/diff.ts'

function row(mtimeMs: number, size: number, contentHash: string): IndexedSnapshotRow {
  return { mtimeMs, size, contentHash }
}

function entry(path: string, mtimeMs: number, size: number): ScanEntry {
  return { path, mtimeMs, size }
}

describe('planSnapshotDiff', () => {
  it('keeps exact mtime+size matches on the fast path and flags the rest', () => {
    const prev = new Map<string, IndexedSnapshotRow>([
      ['same.ts', row(10, 100, 'aaaa')],
      ['touched-mtime.ts', row(10, 100, 'bbbb')],
      ['rewritten.ts', row(10, 100, 'cccc')],
      ['gone.md', row(5, 12, 'dddd')],
    ])
    const scanned = [
      entry('same.ts', 10, 100),
      entry('new.py', 3, 9),
      entry('touched-mtime.ts', 11, 100),
      entry('rewritten.ts', 99, 55),
    ]
    const plan = planSnapshotDiff(prev, new Map(scanned.map(item => [item.path, item])))
    expect(plan.unchangedCount).toBe(1)
    expect([...plan.suspiciousPaths].sort()).toEqual(['new.py', 'rewritten.ts', 'touched-mtime.ts'])
    expect(plan.removedPaths).toEqual(['gone.md'])
  })
})

describe('confirmChangedByHash', () => {
  it('suppresses false positives whose content hash is unchanged', async () => {
    const prev = new Map<string, IndexedSnapshotRow>([
      ['jittered.ts', row(1, 20, 'hash-old')],
      ['really-changed.ts', row(2, 30, 'hash-a')],
      ['vanished.ts', row(3, 40, 'hash-b')],
      ['brand-new.ts', row(4, 50, 'hash-c')],
    ])
    const reads: Record<string, string | null> = {
      'jittered.ts': 'hash-old',
      'really-changed.ts': 'hash-new',
      'vanished.ts': null,
      'brand-new.ts': 'hash-fresh',
    }
    const { changedPaths, hashUnchangedCount } = await confirmChangedByHash(
      prev,
      Object.keys(reads),
      async path => reads[path] ?? null,
    )
    expect(changedPaths.sort()).toEqual(['brand-new.ts', 'really-changed.ts', 'vanished.ts'])
    expect(hashUnchangedCount).toBe(1)
  })

  it('reports a suspicious path as changed when no previous generation exists', async () => {
    const { changedPaths } = await confirmChangedByHash(new Map(), ['fresh.bin'], async () => 'anything')
    expect(changedPaths).toEqual(['fresh.bin'])
  })
})
