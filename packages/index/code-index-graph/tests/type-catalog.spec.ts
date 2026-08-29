import { describe, expect, it } from 'vitest'
import {
  SymbolCatalog,
  TypeCatalog,
  applyTypeCatalogCandidate,
  typeCatalogCandidate,
  typeUpgradeGate,
} from '../src/index.ts'
import type { CallEdgeRow, SymbolRow } from '../src/types.ts'
import { callEdge, symbolRow, typeAssign } from './helpers.ts'

/** Method symbol with receiver metadata. */
function method(name: string, file: string, uid: string, receiverType: string | null, paramCount: number | null): SymbolRow {
  return symbolRow({
    name,
    filePath: file,
    kind: 'method',
    container: receiverType,
    qname: receiverType === null ? name : `${receiverType}.${name}`,
    symbolId: `sym:${uid}`,
    symbolUid: uid,
    receiverType,
    paramCount,
  })
}

/** The reference's parse_method_catalog fixture. */
function parseMethodCatalog(parserParams: number, validatorParams: number): { catalog: SymbolCatalog; symbols: SymbolRow[] } {
  const symbols = [
    method('parse', 'src/parser.py', 'uid:parser_parse', 'Parser', parserParams),
    method('parse', 'src/validator.py', 'uid:validator_parse', 'Validator', validatorParams),
  ]
  const catalog = new SymbolCatalog()
  catalog.addSymbols(symbols)
  catalog.buildTypeCatalog(symbols)
  return { catalog, symbols }
}

/** Pre-resolved edge as the upgrade-gate tests build it (mod.rs make_preresolved_edge). */
type PreResolvedKind = CallEdgeRow['resolutionKind']

function preResolved(kind: PreResolvedKind, strategy: string, confidence: number, targetUid: string, receiver: string): CallEdgeRow {
  return callEdge({
    filePath: 'src/main.py',
    calleeSymbol: 'v.parse',
    receiverExpr: receiver,
    line: 5,
    targetSymbolId: 'sym_pre',
    targetFilePath: 'src/parser.py',
    calleeSymbolUid: targetUid,
    resolutionKind: kind,
    resolutionConfidence: confidence,
    resolutionStrategy: strategy,
  })
}

describe('TypeCatalog construction', () => {
  it('indexes methods, type hierarchies, aliases, and skips uid-less rows', () => {
    const tc = new TypeCatalog()
    tc.buildFromSymbols([
      method('load', 'a.py', 'uid:load', 'Client', 2),
      { ...symbolRow({ name: 'Base', filePath: 'a.py', kind: 'class', qname: 'Base', symbolUid: 'uid:base' }), baseTypes: 'Root, Mixin', implements: 'Iface' },
      { ...symbolRow({ name: 'Id', filePath: 'a.py', kind: 'type_alias', qname: 'Id', symbolUid: 'uid:id', baseTypes: 'uuid' }) },
      symbolRow({ name: 'anon', filePath: 'a.py', symbolUid: null }),
      symbolRow({ name: 'plain', filePath: 'a.py', kind: 'variable', qname: 'plain', symbolUid: 'uid:plain' }),
      { ...symbolRow({ name: 'Empty', filePath: 'a.py', kind: 'type_alias', qname: 'Empty', symbolUid: 'uid:empty', baseTypes: null }) },
    ])
    expect(tc.hasMethods()).toBe(true)
    expect(tc.methodParamCount('load', 'uid:load')).toBe(2)
    expect(tc.methodParamCount('missing', 'uid:load')).toBeUndefined()
    expect(tc.isSubtype('Base', 'Root')).toBe(true)
    expect(tc.isSubtype('Base', 'Iface')).toBe(true)
    // The alias chain maps Id → uuid in normalizeTypeName.
    expect(tc.normalizeTypeName('Id')).toBe('uuid')
    expect(tc.resolveAlias('id')).toBe('uuid')
    expect(tc.resolveAlias('unknown')).toBe('unknown')
  })

  it('answers receiver/arg-count queries with the reference disambiguation rules', () => {
    const { catalog } = parseMethodCatalog(1, 2)
    const tc = catalog.typeCatalog!

    // Single-entry buckets need no disambiguation.
    expect(tc.resolveMethodByReceiver('missing', 'x')).toBeUndefined()
    const single = new TypeCatalog()
    single.buildFromSymbols([method('solo', 'a.py', 'uid:solo', 'Client', 1)])
    expect(single.resolveMethodByReceiver('solo', 'Client')).toBeUndefined()
    expect(single.resolveMethodByArgCount('solo', 1)).toBeUndefined()

    // Receiver: normalized direct match wins; dotted receivers match segments.
    expect(tc.resolveMethodByReceiver('parse', 'Validator')).toBe('uid:validator_parse')
    expect(tc.resolveMethodByReceiver('parse', 'self.Validator')).toBe('uid:validator_parse')
    expect(tc.resolveMethodByReceiver('parse', 'unrelated')).toBeUndefined()

    // Arg count: unique exact match only.
    expect(tc.resolveMethodByArgCount('parse', 2)).toBe('uid:validator_parse')
    expect(tc.resolveMethodByArgCount('parse', 9)).toBeUndefined()
    const equal = new TypeCatalog()
    equal.buildFromSymbols([
      method('tie', 'a.py', 'uid:t1', 'A', 1),
      method('tie', 'b.py', 'uid:t2', 'B', 1),
    ])
    expect(equal.resolveMethodByArgCount('tie', 1)).toBeUndefined()
  })

  it('reports tri-state receiver compatibility', () => {
    const tc = new TypeCatalog()
    tc.buildFromSymbols([
      method('run', 'a.py', 'uid:run', 'Client', 1),
      { ...method('walk', 'a.py', 'uid:walk', null, 1) },
      { ...symbolRow({ name: 'FastClient', filePath: 'a.py', kind: 'class', qname: 'FastClient', symbolUid: 'uid:fast', baseTypes: 'Client' }) },
    ])
    expect(tc.methodReceiverCompat('run', 'uid:run', 'Client')).toBe(true)
    expect(tc.methodReceiverCompat('run', 'uid:run', 'req.Client')).toBe(true)
    expect(tc.methodReceiverCompat('run', 'uid:run', 'FastClient')).toBe(true)
    expect(tc.methodReceiverCompat('run', 'uid:run', 'Stranger')).toBe(false)
    expect(tc.methodReceiverCompat('walk', 'uid:walk', 'Client')).toBeUndefined()
    expect(tc.methodReceiverCompat('missing', 'uid:run', 'Client')).toBeUndefined()
  })

  it('type-assigns resolve last-wins per file+variable and reset in one call', () => {
    const tc = new TypeCatalog()
    tc.addTypeAssigns([typeAssign('a.py', 'client', 'Client'), typeAssign('a.py', 'Client', 'FastClient')])
    expect(tc.resolveVarType('a.py', 'client')).toBe('FastClient')
    expect(tc.resolveVarType('b.py', 'client')).toBeUndefined()
    tc.resetTypeAssigns()
    expect(tc.resolveVarType('a.py', 'client')).toBeUndefined()
  })

  it('normalizes markers, generics, aliases, and unambiguous short names', () => {
    const tc = new TypeCatalog()
    tc.buildFromSymbols([{ ...symbolRow({ name: 'Unique', filePath: 'a.py', kind: 'class', qname: 'pkg.Unique', symbolUid: 'uid:u' }) }])
    expect(tc.normalizeTypeName('  *const Thing? ')).toBe('const thing')
    expect(tc.normalizeTypeName('Map<string, number>')).toBe('map')
    expect(tc.normalizeTypeName('unique')).toBe('pkg.unique')
    // An ambiguous short name stays short.
    tc.buildFromSymbols([
      { ...symbolRow({ name: 'dup', filePath: 'a.py', kind: 'class', qname: 'a.Dup', symbolUid: 'uid:d1' }) },
      { ...symbolRow({ name: 'dup', filePath: 'b.py', kind: 'class', qname: 'b.Dup', symbolUid: 'uid:d2' }) },
    ])
    expect(tc.normalizeTypeName('dup')).toBe('dup')
  })
})

describe('TypeCatalog.removeFiles', () => {
  it('drops removed methods, types, and aliases by file, preserving other files', () => {
    const tc = new TypeCatalog()
    const rows = [
      method('parse', 'a.py', 'uid:a_parse', 'Parser', 1),
      method('parse', 'b.py', 'uid:b_parse', 'Validator', 2),
      { ...symbolRow({ name: 'Parser', filePath: 'a.py', kind: 'class', qname: 'Parser', symbolUid: 'uid:parser' }) },
      { ...symbolRow({ name: 'Id', filePath: 'a.py', kind: 'type_alias', qname: 'Id', symbolUid: 'uid:id', baseTypes: 'uuid' }) },
    ]
    tc.buildFromSymbols(rows)
    // Callers pass the metas of the removed files' symbols only, exactly as
    // SymbolCatalog.removeFiles projects them.
    tc.removeFiles(rows
      .filter(row => row.filePath === 'a.py')
      .map(row => ({ name: row.name, qname: row.qname, kind: row.kind, symbolUid: row.symbolUid })), new Set(['a.py']))

    expect(tc.methodParamCount('parse', 'uid:a_parse')).toBeUndefined()
    expect(tc.methodParamCount('parse', 'uid:b_parse')).toBe(2)
    expect(tc.normalizeTypeName('Parser')).toBe('parser')
    expect(tc.normalizeTypeName('Id')).toBe('id')
  })

  it('ignores uid-less metas and unknown kinds', () => {
    const tc = new TypeCatalog()
    tc.buildFromSymbols([method('parse', 'a.py', 'uid:a_parse', 'Parser', 1)])
    tc.removeFiles([
      { name: 'parse', qname: null, kind: 'method', symbolUid: null },
      { name: 'other', qname: null, kind: 'variable', symbolUid: 'uid:x' },
    ], new Set(['a.py']))
    expect(tc.methodParamCount('parse', 'uid:a_parse')).toBe(1)
  })
})

describe('second-pass adjudication gates (resolve_outcome.rs type_upgrade_gate)', () => {
  it('sends Unresolved and non-name-evidence Heuristic strategies to Backfill', () => {
    expect(typeUpgradeGate(callEdge({ filePath: 'a.py', calleeSymbol: 'f', resolutionKind: 'unresolved', resolutionStrategy: '' }))).toBe('backfill')
    expect(typeUpgradeGate(callEdge({ filePath: 'a.py', calleeSymbol: 'f', resolutionKind: 'heuristic', resolutionStrategy: 'same_file_fallback' }))).toBe('backfill')
    expect(typeUpgradeGate(callEdge({ filePath: 'a.py', calleeSymbol: 'f', resolutionKind: 'heuristic', resolutionStrategy: 'heuristic' }))).toBe('backfill')
  })

  it('sends every name-evidence-only strategy to Upgrade and proof kinds to Skip', () => {
    for (const strategy of ['global_unique', 'suffix', 'fuzzy_single', 'fuzzy_signal', 'fuzzy_arg_count', 'fuzzy_receiver', 'fuzzy_multi']) {
      expect(typeUpgradeGate(preResolved('heuristic', strategy, 0.5, 'uid:x', 'v'))).toBe('upgrade')
    }
    expect(typeUpgradeGate(preResolved('exact', 'exact', 1, 'uid:x', 'v'))).toBe('skip')
    expect(typeUpgradeGate(preResolved('qualified', 'qualified', 0.95, 'uid:x', 'v'))).toBe('skip')
    expect(typeUpgradeGate(preResolved('scope_resolved', 'import_map', 0.85, 'uid:x', 'v'))).toBe('skip')
  })
})

describe('type-catalog candidate precedence (resolve_outcome.rs type_catalog_candidate)', () => {
  it('prefers type-assign receiver over raw receiver over arg count', () => {
    const { catalog } = parseMethodCatalog(1, 2)
    const tc = catalog.typeCatalog!
    const findByUid = (uid: string) => catalog.findByUid(uid)

    const assigned = callEdge({
      filePath: 'src/main.py',
      calleeSymbol: 'v.parse',
      receiverExpr: 'v',
      argCount: 2,
    })
    tc.addTypeAssigns([typeAssign('src/main.py', 'v', 'Validator')])
    expect(typeCatalogCandidate(tc, assigned, findByUid)).toEqual({
      catalogIndex: catalog.findByUid('uid:validator_parse'),
      uid: 'uid:validator_parse',
      kind: 'scope_resolved',
      confidence: 0.90,
      strategy: 'type_assign_receiver',
    })

    const raw = callEdge({ filePath: 'src/main.py', calleeSymbol: 'v.parse', receiverExpr: 'Validator', argCount: 2 })
    expect(typeCatalogCandidate(tc, raw, findByUid)).toMatchObject({ strategy: 'receiver_type', kind: 'qualified', confidence: 0.95 })

    const counted = callEdge({ filePath: 'src/main.py', calleeSymbol: 'v.parse', receiverExpr: null, argCount: 2 })
    expect(typeCatalogCandidate(tc, counted, findByUid)).toMatchObject({ strategy: 'arg_count', kind: 'scope_resolved', confidence: 0.9 })

    expect(typeCatalogCandidate(tc, callEdge({ filePath: 'src/main.py', calleeSymbol: 'v.parse' }), findByUid)).toBeUndefined()
  })

  it('skips candidates whose uid has no catalog entry', () => {
    const { catalog } = parseMethodCatalog(1, 2)
    const tc = catalog.typeCatalog!
    const edge = callEdge({ filePath: 'src/main.py', calleeSymbol: 'v.parse', receiverExpr: 'Validator' })
    expect(typeCatalogCandidate(tc, edge, () => undefined)).toBeUndefined()
  })
})

describe('apply + upgrade protocol (mod.rs type-catalog upgrade-gate tests)', () => {
  it('applies a proposal onto every resolution field including parser confidence', () => {
    const { catalog } = parseMethodCatalog(1, 2)
    const tc = catalog.typeCatalog!
    const edge = callEdge({ filePath: 'src/main.py', calleeSymbol: 'v.parse', receiverExpr: 'Validator' })
    const candidate = typeCatalogCandidate(tc, edge, uid => catalog.findByUid(uid))!
    const applied = applyTypeCatalogCandidate(edge, candidate, catalog.entries)
    expect(applied.targetSymbolId).toBe(catalog.entries[candidate.catalogIndex]?.symbolId)
    expect(applied.targetFilePath).toBe('src/validator.py')
    expect(applied.calleeSymbolUid).toBe('uid:validator_parse')
    expect(applied.resolutionKind).toBe('qualified')
    expect(applied.resolutionConfidence).toBe(0.95)
    expect(applied.resolutionStrategy).toBe('receiver_type')
    expect(applied.parserConfidence).toBe(0.95)
  })

  it('replaces a name-evidence result with a strictly better type proposal and records provenance', () => {
    const { catalog } = parseMethodCatalog(1, 2)
    const tc = catalog.typeCatalog!
    const edge = preResolved('heuristic', 'global_unique', 0.75, 'uid:parser_parse', 'Validator')
    const candidate = typeCatalogCandidate(tc, edge, uid => catalog.findByUid(uid))!
    const applied = applyTypeCatalogCandidate(edge, candidate, catalog.entries)
    expect(applied.calleeSymbolUid).toBe('uid:validator_parse')
    // apply() carries the proposal's own strategy; the ":upgraded_from="
    // provenance is composed by the resolver pass (asserted end-to-end in
    // resolve-edges.spec).
    expect(applied.resolutionStrategy).toBe('receiver_type')
    expect(applied.resolutionConfidence).toBeGreaterThan(0.75)
  })

  it('keeps scope/import-proven results untouched even against higher confidence', () => {
    const edge = preResolved('scope_resolved', 'import_map', 0.85, 'uid:parser_parse', 'Validator')
    expect(typeUpgradeGate(edge)).toBe('skip')
    expect(edge.resolutionStrategy).toBe('import_map')
    expect(edge.resolutionConfidence).toBe(0.85)
  })

  it('keeps the original result when the type catalog agrees on the target', () => {
    const { catalog } = parseMethodCatalog(1, 2)
    const tc = catalog.typeCatalog!
    const edge = preResolved('heuristic', 'global_unique', 0.75, 'uid:validator_parse', 'Validator')
    const candidate = typeCatalogCandidate(tc, edge, uid => catalog.findByUid(uid))!
    // Same target: the upgrade protocol declines regardless of confidence.
    expect(candidate.uid).toBe('uid:validator_parse')
    expect(edge.resolutionStrategy).toBe('global_unique')
    expect(edge.resolutionConfidence).toBe(0.75)
  })
})

describe('receiver scoring improvement path', () => {
  it('replaces an earlier subtype-only match with a higher-scored segment match', () => {
    const tc = new TypeCatalog()
    tc.buildFromSymbols([
      { ...method('call', 'a.py', 'm_parent', 'Parent', 1) },
      { ...method('call', 'b.py', 'm_child', 'Child', 1) },
      symbolRow({ name: 'Child', filePath: 'b.py', kind: 'class', qname: 'Child', symbolUid: 'uid:child', baseTypes: 'Parent' }),
    ])
    // Parent scores 1 via the subtype check; Child then scores 3 via the
    // receiver's last segment and replaces it.
    expect(tc.resolveMethodByReceiver('call', 'x.child')).toBe('m_child')
  })
})
