import { describe, expect, it } from 'vitest'
import { RESOLVE_LADDER, SymbolCatalog, resolveName } from '../src/index.ts'
import type { CallSiteSignals, CatalogScope, ImportBinding, SymbolRow } from '../src/types.ts'
import { scope, symbolRow } from './helpers.ts'

const NO_SIGNALS: CallSiteSignals = { argCount: null, receiver: null }

/** Function symbol with a distinct symbol id and a file-derived qname. */
function distinct(name: string, file: string, uid: string): SymbolRow {
  const qname = `${file.replace(/\//g, '.').replace(/\.py$/, '')}.${name}`
  return { ...symbolRow({ name, filePath: file, qname, symbolId: `sym#${file}#${name}`, symbolUid: uid }) }
}

/** Method symbol with receiver type and parameter count recorded. */
function method(name: string, file: string, uid: string, receiverType: string, paramCount: number): SymbolRow {
  return {
    ...symbolRow({
      name,
      filePath: file,
      kind: 'method',
      container: receiverType,
      qname: `${receiverType}.${name}`,
      symbolId: `sym_${receiverType}_${name}`,
      symbolUid: uid,
      receiverType,
      paramCount,
    }),
  }
}

/** The reference's parse_method_catalog: Parser.parse and Validator.parse. */
function parseMethodCatalog(parserParams: number, validatorParams: number): SymbolCatalog {
  const catalog = new SymbolCatalog()
  const symbols = [
    method('parse', 'src/parser.py', 'uid:parser_parse', 'Parser', parserParams),
    method('parse', 'src/validator.py', 'uid:validator_parse', 'Validator', validatorParams),
  ]
  catalog.addSymbols(symbols)
  catalog.buildTypeCatalog(symbols)
  return catalog
}

function binding(name: string, symbolUid: string | null) {
  return { name, kind: 'variable', symbolUid }
}

function importOf(localName: string, sourceModule: string): ImportBinding {
  return {
    localName,
    sourceModule,
    importedName: null,
    filePath: 'src/main.py',
    isNamespace: false,
    isDefault: false,
  }
}

describe('RESOLVE_LADDER order', () => {
  it('locks the nine-step evaluation order', () => {
    expect(RESOLVE_LADDER).toEqual([
      'self_member',
      'scope_binding',
      'same_file',
      'import',
      'suffix',
      'global_unique',
      'fuzzy_arg_count',
      'fuzzy_receiver',
      'fuzzy_import_distance',
    ])
  })
})

describe('proof steps', () => {
  it('resolves scope bindings before same-file candidates (mod.rs test_resolve_name_full_pipeline)', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      symbolRow({ name: 'local_func', filePath: 'main.py', qname: 'local_func' }),
      symbolRow({ name: 'imported_func', filePath: 'lib.py', qname: 'imported_func' }),
      symbolRow({ name: 'unique_global', filePath: 'other.py', qname: 'unique_global' }),
    ])
    const scopes = new Map<string, CatalogScope>([
      ['mod', scope('mod', 'main.py', 1, 100, [binding('local_func', 'uid:main.py:local_func')])],
    ])
    const imports = [importOf('imported_func', 'lib.py')]

    const scoped = resolveName(catalog, { name: 'local_func', file: 'main.py', line: 10, scopes, imports, container: null, signals: NO_SIGNALS })
    expect(catalog.entries[scoped!.catalogIndex]?.name).toBe('local_func')
    expect(scoped!.resolutionKind).toBe('scope_resolved')
    expect(scoped!.winningStep).toBe('scope_binding')

    const imported = resolveName(catalog, { name: 'imported_func', file: 'main.py', line: 10, scopes, imports, container: null, signals: NO_SIGNALS })
    expect(imported!.resolutionKind).toBe('import_resolved')
    expect(imported!.winningStep).toBe('import')
    expect(imported!.confidence).toBe(0.85)

    const global = resolveName(catalog, { name: 'unique_global', file: 'main.py', line: 10, scopes, imports, container: null, signals: NO_SIGNALS })
    expect(global!.resolutionKind).toBe('global_unique')
  })

  it('resolves dotted same-file names through the member chain as qualified (mod.rs test_resolve_member_chain)', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      symbolRow({ name: 'MyClass', filePath: 'app.py', kind: 'class', qname: 'MyClass' }),
      symbolRow({ name: 'service', filePath: 'app.py', kind: 'variable', qname: 'service' }),
      symbolRow({ name: 'handler', filePath: 'app.py', kind: 'method', container: 'MyClass', qname: 'MyClass.handler' }),
      symbolRow({
        name: 'inner',
        filePath: 'app.py',
        kind: 'method',
        container: 'MyClass.handler',
        qname: 'MyClass.handler.inner',
      }),
    ])

    const result = resolveName(catalog, { name: 'MyClass.handler.inner', file: 'app.py', line: 1, scopes: new Map(), imports: [], container: null, signals: NO_SIGNALS })
    expect(result!.resolutionKind).toBe('qualified')
    expect(catalog.entries[result!.catalogIndex]?.name).toBe('inner')
    expect(result!.confidence).toBe(0.95)
  })

  it('prefers the owner-class member for plain same-file names (scope_resolved at 0.9)', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      symbolRow({ name: 'run', filePath: 'app.py', qname: 'appfile.run', symbolId: 'sym:plain_run', symbolUid: 'uid:plain_run' }),
      symbolRow({ name: 'App', filePath: 'app.py', kind: 'class', qname: 'App', symbolId: 'sym:app', symbolUid: 'uid:app' }),
      symbolRow({ name: 'run', filePath: 'app.py', kind: 'method', container: 'App', qname: 'App.run', symbolId: 'sym:app_run', symbolUid: 'uid:app_run' }),
    ])

    const result = resolveName(catalog, { name: 'run', file: 'app.py', line: 20, scopes: new Map(), imports: [], container: 'App', signals: NO_SIGNALS })
    expect(result!.resolutionKind).toBe('scope_resolved')
    expect(catalog.entries[result!.catalogIndex]?.qname).toBe('App.run')
  })

  it('resolves namespace imports through the tail export name', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([symbolRow({ name: 'helper', filePath: 'utils.py', qname: 'helper' })])
    const nsImport: ImportBinding = {
      localName: 'utils',
      sourceModule: 'utils.py',
      importedName: null,
      filePath: 'app.py',
      isNamespace: true,
      isDefault: false,
    }

    const hit = resolveName(catalog, { name: 'utils.helper', file: 'app.py', line: 1, scopes: new Map(), imports: [nsImport], container: null, signals: NO_SIGNALS })
    expect(hit!.winningStep).toBe('import')
    expect(catalog.entries[hit!.catalogIndex]?.name).toBe('helper')

    // A bare namespace head names no export.
    const bare = resolveName(catalog, { name: 'utils', file: 'app.py', line: 1, scopes: new Map(), imports: [nsImport], container: null, signals: NO_SIGNALS })
    expect(bare).toBeNull()
  })

  it('falls from namespace exports to the member chain of the exporting file', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      symbolRow({ name: 'mod', filePath: 'pkg.py', qname: 'mod' }),
      symbolRow({ name: 'deep', filePath: 'pkg.py', kind: 'method', container: 'mod', qname: 'mod.deep' }),
    ])
    const nsImport: ImportBinding = {
      localName: 'pkg',
      sourceModule: 'pkg.py',
      importedName: null,
      filePath: 'app.py',
      isNamespace: true,
      isDefault: false,
    }
    const result = resolveName(catalog, { name: 'pkg.mod.deep', file: 'app.py', line: 1, scopes: new Map(), imports: [nsImport], container: null, signals: NO_SIGNALS })
    expect(catalog.entries[result!.catalogIndex]?.name).toBe('deep')
  })

  it('binds default exports by the default export name', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([{ ...symbolRow({ name: 'Widget', filePath: 'w.py', qname: 'Widget' }), isDefaultExport: true, exportName: 'Widget' }])
    const defaultImport: ImportBinding = {
      localName: 'Widget',
      sourceModule: 'w.py',
      importedName: null,
      filePath: 'app.py',
      isNamespace: false,
      isDefault: true,
    }
    const result = resolveName(catalog, { name: 'Widget', file: 'app.py', line: 1, scopes: new Map(), imports: [defaultImport], container: null, signals: NO_SIGNALS })
    expect(result!.winningStep).toBe('import')
    expect(catalog.entries[result!.catalogIndex]?.name).toBe('Widget')
  })
})

describe('SelfMember step is authoritative', () => {
  function ownerCatalog(): SymbolCatalog {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      symbolRow({ name: 'save', filePath: 'app.py', kind: 'method', container: 'Store', qname: 'Store.save' }),
      symbolRow({ name: 'Store', filePath: 'app.py', kind: 'class', qname: 'Store' }),
      symbolRow({ name: 'inner', filePath: 'app.py', kind: 'method', container: 'Store.save', qname: 'Store.save.inner' }),
      // A same-named global that the this-prefixed name must never reach.
      distinct('missing', 'other.py', 'uid:other_missing'),
    ])
    return catalog
  }

  it('resolves this.member on the owner class as exact', () => {
    const catalog = ownerCatalog()
    const hit = resolveName(catalog, { name: 'this.save', file: 'app.py', line: 5, scopes: new Map(), imports: [], container: 'Store', signals: NO_SIGNALS })
    expect(hit!.resolutionKind).toBe('exact')
    expect(hit!.winningStep).toBe('self_member')
    expect(catalogEntryName(catalog, hit)).toBe('save')
  })

  it('walks deeper tails as qualified', () => {
    const catalog = ownerCatalog()
    const result = resolveName(catalog, { name: 'this.save.inner', file: 'app.py', line: 5, scopes: new Map(), imports: [], container: 'Store', signals: NO_SIGNALS })
    expect(result!.resolutionKind).toBe('qualified')
    expect(catalogEntryName(catalog, result)).toBe('inner')
  })

  it('aborts the whole ladder on a missing member instead of reaching the global', () => {
    const catalog = ownerCatalog()
    const aborted = resolveName(catalog, { name: 'this.missing', file: 'app.py', line: 5, scopes: new Map(), imports: [], container: 'Store', signals: NO_SIGNALS })
    expect(aborted).toBeNull()

    // A this/self name with no owner class aborts too.
    const ownerless = resolveName(catalog, { name: 'self.save', file: 'app.py', line: 5, scopes: new Map(), imports: [], container: null, signals: NO_SIGNALS })
    expect(ownerless).toBeNull()
  })

  it('continues past non-this/self names', () => {
    const result = resolveName(ownerCatalog(), { name: 'save', file: 'app.py', line: 5, scopes: new Map(), imports: [], container: 'Store', signals: NO_SIGNALS })
    expect(result!.winningStep).toBe('same_file')
  })
})

describe('ladder confidence boundaries (mod.rs ladder boundary tests)', () => {
  it('scores a single suffix match at the 0.65 base', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([distinct('helper', 'src/mod.py', 'uid:h')])
    const result = resolveName(catalog, { name: 'mod.helper', file: 'src/main.py', line: 5, scopes: new Map(), imports: [], container: null, signals: NO_SIGNALS })
    expect(result!.winningStep).toBe('suffix')
    expect(result!.resolutionKind).toBe('suffix_match')
    expect(result!.candidateCount).toBe(1)
    expect(result!.confidence).toBeCloseTo(0.65, 12)
  })

  it('falls from a suffix miss to global unique at 0.75', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([distinct('helper', 'src/other.py', 'uid:h')])
    const result = resolveName(catalog, { name: 'mod.helper', file: 'src/main.py', line: 5, scopes: new Map(), imports: [], container: null, signals: NO_SIGNALS })
    expect(result!.winningStep).toBe('global_unique')
    expect(result!.confidence).toBeCloseTo(0.75, 12)
  })

  it('scores a globally unique leaf at 0.75 and a miss falls to import distance at 0.15', () => {
    const unique = new SymbolCatalog()
    unique.addSymbols([distinct('helper', 'src/lib.py', 'uid:h')])
    const hit = resolveName(unique, { name: 'helper', file: 'src/main.py', line: 5, scopes: new Map(), imports: [], container: null, signals: NO_SIGNALS })
    expect(hit!.winningStep).toBe('global_unique')
    expect(hit!.confidence).toBeCloseTo(0.75, 12)

    const ambiguous = new SymbolCatalog()
    ambiguous.addSymbols([distinct('helper', 'src/a.py', 'uid:a'), distinct('helper', 'lib/b.py', 'uid:b')])
    const miss = resolveName(ambiguous, { name: 'helper', file: 'src/main.py', line: 5, scopes: new Map(), imports: [], container: null, signals: NO_SIGNALS })
    expect(miss!.winningStep).toBe('fuzzy_import_distance')
    expect(miss!.resolutionKind).toBe('fuzzy_multi')
    expect(miss!.candidateCount).toBe(2)
    // FuzzyMulti base 0.30, exempt from the count penalty at two candidates,
    // halved because no import makes either candidate reachable.
    expect(miss!.confidence).toBeCloseTo(0.15, 12)
  })

  it('promotes a uniquely reachable fuzzy survivor to the fuzzy_single 0.40 anchor', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([distinct('helper', 'src/a.py', 'uid:a'), distinct('helper', 'lib/b.py', 'uid:b')])
    const imports = [importOf('a', 'src/a')]
    const result = resolveName(catalog, { name: 'helper', file: 'src/main.py', line: 5, scopes: new Map(), imports, container: null, signals: NO_SIGNALS })
    expect(result!.winningStep).toBe('fuzzy_import_distance')
    expect(catalog.entries[result!.catalogIndex]?.symbolUid).toBe('uid:a')
    expect(result!.resolutionKind).toBe('fuzzy_multi')
    expect(result!.confidence).toBeCloseTo(0.40, 12)
  })

  it('applies the 0.6x penalty to a global-unique winner no import reaches', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([distinct('rare_func', 'vendor/deep/module.py', 'uid:rare')])
    const imports = [importOf('utils', 'src/utils.py')]
    const result = resolveName(catalog, { name: 'rare_func', file: 'main.py', line: 5, scopes: new Map(), imports, container: null, signals: NO_SIGNALS })
    expect(result!.resolutionKind).toBe('global_unique')
    expect(result!.confidence).toBeCloseTo(0.45, 12)
  })
})

describe('fuzzy signal steps', () => {
  it('narrows by argument count to fuzzy_signal with the step strategy', () => {
    const catalog = parseMethodCatalog(1, 2)
    const result = resolveName(catalog, {
      name: 'parse',
      file: 'src/main.py',
      line: 5,
      scopes: new Map(),
      imports: [],
      container: null,
      signals: { argCount: 1, receiver: null },
    })
    expect(catalog.entries[result!.catalogIndex]?.symbolUid).toBe('uid:parser_parse')
    expect(result!.resolutionKind).toBe('fuzzy_signal')
    expect(result!.winningStep).toBe('fuzzy_arg_count')
    expect(result!.candidateCount).toBe(2)
    expect(result!.confidence).toBeCloseTo(0.55, 12)
    expect(result!.confidence).toBeGreaterThan(0.40)
    expect(result!.confidence).toBeLessThan(0.75)
  })

  it('narrows by receiver when parameter counts cannot discriminate', () => {
    const catalog = parseMethodCatalog(1, 1)
    const result = resolveName(catalog, {
      name: 'parse',
      file: 'src/main.py',
      line: 5,
      scopes: new Map(),
      imports: [],
      container: null,
      signals: { argCount: null, receiver: 'Validator' },
    })
    expect(catalog.entries[result!.catalogIndex]?.symbolUid).toBe('uid:validator_parse')
    expect(result!.winningStep).toBe('fuzzy_receiver')
    expect(result!.confidence).toBeCloseTo(0.55, 12)
  })

  it('prefers the defaulted-params tier when no exact arity matches', () => {
    const catalog = parseMethodCatalog(3, 0)
    const result = resolveName(catalog, {
      name: 'parse',
      file: 'src/main.py',
      line: 5,
      scopes: new Map(),
      imports: [],
      container: null,
      signals: { argCount: 1, receiver: null },
    })
    expect(catalog.entries[result!.catalogIndex]?.symbolUid).toBe('uid:parser_parse')
    expect(result!.winningStep).toBe('fuzzy_arg_count')
  })

  it('keeps metadata-less wildcards and falls through to import distance', () => {
    const catalog = new SymbolCatalog()
    const symbols = [
      method('parse', 'src/parser.py', 'uid:parser_parse', 'Parser', 1),
      { ...method('parse', 'src/untyped.py', 'uid:untyped_parse', 'Untyped', 1), paramCount: null },
    ]
    catalog.addSymbols(symbols)
    catalog.buildTypeCatalog(symbols)
    const result = resolveName(catalog, {
      name: 'parse',
      file: 'src/main.py',
      line: 5,
      scopes: new Map(),
      imports: [],
      container: null,
      signals: { argCount: 1, receiver: null },
    })
    expect(result!.winningStep).toBe('fuzzy_import_distance')
    expect(result!.resolutionKind).toBe('fuzzy_multi')
  })

  it('refuses elimination-only receiver evidence', () => {
    const catalog = new SymbolCatalog()
    const symbols = [
      method('parse', 'src/parser.py', 'uid:parser_parse', 'Parser', 1),
      { ...method('parse', 'src/untyped.py', 'uid:untyped_parse', 'Untyped', 1), receiverType: null },
    ]
    catalog.addSymbols(symbols)
    catalog.buildTypeCatalog(symbols)
    const result = resolveName(catalog, {
      name: 'parse',
      file: 'src/main.py',
      line: 5,
      scopes: new Map(),
      imports: [],
      container: null,
      signals: { argCount: null, receiver: 'Validator' },
    })
    expect(result!.winningStep).toBe('fuzzy_import_distance')
  })

  it('halves fuzzy_signal confidence when the winner is not import-reachable', () => {
    const catalog = parseMethodCatalog(1, 2)
    const imports = [importOf('other', 'pkg/elsewhere')]
    const result = resolveName(catalog, {
      name: 'parse',
      file: 'src/main.py',
      line: 5,
      scopes: new Map(),
      imports,
      container: null,
      signals: { argCount: 1, receiver: null },
    })
    expect(result!.resolutionKind).toBe('fuzzy_signal')
    expect(result!.confidence).toBeCloseTo(0.275, 12)
  })

  it('decays a uniquely reachable winner of a four-candidate pool to 0.30', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      distinct('process', 'src/a.py', 'uid:a'),
      distinct('process', 'src/b.py', 'uid:b'),
      distinct('process', 'lib/c.py', 'uid:c'),
      distinct('process', 'vendor/d.py', 'uid:d'),
    ])
    const imports = [importOf('a_mod', 'src/a.py')]
    const result = resolveName(catalog, { name: 'process', file: 'src/main.py', line: 5, scopes: new Map(), imports, container: null, signals: NO_SIGNALS })
    expect(result!.resolutionKind).toBe('fuzzy_multi')
    expect(catalog.entries[result!.catalogIndex]?.filePath).toBe('src/a.py')
    // fuzzy_single base 0.40 x count penalty 3/4 = 0.30.
    expect(result!.confidence).toBeCloseTo(0.30, 12)
  })

  it('keeps legacy import-distance behavior without signals (no-signal == legacy)', () => {
    const catalog = parseMethodCatalog(1, 2)
    const result = resolveName(catalog, { name: 'parse', file: 'src/main.py', line: 5, scopes: new Map(), imports: [], container: null, signals: NO_SIGNALS })
    expect(result!.resolutionKind).toBe('fuzzy_multi')
    expect(result!.winningStep).toBe('fuzzy_import_distance')
    expect(result!.candidateCount).toBe(2)
    expect(result!.confidence).toBeCloseTo(0.15, 12)
  })
})

describe('scope-chain details', () => {
  it('binds the same name differently per line and never cross-serves cached lines', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      symbolRow({ name: 'target_a', filePath: 'main.py', qname: 'main.target_a', symbolId: 'sym:a', symbolUid: 'uid:a' }),
      symbolRow({ name: 'target_b', filePath: 'main.py', qname: 'main.target_b', symbolId: 'sym:b', symbolUid: 'uid:b' }),
    ])
    const scopes = new Map<string, CatalogScope>([
      ['s1', scope('s1', 'main.py', 1, 10, [binding('x', 'uid:a')])],
      ['s2', scope('s2', 'main.py', 11, 20, [binding('x', 'uid:b')])],
    ])

    const first = resolveName(catalog, { name: 'x', file: 'main.py', line: 5, scopes, imports: [], container: null, signals: NO_SIGNALS })
    expect(catalog.entries[first!.catalogIndex]?.symbolUid).toBe('uid:a')
    const second = resolveName(catalog, { name: 'x', file: 'main.py', line: 15, scopes, imports: [], container: null, signals: NO_SIGNALS })
    expect(catalog.entries[second!.catalogIndex]?.symbolUid).toBe('uid:b')
  })

  it('treats a binding without a catalog uid as a shadowed local: the step continues, and with no other evidence the ladder resolves nothing', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([distinct('unrelated', 'main.py', 'uid:u')])
    const scopes = new Map<string, CatalogScope>([
      ['s1', scope('s1', 'main.py', 1, 10, [binding('shadowed', null)])],
    ])
    const result = resolveName(catalog, { name: 'shadowed', file: 'main.py', line: 5, scopes, imports: [], container: null, signals: NO_SIGNALS })
    expect(result).toBeNull()
  })
})

describe('memo behavior', () => {
  it('caches identical queries including misses, and separates signal variants', () => {
    const catalog = parseMethodCatalog(1, 2)
    const base = { name: 'parse', file: 'src/main.py', line: 5, scopes: new Map<string, CatalogScope>(), imports: [], container: null }

    const plain = resolveName(catalog, { ...base, signals: NO_SIGNALS })
    const plainAgain = resolveName(catalog, { ...base, signals: NO_SIGNALS })
    expect(plainAgain).toEqual(plain)
    expect(catalog.memo.hitCount).toBe(1)

    const signaled = resolveName(catalog, { ...base, signals: { argCount: 2, receiver: null } })
    expect(signaled!.resolutionKind).toBe('fuzzy_signal')
    expect(catalog.entries[signaled!.catalogIndex]?.symbolUid).toBe('uid:validator_parse')
    const signaledAgain = resolveName(catalog, { ...base, signals: { argCount: 2, receiver: null } })
    expect(signaledAgain!.winningStep).toBe(signaled!.winningStep)
  })

  it('rejects blank names without consulting anything', () => {
    const catalog = new SymbolCatalog()
    expect(resolveName(catalog, { name: '   ', file: 'a.py', line: 1, scopes: new Map(), imports: [], container: null, signals: NO_SIGNALS })).toBeNull()
  })
})

/** Entry short name behind a result index. */
function catalogEntryName(catalog: SymbolCatalog, result: { catalogIndex: number } | null): string | undefined {
  return result === null ? undefined : catalog.entries[result.catalogIndex]?.name
}
