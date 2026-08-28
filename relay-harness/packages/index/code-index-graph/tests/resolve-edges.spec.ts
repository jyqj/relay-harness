import { describe, expect, it, vi } from 'vitest'
import { SymbolCatalog, createSymbolResolver } from '../src/index.ts'
import type { CallEdgeRow, SymbolRefRow, SymbolRow } from '../src/types.ts'
import { callEdge, importRow, symbolRef, symbolRow, typeAssign } from './helpers.ts'

/** Function symbol with explicit ids. */
function sym(name: string, file: string, uid: string, overrides: Partial<SymbolRow> = {}): SymbolRow {
  return symbolRow({
    name,
    filePath: file,
    qname: `${file.replace(/\//g, '.').replace(/\.py$/, '')}.${name}`,
    symbolId: `sym:${uid}`,
    symbolUid: uid,
    ...overrides,
  })
}

describe('resolveEdges: never-overwrite gate and defaults', () => {
  it('never rewrites a bound row but backfills its empty defaults', () => {
    const resolver = createSymbolResolver({ catalog: new SymbolCatalog() })
    const bound = callEdge({
      filePath: 'a.py',
      calleeSymbol: 'fn',
      targetSymbolId: 'sym:t',
      targetFilePath: 't.py',
      calleeSymbolUid: 'uid:t',
      resolutionKind: 'scope_resolved',
      resolutionConfidence: 0,
      resolutionStrategy: '',
    })
    const result = resolver.resolveEdges({ callEdges: [bound], symbolRefs: [], imports: [] })
    expect(result.callEdges[0]).toMatchObject({
      targetSymbolId: 'sym:t',
      resolutionConfidence: 0.9,
      resolutionStrategy: 'parser_scope',
    })
    expect(result.resolvedCallEdgeCount).toBe(0)
  })

  it('returns an untouched row by identity, and backfills unresolved rows that resolve to nothing', () => {
    const resolver = createSymbolResolver({ catalog: new SymbolCatalog() })
    const alreadyComplete = callEdge({
      filePath: 'a.py',
      calleeSymbol: 'fn',
      resolutionKind: 'unresolved',
      resolutionConfidence: 0.5,
      resolutionStrategy: 'heuristic',
    })
    const orphan = callEdge({ filePath: 'a.py', calleeSymbol: 'nowhere' })
    const result = resolver.resolveEdges({ callEdges: [alreadyComplete, orphan], symbolRefs: [], imports: [] })
    expect(result.callEdges[0]).toBe(alreadyComplete)
    expect(result.callEdges[1]).toMatchObject({ resolutionStrategy: 'unresolved', resolutionConfidence: 0, targetSymbolId: null })
    expect(result.resolvedCallEdgeCount).toBe(0)
  })

  it('rejects blank callee names without consulting the ladder', () => {
    const resolver = createSymbolResolver({ catalog: new SymbolCatalog() })
    const result = resolver.resolveEdges({
      callEdges: [callEdge({ filePath: 'a.py', calleeSymbol: '   ' })],
      symbolRefs: [],
      imports: [importRow({ filePath: 'a.py', importString: 'm', resolvedPath: 'm.py' })],
    })
    expect(result.callEdges[0]?.targetSymbolId).toBeNull()
  })
})

describe('resolveEdges: ladder hits and call side effects', () => {
  it('binds an imported callee with import_map provenance and forces direct dispatch', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('helper', 'utils.py', 'u1'),
      sym('run', 'app.py', 'r1'),
      sym('Company', 'app.py', 'c1'),
      sym('plain_fn', 'app.py', 'p1'),
    ])
    const resolver = createSymbolResolver({ catalog })
    const result = resolver.resolveEdges({
      callEdges: [
        callEdge({ filePath: 'app.py', calleeSymbol: 'helper', line: 3 }),
        callEdge({ filePath: 'app.py', calleeSymbol: 'obj.run', line: 4 }),
        callEdge({ filePath: 'app.py', calleeSymbol: 'obj.Company', line: 5 }),
        callEdge({ filePath: 'app.py', calleeSymbol: 'Company', line: 6 }),
        callEdge({ filePath: 'app.py', calleeSymbol: 'plain_fn', line: 7 }),
      ],
      symbolRefs: [],
      imports: [importRow({ filePath: 'app.py', importString: 'utils', resolvedPath: 'utils.py', importedName: 'helper' })],
    })

    const [imported, method, dottedCtor, plainCtor, local] = result.callEdges
    expect(imported).toMatchObject({
      targetSymbolId: 'sym:u1',
      targetFilePath: 'utils.py',
      calleeSymbolUid: 'u1',
      resolutionKind: 'scope_resolved',
      resolutionStrategy: 'import_map',
      resolutionConfidence: 0.85,
      dispatchKind: 'direct',
      callKind: 'imported',
    })
    // The global-unique hits classify per classify_call_kind's five branches:
    // dotted lowercase tail → method, dotted capitalized tail and plain
    // capitalized head → constructor, plain lowercase → local.
    expect(method).toMatchObject({
      targetSymbolId: 'sym:r1',
      resolutionKind: 'heuristic',
      resolutionStrategy: 'global_unique',
      dispatchKind: 'direct',
      callKind: 'method',
    })
    expect(dottedCtor).toMatchObject({ targetSymbolId: 'sym:c1', callKind: 'constructor' })
    expect(plainCtor).toMatchObject({ targetSymbolId: 'sym:c1', callKind: 'constructor' })
    expect(local).toMatchObject({ targetSymbolId: 'sym:p1', callKind: 'local' })
    expect(result.resolvedCallEdgeCount).toBe(5)
  })

  it('falls back to find-best with same-file and global provenance, without dispatch side effects', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('close_fn', 'app.py', 'a1'),
      sym('far_fn', 'lib/other.py', 'o1'),
    ])
    const resolver = createSymbolResolver({ catalog })
    const result = resolver.resolveEdges({
      callEdges: [
        callEdge({ filePath: 'app.py', calleeSymbol: 'close_fn' }),
        callEdge({ filePath: 'app.py', calleeSymbol: 'far_fn' }),
      ],
      symbolRefs: [],
      imports: [],
    })
    expect(result.callEdges[0]).toMatchObject({
      targetSymbolId: 'sym:a1',
      resolutionKind: 'scope_resolved',
      resolutionStrategy: 'same_file_fallback',
      resolutionConfidence: 0.9,
      dispatchKind: null,
      callKind: null,
    })
    expect(result.callEdges[1]).toMatchObject({
      targetSymbolId: 'sym:o1',
      resolutionKind: 'heuristic',
      resolutionStrategy: 'global_fallback',
      resolutionConfidence: 0.5,
    })
    expect(result.resolvedCallEdgeCount).toBe(2)
  })

  it('resolves symbol refs with refName precedence and the fallback kinds', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('close_fn', 'app.py', 'a1'),
      sym('far_fn', 'lib/other.py', 'o1'),
    ])
    const resolver = createSymbolResolver({ catalog })
    const result = resolver.resolveEdges({
      callEdges: [],
      symbolRefs: [
        symbolRef({ filePath: 'app.py', symbolName: 'ignored', refName: 'close_fn' }),
        symbolRef({ filePath: 'app.py', symbolName: 'far_fn' }),
      ],
      imports: [],
    })
    const [byRefName, byName] = result.symbolRefs
    expect(byRefName).toMatchObject({
      targetSymbolId: 'sym:a1',
      targetSymbolUid: 'a1',
      resolutionKind: 'scope_resolved',
      resolutionStrategy: 'same_file_fallback',
    })
    expect(byName).toMatchObject({
      targetSymbolId: 'sym:o1',
      targetSymbolUid: 'o1',
      resolutionKind: 'heuristic',
      resolutionStrategy: 'global_fallback',
    })
    expect(result.resolvedSymbolRefCount).toBe(2)
  })
})

describe('resolveEdges: type-catalog second pass', () => {
  it('backfills unresolved edges from type assigns (type_assign_receiver)', () => {
    const catalog = new SymbolCatalog()
    const symbols: SymbolRow[] = [
      { ...sym('parse', 'src/parser.py', 'uid:parser_parse', { kind: 'method', container: 'Parser', qname: 'Parser.parse', receiverType: 'Parser', paramCount: 1 }) },
      { ...sym('parse', 'src/validator.py', 'uid:validator_parse', { kind: 'method', container: 'Validator', qname: 'Validator.parse', receiverType: 'Validator', paramCount: 2 }) },
    ]
    catalog.addSymbols(symbols)
    catalog.buildTypeCatalog(symbols)
    const resolver = createSymbolResolver({ catalog })

    const result = resolver.resolveEdges({
      callEdges: [callEdge({ filePath: 'src/main.py', calleeSymbol: 'v.parse', receiverExpr: 'v' })],
      symbolRefs: [],
      imports: [],
      typeAssigns: [typeAssign('src/main.py', 'v', 'Validator')],
    })
    expect(result.callEdges[0]).toMatchObject({
      targetSymbolId: 'sym:uid:validator_parse',
      calleeSymbolUid: 'uid:validator_parse',
      resolutionKind: 'scope_resolved',
      resolutionStrategy: 'type_assign_receiver',
      resolutionConfidence: 0.90,
      parserConfidence: 0.90,
    })
  })

  it('upgrades a name-evidence result and records "{strategy}:upgraded_from={old}"', () => {
    const catalog = new SymbolCatalog()
    const symbols: SymbolRow[] = [
      { ...sym('parse', 'src/parser.py', 'uid:parser_parse', { kind: 'method', container: 'Parser', qname: 'Parser.parse', receiverType: 'Parser', paramCount: 1 }) },
      { ...sym('parse', 'src/validator.py', 'uid:validator_parse', { kind: 'method', container: 'Validator', qname: 'Validator.parse', receiverType: 'Validator', paramCount: 2 }) },
    ]
    catalog.addSymbols(symbols)
    catalog.buildTypeCatalog(symbols)
    const resolver = createSymbolResolver({ catalog })

    const preGlobalUnique: CallEdgeRow = callEdge({
      filePath: 'src/main.py',
      calleeSymbol: 'v.parse',
      receiverExpr: 'Validator',
      targetSymbolId: 'sym:uid:parser_parse',
      targetFilePath: 'src/parser.py',
      calleeSymbolUid: 'uid:parser_parse',
      resolutionKind: 'heuristic',
      resolutionConfidence: 0.75,
      resolutionStrategy: 'global_unique',
    })
    const result = resolver.resolveEdges({ callEdges: [preGlobalUnique], symbolRefs: [], imports: [] })
    expect(result.callEdges[0]).toMatchObject({
      calleeSymbolUid: 'uid:validator_parse',
      resolutionStrategy: 'receiver_type:upgraded_from=global_unique',
      resolutionConfidence: 0.95,
    })
  })

  it('never touches scope-proven results and keeps equal-confidence and same-target matches', () => {
    const catalog = new SymbolCatalog()
    const symbols: SymbolRow[] = [
      { ...sym('parse', 'src/parser.py', 'uid:parser_parse', { kind: 'method', container: 'Parser', qname: 'Parser.parse', receiverType: 'Parser', paramCount: 1 }) },
      { ...sym('parse', 'src/validator.py', 'uid:validator_parse', { kind: 'method', container: 'Validator', qname: 'Validator.parse', receiverType: 'Validator', paramCount: 2 }) },
    ]
    catalog.addSymbols(symbols)
    catalog.buildTypeCatalog(symbols)
    const resolver = createSymbolResolver({ catalog })

    const importProven = callEdge({
      filePath: 'src/main.py',
      calleeSymbol: 'v.parse',
      receiverExpr: 'Validator',
      targetSymbolId: 'sym:uid:parser_parse',
      calleeSymbolUid: 'uid:parser_parse',
      resolutionKind: 'scope_resolved',
      resolutionConfidence: 0.85,
      resolutionStrategy: 'import_map',
    })
    const equalConfidence = callEdge({
      filePath: 'src/main.py',
      calleeSymbol: 'v.parse',
      receiverExpr: 'Validator',
      targetSymbolId: 'sym:uid:parser_parse',
      calleeSymbolUid: 'uid:parser_parse',
      resolutionKind: 'heuristic',
      resolutionConfidence: 0.95,
      resolutionStrategy: 'global_unique',
    })
    const sameTarget = callEdge({
      filePath: 'src/main.py',
      calleeSymbol: 'v.parse',
      receiverExpr: 'Validator',
      targetSymbolId: 'sym:uid:validator_parse',
      calleeSymbolUid: 'uid:validator_parse',
      resolutionKind: 'heuristic',
      resolutionConfidence: 0.75,
      resolutionStrategy: 'global_unique',
    })
    const result = resolver.resolveEdges({ callEdges: [importProven, equalConfidence, sameTarget], symbolRefs: [], imports: [] })
    expect(result.callEdges[0]).toMatchObject({ resolutionStrategy: 'import_map', resolutionConfidence: 0.85 })
    // Equal confidence is not strictly greater: no upgrade.
    expect(result.callEdges[1]).toMatchObject({ resolutionStrategy: 'global_unique', resolutionConfidence: 0.95 })
    // Same target uid: no pointless rewrite.
    expect(result.callEdges[2]).toMatchObject({ resolutionStrategy: 'global_unique', resolutionConfidence: 0.75 })
  })
})

describe('resolveEdges: caller backfill and counts', () => {
  it('fills missing caller uids through find-best and leaves present ones alone', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('caller_fn', 'app.py', 'c1'),
      sym('callee_fn', 'app.py', 'e1'),
    ])
    const resolver = createSymbolResolver({ catalog })
    const result = resolver.resolveEdges({
      callEdges: [
        callEdge({ filePath: 'app.py', calleeSymbol: 'callee_fn', callerSymbol: 'caller_fn' }),
        callEdge({
          filePath: 'app.py',
          calleeSymbol: 'callee_fn',
          callerSymbol: 'known',
          callerSymbolUid: 'uid:known',
          callerSymbolId: 'sym:known',
          targetSymbolId: 'sym:e1',
          resolutionKind: 'scope_resolved',
          resolutionConfidence: 0.9,
          resolutionStrategy: 'parser_scope',
        }),
        callEdge({ filePath: 'app.py', calleeSymbol: 'callee_fn', callerSymbol: 'ghost' }),
      ],
      symbolRefs: [],
      imports: [],
    })
    expect(result.callEdges[0]).toMatchObject({ callerSymbolUid: 'c1', callerSymbolId: 'sym:c1' })
    expect(result.callEdges[1]).toMatchObject({ callerSymbolUid: 'uid:known' })
    expect(result.callEdges[2]).toMatchObject({ callerSymbolUid: null })
  })
})

describe('resolveEdges: lazy-load hook and per-file isolation', () => {
  it('loads the sorted distinct import targets once before resolving', () => {
    const catalog = new SymbolCatalog()
    const loader = vi.fn((files: readonly string[]) => {
      // A real loader populates the catalog for the requested files.
      catalog.addSymbols(files.map(file => sym(`${file.slice(0, 1)}_fn`, file, file)))
    })
    const resolver = createSymbolResolver({ catalog, loadSymbolsForFiles: loader })
    const result = resolver.resolveEdges({
      callEdges: [callEdge({ filePath: 'app.py', calleeSymbol: 'b_fn' })],
      symbolRefs: [],
      imports: [
        importRow({ filePath: 'app.py', importString: 'b', resolvedPath: 'b.py' }),
        importRow({ filePath: 'app.py', importString: 'a', resolvedPath: 'a.py' }),
        importRow({ filePath: 'app.py', importString: 'bare', resolvedPath: null }),
      ],
    })
    expect(loader).toHaveBeenCalledTimes(1)
    expect(loader).toHaveBeenCalledWith(['a.py', 'b.py'])
    expect(result.callEdges[0]).toMatchObject({ targetSymbolId: 'sym:b.py', resolutionStrategy: 'global_unique' })
  })

  it('never calls an absent loader and skips the hook when imports resolve nothing', () => {
    const catalog = new SymbolCatalog()
    const loader = vi.fn()
    const resolver = createSymbolResolver({ catalog, loadSymbolsForFiles: loader })
    resolver.resolveEdges({ callEdges: [], symbolRefs: [], imports: [] })
    resolver.resolveEdges({
      callEdges: [],
      symbolRefs: [],
      imports: [importRow({ filePath: 'a.py', importString: 'bare', resolvedPath: null })],
    })
    expect(loader).not.toHaveBeenCalled()
  })

  it('isolates imports per file in one request', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([
      sym('shared', 'x.py', 'x1'),
      sym('shared', 'y.py', 'y1'),
    ])
    const resolver = createSymbolResolver({ catalog })
    const result = resolver.resolveEdges({
      callEdges: [
        callEdge({ filePath: 'calls_x.py', calleeSymbol: 'shared' }),
        callEdge({ filePath: 'calls_y.py', calleeSymbol: 'shared' }),
      ],
      symbolRefs: [],
      imports: [
        importRow({ filePath: 'calls_x.py', importString: 'x', resolvedPath: 'x.py', importedName: 'shared' }),
        importRow({ filePath: 'calls_y.py', importString: 'y', resolvedPath: 'y.py', importedName: 'shared' }),
      ],
    })
    expect(result.callEdges[0]).toMatchObject({ targetSymbolId: 'sym:x1', resolutionStrategy: 'import_map' })
    expect(result.callEdges[1]).toMatchObject({ targetSymbolId: 'sym:y1', resolutionStrategy: 'import_map' })
    expect(result.resolvedCallEdgeCount).toBe(2)
  })

  it('runs the scope-binding step through the request scopes interface', () => {
    const catalog = new SymbolCatalog()
    catalog.addSymbols([sym('local_target', 'main.py', 'm1')])
    const resolver = createSymbolResolver({ catalog })
    const result = resolver.resolveEdges({
      callEdges: [callEdge({ filePath: 'main.py', calleeSymbol: 'local_var', line: 5 })],
      symbolRefs: [],
      imports: [],
      scopes: [{
        scopeId: 's1',
        parentId: null,
        name: 's1',
        filePath: 'main.py',
        startLine: 1,
        endLine: 10,
        bindings: [{ name: 'local_var', kind: 'variable', symbolUid: 'm1' }],
      }],
    })
    expect(result.callEdges[0]).toMatchObject({
      targetSymbolId: 'sym:m1',
      resolutionKind: 'scope_resolved',
      resolutionStrategy: 'scope',
      resolutionConfidence: 0.9,
    })
  })

  it('exposes its catalog', () => {
    const catalog = new SymbolCatalog()
    expect(createSymbolResolver({ catalog }).catalog).toBe(catalog)
  })
})

describe('resolveEdges: symbol ref gates', () => {
  it('keeps a ref that already carries a target and backfills defaults only', () => {
    const resolver = createSymbolResolver({ catalog: new SymbolCatalog() })
    const bound: SymbolRefRow = symbolRef({
      filePath: 'a.py',
      symbolName: 'fn',
      targetSymbolId: 'sym:t',
      targetSymbolUid: 'uid:t',
      resolutionKind: 'heuristic',
      resolutionConfidence: 0,
      resolutionStrategy: '',
    })
    const result = resolver.resolveEdges({ callEdges: [], symbolRefs: [bound], imports: [] })
    expect(result.symbolRefs[0]).toMatchObject({
      targetSymbolId: 'sym:t',
      resolutionConfidence: 0.5,
      resolutionStrategy: 'heuristic',
    })
    expect(result.resolvedSymbolRefCount).toBe(0)
  })
})
