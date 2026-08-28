import { describe, expect, it } from 'vitest'
import {
  BASE_CONFIDENCE,
  bestByImportDistance,
  buildAliasMap,
  candidateCountPenalty,
  classifyCallKind,
  commonPathPrefixLen,
  dedupById,
  dottedPrefixMatch,
  importBindingOf,
  isImportReachable,
  pickUnique,
  scopeChain,
  scopeDistance,
  scopeForLine,
  strategyForResult,
  stripExt,
  stripExtToDotted,
  toResolutionKind,
} from '../src/index.ts'
import type { CatalogScope, ImportBinding } from '../src/types.ts'
import { importRow, scope } from './helpers.ts'

describe('candidate count penalty (helpers.rs candidate_count_penalty)', () => {
  it('exempts pools of one to three candidates', () => {
    expect(candidateCountPenalty(0.5, 1)).toBe(0.5)
    expect(candidateCountPenalty(0.5, 3)).toBe(0.5)
  })

  it('decays linearly by 3/count beyond three candidates', () => {
    expect(candidateCountPenalty(0.5, 4)).toBeCloseTo(0.375, 12)
    expect(candidateCountPenalty(0.5, 6)).toBeCloseTo(0.25, 12)
    expect(candidateCountPenalty(0.5, 10)).toBeCloseTo(0.15, 12)
  })
})

describe('import reachability (helpers.rs is_import_reachable)', () => {
  const imports: ImportBinding[] = [{
    localName: 'helper',
    sourceModule: 'src/utils/helpers.py',
    importedName: 'helper',
    filePath: 'app.py',
    isNamespace: false,
    isDefault: false,
  }]

  it('reaches the imported module tree and its parents', () => {
    expect(isImportReachable('src/utils/helpers.py', imports)).toBe(true)
    expect(isImportReachable('src/utils.py', imports)).toBe(true)
  })

  it('never reaches unrelated modules, and nothing is reachable without imports', () => {
    expect(isImportReachable('tests/conftest.py', imports)).toBe(false)
    expect(isImportReachable('anything.py', [])).toBe(false)
  })
})

describe('path helpers', () => {
  it('strips recognized source extensions only', () => {
    expect(stripExt('src/pkg/mod.py')).toBe('src/pkg/mod')
    expect(stripExt('src/pkg/mod.ts')).toBe('src/pkg/mod')
    expect(stripExt('src/pkg/mod.txt')).toBe('src/pkg/mod.txt')
  })

  it('dottifies paths after extension stripping', () => {
    expect(stripExtToDotted('src/utils/helpers.py')).toBe('src.utils.helpers')
  })

  it('matches segment-aligned dotted prefixes only', () => {
    expect(dottedPrefixMatch('src.utils', 'src.utils')).toBe(true)
    expect(dottedPrefixMatch('src.utils', 'src.utils.helpers')).toBe(true)
    expect(dottedPrefixMatch('src.utils.helpers', 'src.utils')).toBe(true)
    expect(dottedPrefixMatch('src.utils', 'src.utilsXtra')).toBe(false)
  })

  it('counts common directory segments with extensions stripped', () => {
    expect(commonPathPrefixLen('src/pkg/module.py', 'src/pkg/other.py')).toBe(2)
    expect(commonPathPrefixLen('src/a.py', 'tests/b.py')).toBe(0)
    expect(commonPathPrefixLen('src/pkg/mod.py', 'src/pkg/mod.py')).toBe(3)
    expect(commonPathPrefixLen('src/pkg/mod.py', 'src/pkg/mod.ts')).toBe(3)
  })
})

describe('candidate selection', () => {
  const entries = [
    { symbolId: 'a', filePath: 'src/a.py' },
    { symbolId: 'a', filePath: 'src/a.py' },
    { symbolId: 'b', filePath: 'vendor/b.py' },
  ]

  it('pickUnique keeps a single distinct id and rejects ambiguity and duplicates-into-ambiguity', () => {
    expect(pickUnique(entries, [0])).toBe(0)
    expect(pickUnique(entries, [0, 1])).toBe(0)
    expect(pickUnique(entries, [0, 2])).toBeUndefined()
    expect(pickUnique(entries, [])).toBeUndefined()
  })

  it('dedupById keeps first occurrences', () => {
    expect(dedupById(entries, [0, 1, 2, 1])).toEqual([0, 2])
  })

  it('bestByImportDistance prefers the longest shared prefix, ties to the last', () => {
    expect(bestByImportDistance(entries, [0, 2], 'src/main.py')).toBe(0)
    const tied = [
      { symbolId: 'x', filePath: 'lib/x.py' },
      { symbolId: 'y', filePath: 'vendor/y.py' },
    ]
    expect(bestByImportDistance(tied, [0, 1], 'main.py')).toBe(1)
    expect(bestByImportDistance(entries, [], 'src/main.py')).toBeUndefined()
  })
})

describe('scope lookups (resolve_core.rs scope helpers)', () => {
  const scopes = new Map<string, CatalogScope>([
    ['s1', scope('s1', 'a.py', 1, 100)],
    ['s2', scope('s2', 'a.py', 5, 50, [], 's1')],
    ['s3', scope('s3', 'a.py', 10, 30, [], 's2')],
  ])

  it('walks the parent chain innermost-first and stops on cycles or missing parents', () => {
    expect(scopeChain(scopes, 's3').map(s => s.scopeId)).toEqual(['s3', 's2', 's1'])
    expect(scopeChain(new Map(), 's3')).toEqual([])
  })

  it('counts hops only along the chain', () => {
    expect(scopeDistance(scopes, 's3', 's1')).toBe(2)
    expect(scopeDistance(scopes, 's3', 'b.py')).toBeUndefined()
  })

  it('finds the innermost scope containing the line', () => {
    expect(scopeForLine({ scopes, file: 'a.py', line: 12 })?.scopeId).toBe('s3')
    expect(scopeForLine({ scopes, file: 'a.py', line: 40 })?.scopeId).toBe('s2')
    expect(scopeForLine({ scopes, file: 'b.py', line: 12 })).toBeUndefined()
  })
})

describe('alias map and call classification (catalog.rs statics)', () => {
  const imports: ImportBinding[] = [
    {
      localName: 'ext',
      sourceModule: 'lib.py',
      importedName: 'ext',
      filePath: 'app.py',
      isNamespace: false,
      isDefault: false,
    },
  ]

  it('qualifies every local name with module and imported name', () => {
    expect(buildAliasMap(imports).get('ext')).toBe('lib.py:ext')
  })

  it('classifies the five call shapes', () => {
    expect(classifyCallKind('obj.method', imports)).toBe('method')
    expect(classifyCallKind('obj.ClassName', imports)).toBe('constructor')
    expect(classifyCallKind('obj.__init__', imports)).toBe('constructor')
    expect(classifyCallKind('ext', imports)).toBe('imported')
    expect(classifyCallKind('MyClass', imports)).toBe('constructor')
    expect(classifyCallKind('local_fn', imports)).toBe('local')
  })
})

describe('import binding projection (catalog.rs build_import_bindings)', () => {
  it('skips rows without a resolved path', () => {
    expect(importBindingOf(importRow({ filePath: 'a.py', importString: 'os' }))).toBeNull()
  })

  it('prefers alias, then imported name, then the specifier tail', () => {
    const base = { filePath: 'app.py', resolvedPath: 'lib.py' }
    expect(importBindingOf(importRow({ ...base, importString: 'lib', alias: 'l', importedName: 'lib' }))?.localName).toBe('l')
    expect(importBindingOf(importRow({ ...base, importString: 'lib', importedName: 'lib' }))?.localName).toBe('lib')
    // Reference-verbatim tail rule: the last dot-segment, so an
    // extension-bearing specifier yields the extension.
    expect(importBindingOf(importRow({ ...base, importString: 'pkg/lib.py' }))?.localName).toBe('py')
    expect(importBindingOf(importRow({ ...base, importString: 'lib' }))?.localName).toBe('lib')
  })

  it('drops blank local names and carries the namespace/default flags', () => {
    expect(importBindingOf(importRow({ filePath: 'a.py', importString: '  ', resolvedPath: 'lib.py' }))).toBeNull()
    const binding = importBindingOf(importRow({ filePath: 'a.py', importString: 'm', resolvedPath: 'm.py', isNamespace: true, isDefault: true }))
    expect(binding).toMatchObject({ isNamespace: true, isDefault: true, importedName: null, sourceModule: 'm.py' })
  })
})

describe('DB mapping tables (types.rs)', () => {
  it('maps every base confidence exactly', () => {
    expect(BASE_CONFIDENCE).toEqual({
      exact: 1.0,
      qualified: 0.95,
      scope_resolved: 0.9,
      import_resolved: 0.85,
      global_unique: 0.75,
      suffix_match: 0.65,
      heuristic: 0.5,
      fuzzy_single: 0.40,
      fuzzy_signal: 0.55,
      fuzzy_multi: 0.30,
      unresolved: 0.0,
    })
  })

  it('maps every internal kind onto the five stored kinds, ImportResolved folding into scope_resolved', () => {
    expect(toResolutionKind('exact')).toBe('exact')
    expect(toResolutionKind('qualified')).toBe('qualified')
    expect(toResolutionKind('scope_resolved')).toBe('scope_resolved')
    expect(toResolutionKind('import_resolved')).toBe('scope_resolved')
    expect(toResolutionKind('global_unique')).toBe('heuristic')
    expect(toResolutionKind('suffix_match')).toBe('heuristic')
    expect(toResolutionKind('heuristic')).toBe('heuristic')
    expect(toResolutionKind('fuzzy_single')).toBe('heuristic')
    expect(toResolutionKind('fuzzy_signal')).toBe('heuristic')
    expect(toResolutionKind('fuzzy_multi')).toBe('heuristic')
    expect(toResolutionKind('unresolved')).toBe('unresolved')
  })

  it('keeps the kind-level strategy table and overrides the two signal steps', () => {
    expect(strategyForResult('exact', 'same_file')).toBe('exact')
    expect(strategyForResult('qualified', 'same_file')).toBe('qualified')
    expect(strategyForResult('scope_resolved', 'scope_binding')).toBe('scope')
    expect(strategyForResult('import_resolved', 'import')).toBe('import_map')
    expect(strategyForResult('global_unique', 'global_unique')).toBe('global_unique')
    expect(strategyForResult('suffix_match', 'suffix')).toBe('suffix')
    expect(strategyForResult('heuristic', 'same_file')).toBe('heuristic')
    expect(strategyForResult('fuzzy_single', 'fuzzy_import_distance')).toBe('fuzzy_single')
    expect(strategyForResult('fuzzy_signal', 'fuzzy_import_distance')).toBe('fuzzy_signal')
    expect(strategyForResult('fuzzy_multi', 'fuzzy_import_distance')).toBe('fuzzy_multi')
    expect(strategyForResult('unresolved', 'same_file')).toBe('unresolved')
    expect(strategyForResult('fuzzy_signal', 'fuzzy_arg_count')).toBe('fuzzy_arg_count')
    expect(strategyForResult('fuzzy_signal', 'fuzzy_receiver')).toBe('fuzzy_receiver')
  })
})
