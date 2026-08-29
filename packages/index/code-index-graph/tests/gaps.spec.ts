import { describe, expect, it } from 'vitest'
import {
  SymbolCatalog,
  TypeCatalog,
  buildAliasMap,
  classifyCallKind,
  createSymbolResolver,
  defaultResolutionConfidence,
  defaultResolutionStrategy,
  resolveName,
  scopeForLine,
} from '../src/index.ts'
import type { CallSiteSignals, ImportBinding, SymbolRow } from '../src/types.ts'
import { callEdge, importRow, symbolRef, symbolRow, typeAssign } from './helpers.ts'

const NO_SIGNALS: CallSiteSignals = { argCount: null, receiver: null }

/** Function symbol with explicit ids and optional scope ownership. */
function sym(
  name: string,
  file: string,
  uid: string,
  overrides: Partial<SymbolRow> = {},
) {
  return symbolRow({ name, filePath: file, qname: name, symbolId: `sym:${uid}`, symbolUid: uid, ...overrides })
}

describe('same-file ambiguity ranking (best_same_file_candidate)', () => {
  it('falls back to all same-file matches when the owner-class member misses', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      { ...sym('App', 'app.py', 'cls', { kind: 'class' }) },
      sym('run', 'app.py', 'r1'),
    ])
    const result = resolveName(catalog, { name: 'run', file: 'app.py', line: 1, scopes: new Map(), imports: [], container: 'App', signals: NO_SIGNALS })
    expect(result!.winningStep).toBe('same_file')
    expect(catalog.entries[result!.catalogIndex]?.symbolUid).toBe('r1')
  })

  it('ranks ambiguous same-file matches by qname length without scopes', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('dup', 'app.py', 'long', { qname: 'a.very.long.qname.dup' }),
      sym('dup', 'app.py', 'short', { qname: 'b.dup' }),
    ])
    const result = resolveName(catalog, { name: 'dup', file: 'app.py', line: 1, scopes: new Map(), imports: [], container: null, signals: NO_SIGNALS })
    // Equal (unreachable) scope distance: the shorter qname wins.
    expect(catalog.entries[result!.catalogIndex]?.symbolUid).toBe('short')
  })

  it('prefers the candidate whose scope is nearest on the chain, with unreachable scopes ranking last', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('dup', 'app.py', 'far', { qname: 'a.dup', scopeId: 's_far' }),
      sym('dup', 'app.py', 'near', { qname: 'b.longer.qname.dup', scopeId: 's_near' }),
      sym('dup', 'app.py', 'orphan', { qname: 'c.dup', scopeId: 's_missing' }),
    ])
    const scopes = new Map([
      ['s_root', { scopeId: 's_root', parentId: null, name: 'root', filePath: 'app.py', startLine: 1, endLine: 100, bindings: [] }],
      ['s_near', { scopeId: 's_near', parentId: 's_root', name: 'near', filePath: 'app.py', startLine: 10, endLine: 90, bindings: [] }],
    ])
    const result = resolveName(catalog, { name: 'dup', file: 'app.py', line: 50, scopes, imports: [], container: null, signals: NO_SIGNALS })
    // s_near is 1 hop away; s_missing is unreachable (10 000); qlen only breaks ties.
    expect(catalog.entries[result!.catalogIndex]?.symbolUid).toBe('near')
  })

  it('breaks an equal-distance tie on the shorter qname through the full ranking loop', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('dup', 'app.py', 'wide', { qname: 'a.wider.qname.dup', scopeId: 's_x' }),
      sym('dup', 'app.py', 'tight', { qname: 'b.dup', scopeId: 's_y' }),
    ])
    // Neither entry scope sits on the current scope's chain: both rank at the
    // unreachable distance, and the shorter qname breaks the tie.
    const scopes = new Map([
      ['s_cur', { scopeId: 's_cur', parentId: null, name: 'cur', filePath: 'app.py', startLine: 1, endLine: 50, bindings: [] }],
    ])
    const result = resolveName(catalog, { name: 'dup', file: 'app.py', line: 10, scopes, imports: [], container: null, signals: NO_SIGNALS })
    expect(catalog.entries[result!.catalogIndex]?.symbolUid).toBe('tight')
  })

  it('returns undefined when the containing scope lookup finds nothing and the name is absent', () => {
    const catalog = new SymbolCatalog()
    expect(resolveName(catalog, { name: 'x.y', file: 'a.py', line: 1, scopes: new Map(), imports: [], container: null, signals: NO_SIGNALS })).toBeNull()
  })
})

describe('self-member deep-tail failure', () => {
  it('keeps the base member when the deeper chain fails', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      { ...sym('Store', 'app.py', 'cls', { kind: 'class' }) },
      sym('save', 'app.py', 'm1', { kind: 'method', container: 'Store', qname: 'Store.save' }),
    ])
    const result = resolveName(catalog, { name: 'this.save.deep', file: 'app.py', line: 1, scopes: new Map(), imports: [], container: 'Store', signals: NO_SIGNALS })
    expect(result!.resolutionKind).toBe('exact')
    expect(catalog.entries[result!.catalogIndex]?.symbolUid).toBe('m1')
  })
})

describe('suffix-step skips', () => {
  it('continues past a dotted name whose leaf bucket is absent', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([sym('other', 'a.py', 'a1')])
    const result = resolveName(catalog, { name: 'ghost.altogether', file: 'a.py', line: 1, scopes: new Map(), imports: [], container: null, signals: NO_SIGNALS })
    // Suffix skips, the global-unique leaf bucket is absent too.
    expect(result).toBeNull()
  })

  it('continues past an over-cap leaf bucket', () => {
    const catalog = new SymbolCatalog({ maxFuzzyPool: 1 })
    catalog.addSymbols([
      sym('d', 'a.py', 'a1', { qname: 'a.z.d' }),
      sym('d', 'b.py', 'b1', { qname: 'b.z.d' }),
    ])
    const result = resolveName(catalog, { name: 'z.d', file: 'c.py', line: 1, scopes: new Map(), imports: [], container: null, signals: NO_SIGNALS })
    // Suffix skips on the over-cap bucket, and the by-name pool shares the
    // same cap, so the ladder resolves nothing.
    expect(result).toBeNull()
  })
})

describe('fuzzy narrowing without a type catalog and with uid-less candidates', () => {
  function barePool(): SymbolCatalog {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('dup', 'src/a.py', 'a1'),
      sym('dup', 'lib/b.py', 'b1'),
    ])
    return catalog
  }

  it('narrows nothing without a type catalog and falls to import distance', () => {
    const result = resolveName(barePool(), {
      name: 'dup', file: 'src/main.py', line: 1, scopes: new Map(), imports: [], container: null,
      signals: { argCount: 1, receiver: null },
    })
    expect(result!.winningStep).toBe('fuzzy_import_distance')
  })

  it('narrows nothing by receiver without a type catalog', () => {
    const result = resolveName(barePool(), {
      name: 'dup', file: 'src/main.py', line: 1, scopes: new Map(), imports: [], container: null,
      signals: { argCount: null, receiver: 'Thing' },
    })
    expect(result!.winningStep).toBe('fuzzy_import_distance')
  })

  it('treats uid-less candidates as wildcards for arity evidence', () => {
    const catalog = new SymbolCatalog()
    const symbols = [
      { ...sym('dup', 'src/a.py', 'a1'), paramCount: 1 },
      { ...sym('dup', 'lib/b.py', 'b1'), paramCount: 2 },
      { ...sym('dup', 'lib/c.py', 'c1'), symbolUid: null },
    ]
    catalog.addSymbols(symbols)
    catalog.buildTypeCatalog(symbols)
    const result = resolveName(catalog, {
      name: 'dup', file: 'src/main.py', line: 1, scopes: new Map(), imports: [], container: null,
      signals: { argCount: 1, receiver: null },
    })
    expect(catalog.entries[result!.catalogIndex]?.symbolUid).toBe('a1')
  })

  it('treats uid-less candidates as wildcards for receiver evidence', () => {
    const catalog = new SymbolCatalog()
    const symbols = [
      { ...sym('dup', 'src/a.py', 'a1', { kind: 'method', receiverType: 'Alpha', container: 'Alpha' }) },
      { ...sym('dup', 'lib/b.py', 'b1', { kind: 'method', receiverType: 'Beta', container: 'Beta' }) },
      { ...sym('dup', 'lib/c.py', 'c1'), symbolUid: null },
    ]
    catalog.addSymbols(symbols)
    catalog.buildTypeCatalog(symbols)
    const result = resolveName(catalog, {
      name: 'dup', file: 'src/main.py', line: 1, scopes: new Map(), imports: [], container: null,
      signals: { argCount: null, receiver: 'Alpha' },
    })
    expect(catalog.entries[result!.catalogIndex]?.symbolUid).toBe('a1')
  })
})

describe('fuzzy import distance with several reachable candidates', () => {
  it('breaks multiple reachable survivors by path distance at penalized confidence', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('dup', 'src/a.py', 'a1'),
      sym('dup', 'src/b.py', 'b1'),
      sym('dup', 'vendor/c.py', 'c1'),
    ])
    const imports = [{
      localName: 'a', sourceModule: 'src/a', importedName: null, filePath: 'src/main.py', isNamespace: false, isDefault: false,
    }, {
      localName: 'b', sourceModule: 'src/b', importedName: null, filePath: 'src/main.py', isNamespace: false, isDefault: false,
    }]
    const result = resolveName(catalog, { name: 'dup', file: 'src/main.py', line: 1, scopes: new Map(), imports, container: null, signals: NO_SIGNALS })
    expect(result!.winningStep).toBe('fuzzy_import_distance')
    expect(result!.resolutionKind).toBe('fuzzy_multi')
    // FuzzyMulti base 0.30 x count penalty 3/3 exempt = 0.30; reachable
    // survivors do not take the unreachable halving.
    expect(result!.confidence).toBeCloseTo(0.30, 12)
    expect(['a1', 'b1']).toContain(catalog.entries[result!.catalogIndex]?.symbolUid)
  })
})

describe('catalog registration and removal edge rows', () => {
  it('registers uid-less, qname-less, export-less rows without catalog surfaces', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([symbolRow({ name: 'anon', filePath: 'a.py', qname: null, symbolUid: null, exportName: null })])
    expect(catalog.byUid.size).toBe(0)
    expect(catalog.byQname.size).toBe(0)
    expect(catalog.byQnameLeaf.size).toBe(0)
    expect(catalog.byFileQname.get('a.py')).toBeUndefined()
    // Name, file, and file-name surfaces still register; the bare name is
    // itself an export key (reference parity).
    expect(catalog.byName.get('anon')).toEqual([0])
    expect([...catalog.byExport.get('a.py')!.keys()]).toEqual(['anon'])
  })

  it('keeps uid mappings that point at surviving files when removing one file', () => {
    const catalog = new SymbolCatalog()
    // Same uid in two files: the last-wins byUid mapping points at b.py.
    catalog.addSymbols([
      sym('twin', 'a.py', 'shared'),
      sym('twin', 'b.py', 'shared'),
    ])
    expect(catalog.byUid.get('shared')).toBe(1)
    catalog.removeFiles(new Set(['a.py']))
    expect(catalog.byUid.get('shared')).toBe(1)
    // A qname-less removed entry prunes no global qname/leaf buckets.
    catalog.addSymbols([symbolRow({ name: 'bare', filePath: 'a.py', qname: null, symbolUid: null, exportName: null })])
    catalog.removeFiles(new Set(['a.py']))
    expect(catalog.byName.get('bare')).toBeUndefined()
  })
})

describe('member-chain container fallbacks', () => {
  it('falls back to the container short name when the container carries no qname', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      symbolRow({ name: 'Host', filePath: 'a.py', kind: 'class', qname: null, symbolId: 'sym:h', symbolUid: 'uid:h' }),
      symbolRow({ name: 'go', filePath: 'a.py', kind: 'method', container: 'Host', qname: 'go', symbolId: 'sym:m', symbolUid: 'uid:m' }),
    ])
    const hostIdx = catalog.findByNameInFile('Host', 'a.py', false)!
    expect(catalog.entries[hostIdx]!.qname).toBeNull()
    // Layer 2 matches members by the container short name.
    expect(catalog.entries[catalog.resolveMemberStep(hostIdx, 'go', 'a.py')!]?.symbolUid).toBe('uid:m')
  })

  it('falls back to the class short name in the constructor pattern when the class has no qname', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      symbolRow({ name: 'instance', filePath: 'a.py', kind: 'variable', qname: 'instance', symbolId: 'sym:i', symbolUid: 'uid:i' }),
      symbolRow({ name: 'Widget', filePath: 'a.py', kind: 'class', qname: null, symbolId: 'sym:w', symbolUid: 'uid:w' }),
      symbolRow({ name: 'ping', filePath: 'a.py', kind: 'method', container: 'Widget', qname: 'Widget.ping', symbolId: 'sym:p', symbolUid: 'uid:p' }),
    ])
    const instanceIdx = catalog.findByNameInFile('instance', 'a.py', false)!
    expect(catalog.entries[catalog.resolveMemberStep(instanceIdx, 'ping', 'a.py')!]?.symbolUid).toBe('uid:p')
  })

  it('answers undefined when a global name bucket exists but no candidate carries the container', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('Host', 'z.py', 'h1', { kind: 'class' }),
      sym('loose', 'c.py', 'l1', { container: 'Other' }),
    ])
    const hostIdx = catalog.findByNameInFile('Host', 'z.py', false)!
    expect(catalog.resolveMemberStep(hostIdx, 'loose', 'z.py')).toBeUndefined()
  })

  it('answers undefined for unresolvable member chains, heads, and containers', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([sym('Host', 'a.py', 'h1', { kind: 'class' })])
    expect(catalog.resolveMemberChain(['MyClass'], 'a.py')).toBeUndefined()
    expect(catalog.resolveMemberChain(['ghost', 'tail'], 'a.py')).toBeUndefined()
    expect(catalog.ownerClassQname('a.py', 'ghost.middle')).toBeUndefined()
  })
})

describe('import resolution misses', () => {
  it('answers undefined for namespace and named exports that the module does not export', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([sym('present', 'utils.py', 'u1')])
    const ns: ImportBinding[] = [{
      localName: 'utils', sourceModule: 'utils.py', importedName: null, filePath: 'app.py', isNamespace: true, isDefault: false,
    }]
    expect(catalog.resolveViaImports(ns, 'utils.absent')).toBeUndefined()
    const named: ImportBinding[] = [{
      localName: 'u', sourceModule: 'utils.py', importedName: 'absent', filePath: 'app.py', isNamespace: false, isDefault: false,
    }]
    expect(catalog.resolveViaImports(named, 'u')).toBeUndefined()
  })
})

describe('default confidence and strategy tables for parser-proven kinds', () => {
  it('backs exact and qualified kinds', () => {
    expect(defaultResolutionConfidence('exact')).toBe(1.0)
    expect(defaultResolutionConfidence('qualified')).toBe(0.95)
    expect(defaultResolutionStrategy('exact')).toBe('parser_exact')
    expect(defaultResolutionStrategy('qualified')).toBe('parser_qualified')
  })
})

describe('scope tie-breaking in the innermost-scope lookup', () => {
  it('prefers the earlier-starting scope when spans tie', () => {
    const scopes = new Map([
      ['later', { scopeId: 'later', parentId: null, name: 'later', filePath: 'a.py', startLine: 6, endLine: 20, bindings: [] }],
      ['earlier', { scopeId: 'earlier', parentId: null, name: 'earlier', filePath: 'a.py', startLine: 1, endLine: 15, bindings: [] }],
    ])
    expect(scopeForLine({ scopes, file: 'a.py', line: 10 })?.scopeId).toBe('earlier')
  })
})

describe('classification head fallback', () => {
  it('classifies a plain capitalized callee with empty imports as a constructor', () => {
    expect(classifyCallKind('Plain', [])).toBe('constructor')
  })
})

describe('type-catalog row fallbacks', () => {
  it('indexes classes without qnames under their short name and strips nothing from aliasless rows', () => {
    const tc = new TypeCatalog()
    tc.buildFromSymbols([
      symbolRow({ name: 'Host', filePath: 'a.py', kind: 'class', qname: null, symbolUid: 'uid:h' }),
      symbolRow({ name: 'Id', filePath: 'a.py', kind: 'type_alias', qname: null, symbolUid: 'uid:i', baseTypes: 'uuid' }),
    ])
    // The short name is its own canonical key when no qname exists.
    expect(tc.isSubtype('Host', 'Host')).toBe(true)
    expect(tc.normalizeTypeName('id')).toBe('uuid')
  })

  it('scores receivers by last segment, first segment, then subtype', () => {
    const tc = new TypeCatalog()
    tc.buildFromSymbols([
      { ...sym('call', 'a.py', 'm1', { kind: 'method', receiverType: 'Alpha', container: 'Alpha' }) },
      { ...sym('call', 'b.py', 'm2', { kind: 'method', receiverType: 'Beta', container: 'Beta' }) },
      symbolRow({ name: 'BetaChild', filePath: 'b.py', kind: 'class', qname: 'BetaChild', symbolUid: 'uid:bc', baseTypes: 'Beta' }),
    ])
    // Last segment wins (score 3).
    expect(tc.resolveMethodByReceiver('call', 'x.Alpha')).toBe('m1')
    // First segment wins when the last misses (score 2).
    expect(tc.resolveMethodByReceiver('call', 'Beta.plain')).toBe('m2')
    // Subtype wins when segments miss (score 1).
    expect(tc.resolveMethodByReceiver('call', 'BetaChild')).toBe('m2')
    // Entries without receiver metadata are skipped, never selected.
    const tc2 = new TypeCatalog()
    tc2.buildFromSymbols([
      { ...sym('run', 'a.py', 'r1', { kind: 'method', receiverType: null, container: null }) },
      { ...sym('run', 'b.py', 'r2', { kind: 'method', receiverType: null, container: null }) },
    ])
    expect(tc2.resolveMethodByReceiver('run', 'Alpha')).toBeUndefined()
  })

  it('keeps the earlier best when a second receiver match does not beat it', () => {
    const tc = new TypeCatalog()
    tc.buildFromSymbols([
      { ...sym('call', 'a.py', 'm1', { kind: 'method', receiverType: 'Alpha', container: 'Alpha' }) },
      { ...sym('call', 'b.py', 'm2', { kind: 'method', receiverType: 'Foo', container: 'Foo' }) },
    ])
    // 'Alpha' matches on the first segment (score 2) and 'Foo' on the last
    // (score 3): the second proposal reaches the score comparison and wins,
    // so the later, higher-scoring entry is the answer.
    expect(tc.resolveMethodByReceiver('call', 'Alpha.foo')).toBe('m2')
  })

  it('keys type-hierarchy removals by short name when the removed meta carries no qname', () => {
    const tc = new TypeCatalog()
    tc.buildFromSymbols([symbolRow({ name: 'Host', filePath: 'a.py', kind: 'class', qname: null, symbolUid: 'uid:h' })])
    tc.removeFiles([{ name: 'Host', qname: null, kind: 'class', symbolUid: 'uid:h' }], new Set(['a.py']))
    expect(tc.isSubtype('Host', 'Host')).toBe(true) // equal names short-circuit
    const tc2 = new TypeCatalog()
    tc2.buildFromSymbols([
      symbolRow({ name: 'Host', filePath: 'a.py', kind: 'class', qname: null, symbolUid: 'uid:h', baseTypes: 'Root' }),
    ])
    expect(tc2.isSubtype('Host', 'Root')).toBe(true)
    tc2.removeFiles([{ name: 'Host', qname: null, kind: 'class', symbolUid: 'uid:h' }], new Set(['a.py']))
    expect(tc2.isSubtype('Host', 'Root')).toBe(false)
  })
})

describe('resolveEdges second-pass and ref-fallback gaps', () => {
  it('leaves a rich-context ref unresolved when the ladder and find-best both miss', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([sym('near', 'app.py', 'a1')])
    const resolver = createSymbolResolver({ catalog })
    const result = resolver.resolveEdges({
      callEdges: [],
      symbolRefs: [
        symbolRef({ filePath: 'app.py', symbolName: '   ', line: null }),
        symbolRef({ filePath: 'app.py', symbolName: 'near' }),
      ],
      imports: [importRow({ filePath: 'app.py', importString: 'utils', resolvedPath: 'utils.py', importedName: 'near' })],
    })
    // Rich context with a blank name: ladder and fallback both miss. The
    // second ref resolves on the same-file step before the import step runs.
    expect(result.symbolRefs[0]).toMatchObject({ targetSymbolId: null, resolutionStrategy: 'unresolved' })
    expect(result.symbolRefs[1]).toMatchObject({ targetSymbolId: 'sym:a1', resolutionStrategy: 'scope' })
    expect(result.resolvedSymbolRefCount).toBe(1)
  })

  it('runs the type pass over an unresolved edge with no proposal and changes nothing', () => {
    const catalog = new SymbolCatalog()
    const symbols = [
      { ...sym('parse', 'src/parser.py', 'm1', { kind: 'method', receiverType: 'Parser', container: 'Parser', qname: 'Parser.parse' }) },
      { ...sym('other', 'src/other.py', 'm2') },
    ]
    catalog.addSymbols(symbols)
    catalog.buildTypeCatalog(symbols)
    const resolver = createSymbolResolver({ catalog })
    const untouched = callEdge({ filePath: 'src/main.py', calleeSymbol: 'nothing.here' })
    const result = resolver.resolveEdges({ callEdges: [untouched], symbolRefs: [], imports: [], typeAssigns: [typeAssign('src/main.py', 'v', 'Parser')] })
    expect(result.callEdges[0]?.targetSymbolId).toBeNull()
    expect(result.callEdges[0]?.resolutionStrategy).toBe('unresolved')
  })
})

describe('coverage completion pass', () => {
  it('walks member chains directly for single- and multi-part heads', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('Host', 'a.py', 'h1', { kind: 'class' }),
      symbolRow({ name: 'go', filePath: 'a.py', kind: 'method', container: 'Host', qname: 'Host.go', symbolId: 'sym:g1', symbolUid: 'uid:g1' }),
    ])
    expect(catalog.resolveMemberChain(['Host'], 'a.py')).toBe(0)
    expect(catalog.entries[catalog.resolveMemberChain(['Host', 'go'], 'a.py')!]?.symbolUid).toBe('uid:g1')
    // A head with no same-file hits resolves nothing.
    expect(catalog.resolveMemberChain(['ghost'], 'a.py')).toBeUndefined()
  })

  it('caps name-tier buckets in find-best when qnames are distinct', () => {
    const capped = new SymbolCatalog({ maxFuzzyPool: 1 })
    capped.addSymbols([sym('dup', 'a.py', 'd1', { qname: 'a.dup' }), sym('dup', 'b.py', 'd2', { qname: 'b.dup' })])
    expect(capped.findBest('dup', 'c.py')).toBeUndefined()
  })

  it('aborts a this-prefixed name when the owner class carries no qname', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      symbolRow({ name: 'Store', filePath: 'app.py', kind: 'class', qname: null, symbolId: 'sym:cls', symbolUid: 'uid:cls' }),
      sym('save', 'app.py', 'm1'),
    ])
    const result = resolveName(catalog, { name: 'this.save', file: 'app.py', line: 1, scopes: new Map(), imports: [], container: 'Store', signals: NO_SIGNALS })
    expect(result).toBeNull()
  })

  it('ranks a qname-less candidate by its short-name length', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('dup', 'app.py', 'long', { qname: 'a.very.long.dup' }),
      symbolRow({ name: 'dup', filePath: 'app.py', qname: null, symbolId: 'sym:bare', symbolUid: 'uid:bare' }),
    ])
    const result = resolveName(catalog, { name: 'dup', file: 'app.py', line: 1, scopes: new Map(), imports: [], container: null, signals: NO_SIGNALS })
    expect(catalog.entries[result!.catalogIndex]?.symbolUid).toBe('uid:bare')
  })

  it('picks the closest suffix match when several qnames share the suffix', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('d', 'src/a.py', 'a1', { qname: 'a.z.d' }),
      sym('d', 'vendor/b.py', 'b1', { qname: 'b.z.d' }),
    ])
    const result = resolveName(catalog, { name: 'z.d', file: 'src/main.py', line: 1, scopes: new Map(), imports: [], container: null, signals: NO_SIGNALS })
    expect(result!.winningStep).toBe('suffix')
    expect(result!.candidateCount).toBe(2)
    expect(catalog.entries[result!.catalogIndex]?.symbolUid).toBe('a1')
  })

  it('keeps the pool when every known arity is smaller than the call', () => {
    const catalog = new SymbolCatalog()
    const symbols: SymbolRow[] = [
      { ...sym('dup', 'src/a.py', 'a1'), kind: 'method', receiverType: 'A', container: 'A', paramCount: 0 },
      { ...sym('dup', 'lib/b.py', 'b1'), kind: 'method', receiverType: 'B', container: 'B', paramCount: 0 },
    ]
    catalog.addSymbols(symbols)
    catalog.buildTypeCatalog(symbols)
    const result = resolveName(catalog, {
      name: 'dup', file: 'src/main.py', line: 1, scopes: new Map(), imports: [], container: null,
      signals: { argCount: 1, receiver: null },
    })
    // varargs-style callees only survive as eliminated — and here both are
    // eliminated, so the narrowing declines and the pool survives untouched.
    expect(result!.winningStep).toBe('fuzzy_import_distance')
  })

  it('answers undefined when no type-catalog signal source resolves', () => {
    const catalog = new SymbolCatalog()
    const symbols = [
      { ...sym('parse', 'src/solo.py', 's1', { kind: 'method', receiverType: 'Solo', container: 'Solo', paramCount: 9 }) },
    ]
    catalog.addSymbols(symbols)
    catalog.buildTypeCatalog(symbols)
    const resolver = createSymbolResolver({ catalog })
    const edge = callEdge({ filePath: 'src/main.py', calleeSymbol: 'v.parse', receiverExpr: 'v', argCount: 1 })
    const result = resolver.resolveEdges({
      callEdges: [edge],
      symbolRefs: [],
      imports: [],
      typeAssigns: [typeAssign('src/main.py', 'v', 'Solo')],
    })
    // The single-entry method buckets refuse to disambiguate; every source
    // misses and the edge stays untouched by the type pass.
    expect(result.callEdges[0]?.resolutionStrategy).toBe('unresolved')
  })

  it('ignores removal metas whose buckets were never registered', () => {
    const tc = new TypeCatalog()
    tc.buildFromSymbols([{ ...sym('parse', 'a.py', 'm1', { kind: 'method', receiverType: 'P', container: 'P' }) }])
    tc.removeFiles([{ name: 'ghost', qname: null, kind: 'method', symbolUid: 'uid:ghost' }], new Set(['a.py']))
    expect(tc.methodParamCount('parse', 'm1')).toBeUndefined()
  })

  it('leaves refs with recorded provenance untouched by the defaults pass', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([sym('near', 'app.py', 'a1')])
    const resolver = createSymbolResolver({ catalog })
    const result = resolver.resolveEdges({
      callEdges: [],
      symbolRefs: [symbolRef({
        filePath: 'app.py', symbolName: 'ghost', resolutionKind: 'heuristic',
        resolutionConfidence: 0.7, resolutionStrategy: 'heuristic',
      })],
      imports: [],
    })
    // Unresolvable, so the recorded provenance passes through untouched.
    expect(result.symbolRefs[0]).toMatchObject({ targetSymbolId: null, resolutionConfidence: 0.7, resolutionStrategy: 'heuristic' })
  })

  it('aliases imports without an imported name under their local name', () => {
    const binding = { localName: 'utils', sourceModule: 'utils.py', importedName: null, filePath: 'a.py', isNamespace: false, isDefault: false }
    expect([...buildAliasMap([binding]).entries()]).toEqual([['utils', 'utils.py:utils']])
  })

  it('compares a worse scope after a better one without replacing it', () => {
    const scopes = new Map([
      ['inner', { scopeId: 'inner', parentId: null, name: 'inner', filePath: 'a.py', startLine: 5, endLine: 10, bindings: [] }],
      ['outer', { scopeId: 'outer', parentId: null, name: 'outer', filePath: 'a.py', startLine: 1, endLine: 20, bindings: [] }],
    ])
    expect(scopeForLine({ scopes, file: 'a.py', line: 7 })?.scopeId).toBe('inner')
  })
})
