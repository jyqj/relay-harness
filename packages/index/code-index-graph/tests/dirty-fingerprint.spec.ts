/**
 * Export-fingerprint contracts: the export filter, whole-string ordering,
 * the no-exports `null`, the 64-hex digest shape, and the changed/target
 * helpers the dirty phase compares with.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  computeExportFingerprint,
  exportFingerprintsChanged,
  reexportTargetsChanged,
} from '../src/dirty/export-fingerprint.ts'
import type { ExportSurfaceSymbol } from '../src/dirty/export-fingerprint.ts'

function symbol(overrides: Partial<ExportSurfaceSymbol> & Pick<ExportSurfaceSymbol, 'name'>): ExportSurfaceSymbol {
  return {
    signature: null,
    exportName: overrides.name,
    isDefaultExport: false,
    symbolUid: `uid:${overrides.name}`,
    ...overrides,
  }
}

describe('computeExportFingerprint', () => {
  it('hashes only exported symbols and ignores private ones', () => {
    const fingerprint = computeExportFingerprint([
      symbol({ name: 'exported' }),
      symbol({ name: 'private', exportName: null }),
    ])
    const onlyExported = computeExportFingerprint([symbol({ name: 'exported' })])
    expect(fingerprint).toBe(onlyExported)
  })

  it('counts default exports without an explicit export name', () => {
    const plain = computeExportFingerprint([symbol({ name: 'Widget', exportName: null })])
    const defaulted = computeExportFingerprint([symbol({ name: 'Widget', exportName: null, isDefaultExport: true })])
    expect(plain).toBeNull()
    expect(defaulted).toMatch(/^[0-9a-f]{64}$/u)
  })

  it('sorts whole rendered lines so input order never changes the digest', () => {
    const forward = computeExportFingerprint([
      symbol({ name: 'zeta', signature: 'fn zeta()' }),
      symbol({ name: 'alpha', signature: 'fn alpha()' }),
    ])
    const backward = computeExportFingerprint([
      symbol({ name: 'alpha', signature: 'fn alpha()' }),
      symbol({ name: 'zeta', signature: 'fn zeta()' }),
    ])
    expect(forward).toBe(backward)
    const joined = ['alpha', 'zeta']
      .map(name => `uid:${name}|${name}|fn ${name}()|${name}`)
      .sort()
      .join('\n')
    expect(forward).toBe(createHash('sha256').update(joined, 'utf8').digest('hex'))
  })

  it('returns null with no exports and renders missing uids as empty fields', () => {
    expect(computeExportFingerprint([])).toBeNull()
    expect(computeExportFingerprint([symbol({ name: 'helper', exportName: null })])).toBeNull()
    const rendered = computeExportFingerprint([symbol({ name: 'alpha', symbolUid: null })])
    const withUid = computeExportFingerprint([symbol({ name: 'alpha' })])
    expect(rendered).not.toBe(withUid)
    const expected = createHash('sha256').update('|alpha||alpha', 'utf8').digest('hex')
    expect(rendered).toBe(expected)
  })
})

describe('exportFingerprintsChanged', () => {
  it('compares including the null-vs-value transitions', () => {
    expect(exportFingerprintsChanged(null, 'abc')).toBe(true)
    expect(exportFingerprintsChanged('abc', null)).toBe(true)
    expect(exportFingerprintsChanged('abc', 'abd')).toBe(true)
    expect(exportFingerprintsChanged('abc', 'abc')).toBe(false)
    expect(exportFingerprintsChanged(null, null)).toBe(false)
  })
})

describe('reexportTargetsChanged', () => {
  it('flips when any re-export target entered the changed set', () => {
    const changed = new Set(['b.ts'])
    expect(reexportTargetsChanged(['b.ts'], changed)).toBe(true)
    expect(reexportTargetsChanged(['b.ts', 'c.ts'], changed)).toBe(true)
    expect(reexportTargetsChanged([], changed)).toBe(false)
    expect(reexportTargetsChanged(['c.ts'], changed)).toBe(false)
  })
})
