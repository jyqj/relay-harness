import { describe, expect, it } from 'vitest'
import { CatalogSliceCache, ResolveMemo, SymbolCatalog, resolveMemoKey, resolveName } from '../src/index.ts'
import type { CallSiteSignals } from '../src/types.ts'
import { symbolRow } from './helpers.ts'

const NO_SIGNALS: CallSiteSignals = { argCount: null, receiver: null }

/** Function symbol with explicit ids so multi-file fixtures stay unambiguous. */
function sym(name: string, file: string, uid: string, qname = name) {
  return symbolRow({ name, filePath: file, qname, symbolId: `sym:${uid}`, symbolUid: uid })
}

describe('catalog indexes', () => {
  it('indexes every lookup surface on addSymbols', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('alpha_fn', 'a.py', 'a1', 'a.alpha_fn'),
      sym('shared_fn', 'a.py', 'a2', 'a.shared_fn'),
      { ...sym('Widget', 'w.py', 'w1'), kind: 'class', isDefaultExport: true, exportName: 'Renamed' },
    ])

    expect(catalog.byName.get('alpha_fn')).toEqual([0])
    expect(catalog.byUid.get('a2')).toBe(1)
    expect(catalog.byFile.get('a.py')).toEqual([0, 1])
    expect(catalog.byQname.get('a.alpha_fn')).toEqual([0])
    expect(catalog.byQnameLeaf.get('alpha_fn')).toEqual([0])
    expect(catalog.byFileName.get('a.py')?.get('shared_fn')).toEqual([1])
    expect(catalog.byFileQname.get('a.py')?.get('a.shared_fn')).toEqual([1])
    // Export surface carries the name, the exported alias, and `default`.
    expect([...catalog.byExport.get('w.py')!.keys()].sort()).toEqual(['default', 'renamed', 'widget'])
  })

  it('answers the exported() lookup through the export surface', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([{ ...sym('Widget', 'w.py', 'w1'), exportName: 'Renamed' }])
    expect(catalog.exported('w.py', 'renamed')).toEqual([0])
    expect(catalog.exported('w.py', 'missing')).toEqual([])
  })

  it('merges name and qname hits in sameFileNamed', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('thing', 'a.py', 'a1', 'pkg.Thing'),
      symbolRow({ name: 'other', filePath: 'a.py', qname: 'thing', symbolId: 'sym:a2', symbolUid: 'uid:a2' }),
    ])
    expect(catalog.sameFileNamed('a.py', 'thing')).toEqual([0, 1])
    expect(catalog.sameFileQname('a.py', 'THING')).toEqual([1])
    expect(catalog.sameFileNamed('b.py', 'thing')).toEqual([])
  })

  it('finds type-like entries on request (findByNameInFile)', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('Pair', 'a.py', 'a1'),
      { ...sym('Pair', 'a.py', 'a2'), kind: 'class', symbolId: 'sym:a2' },
    ])
    expect(catalog.findByNameInFile('Pair', 'a.py', true)).toBe(1)
    expect(catalog.findByNameInFile('Pair', 'a.py', false)).toBe(0)
    expect(catalog.findByNameInFile('Missing', 'a.py', true)).toBeUndefined()
  })

  it('resolves the owning class by walking the container qname upward', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      { ...sym('Outer', 'a.py', 'o1'), kind: 'class' },
      symbolRow({ name: 'Middle', filePath: 'a.py', kind: 'variable', qname: 'Outer.Middle', symbolId: 'sym:o2', symbolUid: 'uid:o2' }),
    ])
    expect(catalog.ownerClassQname('a.py', 'Outer.Middle.inner')).toBe('Outer')
    // The walk continues through non-class segments until a class matches.
    expect(catalog.ownerClassQname('a.py', 'Outer.Middle')).toBe('Outer')
    expect(catalog.ownerClassQname('a.py', null)).toBeUndefined()
  })

  it('canonically names uid-backed entries qname-first', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('bare', 'a.py', 'a1', 'a.bare'),
      symbolRow({ name: 'noq', filePath: 'a.py', qname: null, symbolId: 'sym:a2', symbolUid: 'uid:a2' }),
    ])
    expect(catalog.canonicalNameForUid('a1')).toBe('a.bare')
    expect(catalog.canonicalNameForUid('uid:a2')).toBe('noq')
    expect(catalog.canonicalNameForUid('uid:missing')).toBeUndefined()
  })
})

describe('find_best fallback (route_resolve.rs)', () => {
  it('prefers a unique qname outright', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('helper', 'src/a.py', 'h1', 'src.a.helper'),
      sym('helper', 'lib/b.py', 'h2', 'lib.b.helper'),
      symbolRow({ name: 'helper', filePath: 'vendor/c.py', qname: 'helper', symbolId: 'sym:h3', symbolUid: 'uid:h3' }),
    ])
    expect(catalog.entries[catalog.findBest('helper', 'main.py')!]?.filePath).toBe('vendor/c.py')
  })

  it('in the name tier, prefers same file, then import distance, then the cap', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('helper', 'src/a.py', 'h1', 'src.a.helper'),
      sym('helper', 'lib/b.py', 'h2', 'lib.b.helper'),
    ])
    expect(catalog.entries[catalog.findBest('helper', 'src/a.py')!]?.filePath).toBe('src/a.py')
    expect(catalog.entries[catalog.findBest('helper', 'src/main.py')!]?.filePath).toBe('src/a.py')

    const capped = new SymbolCatalog({ maxFuzzyPool: 1 })
    capped.addSymbols([sym('dup', 'a.py', 'd1'), sym('dup', 'b.py', 'd2')])
    expect(capped.findBest('dup', 'c.py')).toBeUndefined()
  })

  it('in the qname tier, falls back to the first same-file hit, then distance, then the cap', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      symbolRow({ name: 'load', filePath: 'a.py', qname: 'load', symbolId: 'sym:l1', symbolUid: 'uid:l1' }),
      symbolRow({ name: 'load', filePath: 'b.py', qname: 'load', symbolId: 'sym:l2', symbolUid: 'uid:l2' }),
    ])
    expect(catalog.entries[catalog.findBest('load', 'b.py')!]?.filePath).toBe('b.py')
    // No same-file hit: equidistant candidates tie-break to the last one.
    expect(catalog.entries[catalog.findBest('load', 'src/main.py')!]?.filePath).toBe('b.py')
    expect(catalog.findBest('missing', 'a.py')).toBeUndefined()
  })
})

describe('member-chain five layers (resolve_core.rs resolve_member_step)', () => {
  function build(): SymbolCatalog {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      // Layer 1: direct qname.
      symbolRow({ name: 'direct', filePath: 'a.py', kind: 'method', container: 'Host', qname: 'Host.direct', symbolId: 'sym:m1', symbolUid: 'uid:m1' }),
      // Layer 2: container-scoped member with case-insensitive name match.
      symbolRow({ name: 'Member', filePath: 'a.py', kind: 'method', container: 'Host', qname: 'other', symbolId: 'sym:m2', symbolUid: 'uid:m2' }),
      // Layer 3: constructor pattern — variable holding a class instance.
      symbolRow({ name: 'instance', filePath: 'a.py', kind: 'variable', qname: 'instance', symbolId: 'sym:m3', symbolUid: 'uid:m3' }),
      { ...sym('Host', 'a.py', 'm4', 'Host'), kind: 'class', symbolId: 'sym:m4' },
      symbolRow({ name: 'viaClass', filePath: 'a.py', kind: 'method', container: 'Host', qname: 'Host.viaClass', symbolId: 'sym:m5', symbolUid: 'uid:m5' }),
      // Layer 4: cross-file global qname.
      symbolRow({ name: 'global', filePath: 'b.py', kind: 'method', container: 'Host', qname: 'Host.global', symbolId: 'sym:m6', symbolUid: 'uid:m6' }),
      // Layer 5: cross-file container match.
      symbolRow({ name: 'loose', filePath: 'c.py', kind: 'method', container: 'Host', qname: 'c.loose', symbolId: 'sym:m7', symbolUid: 'uid:m7' }),
    ])
    return catalog
  }

  it('resolves each layer in order', () => {
    const catalog = build()
    const hostIdx = catalog.findByNameInFile('Host', 'a.py', false)!
    expect(catalog.entries[catalog.resolveMemberStep(hostIdx, 'direct', 'a.py')!]?.symbolId).toBe('sym:m1')
    expect(catalog.entries[catalog.resolveMemberStep(hostIdx, 'member', 'a.py')!]?.symbolId).toBe('sym:m2')

    const instanceIdx = catalog.findByNameInFile('instance', 'a.py', false)!
    expect(catalog.entries[catalog.resolveMemberStep(instanceIdx, 'viaClass', 'a.py')!]?.symbolId).toBe('sym:m5')

    // Layers 4/5 fire when the container and the member live in different
    // files: the container sits in z.py, the members in b.py/c.py.
    const foreign = new SymbolCatalog()
    foreign.addSymbols([
      { ...sym('Host', 'z.py', 'm4f', 'Host'), kind: 'class', symbolId: 'sym:m4f' },
      symbolRow({ name: 'global', filePath: 'b.py', kind: 'method', container: 'Host', qname: 'Host.global', symbolId: 'sym:m6', symbolUid: 'uid:m6' }),
      symbolRow({ name: 'loose', filePath: 'c.py', kind: 'method', container: 'Host', qname: 'c.loose', symbolId: 'sym:m7', symbolUid: 'uid:m7' }),
    ])
    const hostElsewhere = foreign.findByNameInFile('Host', 'z.py', false)!
    expect(foreign.entries[foreign.resolveMemberStep(hostElsewhere, 'global', 'z.py')!]?.symbolId).toBe('sym:m6')
    expect(foreign.entries[foreign.resolveMemberStep(hostElsewhere, 'loose', 'z.py')!]?.symbolId).toBe('sym:m7')
    expect(foreign.resolveMemberStep(hostElsewhere, 'nothing', 'z.py')).toBeUndefined()
  })

  it('fails closed on empty chains and unresolvable heads', () => {
    const catalog = build()
    expect(catalog.resolveMemberChain([], 'a.py')).toBeUndefined()
    expect(catalog.resolveMemberChain(['absent'], 'a.py')).toBeUndefined()
    const hostIdx = catalog.findByNameInFile('Host', 'a.py', false)!
    expect(catalog.resolveMemberChainFrom(hostIdx, ['absent'], 'a.py')).toBeUndefined()
  })
})

describe('import/export resolution', () => {
  it('resolves named imports and continues through the member chain in the target file', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('helper', 'utils.py', 'u1'),
      symbolRow({ name: 'inner', filePath: 'utils.py', kind: 'method', container: 'helper', qname: 'helper.inner', symbolId: 'sym:u2', symbolUid: 'uid:u2' }),
    ])
    const imports = [{
      localName: 'h',
      sourceModule: 'utils.py',
      importedName: 'helper',
      filePath: 'app.py',
      isNamespace: false,
      isDefault: false,
    }]
    expect(catalog.resolveViaImports(imports, 'h')).toBe(0)
    expect(catalog.entries[catalog.resolveViaImports(imports, 'h.inner')!]?.symbolId).toBe('sym:u2')
    expect(catalog.resolveViaImports(imports, 'absent')).toBeUndefined()
    expect(catalog.resolveViaImports([], 'h')).toBeUndefined()
  })

  it('resolves the default export by name when the exact export misses', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([{ ...sym('secret', 'w.py', 'w1'), isDefaultExport: true }])
    expect(catalog.resolveExport('w.py', 'default')).toBe(0)
    expect(catalog.resolveExport('w.py', 'absent')).toBeUndefined()
  })

  it('scope bindings shadow lookup: dotted tails continue through the member chain', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('base', 'a.py', 'b1'),
      symbolRow({ name: 'tail', filePath: 'a.py', kind: 'method', container: 'base', qname: 'base.tail', symbolId: 'sym:b2', symbolUid: 'uid:b2' }),
    ])
    const result = resolveName(catalog, {
      name: 'base.tail',
      file: 'a.py',
      line: 3,
      scopes: new Map([[
        's',
        { scopeId: 's', parentId: null, name: 's', filePath: 'a.py', startLine: 1, endLine: 10, bindings: [{ name: 'base', kind: 'variable', symbolUid: 'b1' }] },
      ]]),
      imports: [],
      container: null,
      signals: NO_SIGNALS,
    })
    expect(result!.winningStep).toBe('scope_binding')
    expect(catalog.entries[result!.catalogIndex]?.symbolId).toBe('sym:b2')
  })
})

describe('removeFiles prunes every lookup surface (mod.rs test_remove_files_prunes_every_lookup_surface)', () => {
  it('tombstones removed files and collapses ambiguity', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('alpha_fn', 'a.py', 'a1'),
      sym('beta_fn', 'b.py', 'b1'),
      sym('shared_fn', 'a.py', 'a2'),
      sym('shared_fn', 'b.py', 'b2'),
    ])
    expect(catalog.liveLen).toBe(4)

    catalog.removeFiles(new Set(['b.py']))
    expect(catalog.liveLen).toBe(2)

    const scopes = new Map()
    expect(resolveName(catalog, { name: 'beta_fn', file: 'c.py', line: 1, scopes, imports: [], container: null, signals: NO_SIGNALS })).toBeNull()
    const alpha = resolveName(catalog, { name: 'alpha_fn', file: 'c.py', line: 1, scopes, imports: [], container: null, signals: NO_SIGNALS })
    expect(catalog.entries[alpha!.catalogIndex]?.symbolUid).toBe('a1')
    const shared = resolveName(catalog, { name: 'shared_fn', file: 'c.py', line: 1, scopes, imports: [], container: null, signals: NO_SIGNALS })
    expect(shared!.resolutionKind).toBe('global_unique')
    expect(catalog.entries[shared!.catalogIndex]?.filePath).toBe('a.py')
    expect(catalog.sameFileNamed('b.py', 'beta_fn')).toEqual([])
    expect(catalog.canonicalNameForUid('b2')).toBeUndefined()
    expect(catalog.canonicalNameForUid('a2')).toBe('shared_fn')
  })

  it('is a no-op for unknown files and restores resolution after re-adding', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([sym('solo', 'a.py', 'a1')])
    catalog.removeFiles(new Set(['absent.py']))
    expect(catalog.liveLen).toBe(1)

    catalog.removeFiles(new Set(['a.py']))
    expect(catalog.liveLen).toBe(0)
    expect(resolveName(catalog, { name: 'solo', file: 'z.py', line: 1, scopes: new Map(), imports: [], container: null, signals: NO_SIGNALS })).toBeNull()

    catalog.addSymbols([sym('solo', 'a.py', 'a1')])
    const restored = resolveName(catalog, { name: 'solo', file: 'z.py', line: 1, scopes: new Map(), imports: [], container: null, signals: NO_SIGNALS })
    expect(catalog.entries[restored!.catalogIndex]?.symbolUid).toBe('a1')
  })

  it('mirrors removals into the embedded type catalog', () => {
    const catalog = new SymbolCatalog()
    const symbols = [
      { ...sym('parse', 'src/parser.py', 'p1'), kind: 'method' as const, receiverType: 'Parser', paramCount: 1, container: 'Parser', qname: 'Parser.parse' },
      { ...sym('parse', 'src/validator.py', 'p2'), kind: 'method' as const, receiverType: 'Validator', paramCount: 2, container: 'Validator', qname: 'Validator.parse' },
    ]
    catalog.addSymbols(symbols)
    catalog.buildTypeCatalog(symbols)
    expect(catalog.typeCatalog?.hasMethods()).toBe(true)

    catalog.removeFiles(new Set(['src/parser.py']))
    // Only the Validator method remains: receiver resolution now sees one
    // entry, too few to disambiguate.
    expect(catalog.typeCatalog?.resolveMethodByReceiver('parse', 'Validator')).toBeUndefined()
  })
})

describe('resolve memo', () => {
  it('counts hits, evicts least-recently-used, and clears fully', () => {
    const memo = new ResolveMemo(2)
    expect(memo.get('a')).toBeUndefined()

    memo.put('a', null)
    memo.put('b', null)
    expect(memo.hitCount).toBe(0)
    expect(memo.get('a')).toBeNull()
    expect(memo.hitCount).toBe(1)
    memo.put('c', null) // evicts b (a was refreshed by the hit)
    memo.put('d', null) // evicts a
    expect(memo.get('a')).toBeUndefined()
    expect(memo.get('b')).toBeUndefined()
    expect(memo.get('c')).toBeNull()

    memo.clear()
    expect(memo.hitCount).toBe(0)
    expect(memo.get('c')).toBeUndefined()
  })

  it('keys the line only when scopes exist', () => {
    expect(resolveMemoKey('f', 'a.py', null, null, null, null)).toBe(resolveMemoKey('f', 'a.py', null, null, null, null))
    expect(resolveMemoKey('f', 'a.py', 5, null, null, null)).not.toBe(resolveMemoKey('f', 'a.py', 15, null, null, null))
    expect(resolveMemoKey('f', 'a.py', null, null, null, null)).not.toBe(resolveMemoKey('f', 'a.py', 5, null, null, null))
  })
})

describe('per-file slice cache (catalog_cache.rs spirit)', () => {
  it('tracks slices and re-registers a file wholesale on addFile', () => {
    const catalog = new SymbolCatalog()
    const cache = new CatalogSliceCache(catalog, catalog.memo)
    expect(cache.has('a.py')).toBe(false)

    cache.addFile('a.py', [sym('alpha_fn', 'a.py', 'a1')])
    cache.addFile('b.py', [sym('beta_fn', 'b.py', 'b1')])
    expect(cache.has('a.py')).toBe(true)
    expect(cache.files).toEqual(['a.py', 'b.py'])

    // Re-adding replaces the slice: the first alpha_fn leaves the catalog.
    cache.addFile('a.py', [sym('alpha_fn', 'a.py', 'a1-prime')])
    expect(catalog.liveLen).toBe(2)
    const prime = resolveName(catalog, { name: 'alpha_fn', file: 'z.py', line: 1, scopes: new Map(), imports: [], container: null, signals: NO_SIGNALS })
    expect(catalog.entries[prime!.catalogIndex]?.symbolUid).toBe('a1-prime')
  })

  it('removeFile drops the slice; invalidateFile also clears memoized results', () => {
    const catalog = new SymbolCatalog()
    const cache = new CatalogSliceCache(catalog, catalog.memo)
    cache.addFile('a.py', [sym('solo', 'a.py', 'a1')])

    const scopes = new Map()
    resolveName(catalog, { name: 'solo', file: 'z.py', line: 1, scopes, imports: [], container: null, signals: NO_SIGNALS })
    resolveName(catalog, { name: 'solo', file: 'z.py', line: 1, scopes, imports: [], container: null, signals: NO_SIGNALS })
    expect(catalog.memo.hitCount).toBe(1)

    cache.removeFile('absent.py') // no-op on an unknown slice
    cache.invalidateFile('a.py')
    expect(cache.has('a.py')).toBe(false)
    expect(catalog.liveLen).toBe(0)
    expect(catalog.memo.hitCount).toBe(0)
    expect(resolveName(catalog, { name: 'solo', file: 'z.py', line: 1, scopes, imports: [], container: null, signals: NO_SIGNALS })).toBeNull()
  })
})
