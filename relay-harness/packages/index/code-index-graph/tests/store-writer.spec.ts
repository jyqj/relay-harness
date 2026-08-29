import { describe, expect, it } from 'vitest'
import type { ParseOutcome } from '@relay-harness/rlh-code-index-parser'
import type { ParserTier } from '@relay-harness/rlh-code-index'
import { buildGraphDelta, graphRowsForOutcome } from '../src/store/writer.ts'

const TIER: ParserTier = 'tree-sitter'

/** One outcome exercising every parser record kind with every field set. */
function richOutcome(): ParseOutcome {
  return {
    language: 'typescript',
    parserTier: TIER,
    parserConfidence: 0.8,
    symbols: [{
      symbolId: 'sym:app:sayHi',
      filePath: 'src/app.ts',
      name: 'sayHi',
      kind: 'function',
      container: 'Greeter',
      startLine: 3,
      endLine: 9,
      startCol: 2,
      endCol: 30,
      signature: 'function sayHi(who: string): string',
      parserTier: TIER,
      parserConfidence: 0.8,
      qname: 'Greeter.sayHi',
      parentSymbolId: null,
      exportName: 'sayHi',
      isDefaultExport: false,
      symbolUid: 'uid:app:sayHi',
      frameworkRole: null,
      receiverType: 'Greeter',
      paramTypes: 'string',
      returnType: 'string',
      paramCount: 1,
    }],
    imports: [{
      filePath: 'src/app.ts',
      importString: './lib',
      resolvedPath: 'src/lib.ts',
      importedName: 'sayHi',
      alias: null,
      isNamespace: false,
      isDefault: false,
      isReexport: false,
    }],
    callEdges: [{
      edgeId: 'call:app:1',
      filePath: 'src/app.ts',
      callerSymbol: 'run',
      calleeSymbol: 'sayHi',
      line: 12,
      startCol: 4,
      endLine: 12,
      endCol: 18,
      callerSymbolUid: 'uid:app:run',
      dispatchKind: 'direct',
      callKind: 'member',
      receiverExpr: 'greeter',
      argCount: 1,
      isOptionalChain: true,
      isAwaited: true,
      isConstructor: false,
      parserTier: TIER,
      parserConfidence: 0.8,
    }],
    symbolRefs: [],
    literals: [{
      literalId: 'lit:app:1',
      filePath: 'src/app.ts',
      literal: 'GET',
      line: 15,
      container: 'run',
      enclosingSymbolUid: 'uid:app:run',
    }],
    isTestFile: false,
    summary: 'src/app.ts (typescript, 20 lines, 1 symbols)',
    contentExcerpt: 'export function run() {}',
    parseErrors: [],
    parseErrorCount: 0,
  }
}

describe('buildGraphDelta', () => {
  it('maps every parser record onto its store row position with explicit nulls', () => {
    const delta = buildGraphDelta(new Map([['src/app.ts', richOutcome()]]))
    const rows = delta.byFile.get('src/app.ts')
    expect(rows).toBeDefined()
    // Columns the parser does not produce are explicit nulls, never absent.
    expect(rows!.symbols).toEqual([{
      symbolId: 'sym:app:sayHi',
      filePath: 'src/app.ts',
      name: 'sayHi',
      kind: 'function',
      container: 'Greeter',
      startLine: 3,
      endLine: 9,
      startCol: 2,
      endCol: 30,
      signature: 'function sayHi(who: string): string',
      doc: null,
      parserTier: TIER,
      parserConfidence: 0.8,
      qname: 'Greeter.sayHi',
      parentSymbolId: null,
      exportName: 'sayHi',
      isDefaultExport: false,
      symbolUid: 'uid:app:sayHi',
      frameworkRole: null,
      receiverType: 'Greeter',
      paramTypes: 'string',
      returnType: 'string',
      paramCount: 1,
      baseTypes: null,
      implements: null,
    }])
    expect(rows!.imports).toEqual([{
      filePath: 'src/app.ts',
      importString: './lib',
      resolvedPath: 'src/lib.ts',
      importedName: 'sayHi',
      alias: null,
      isNamespace: false,
      isDefault: false,
      isReexport: false,
    }])
    // Fresh parse edges carry pristine resolution defaults and no targets.
    expect(rows!.callEdges).toEqual([{
      edgeId: 'call:app:1',
      filePath: 'src/app.ts',
      callerSymbol: 'run',
      calleeSymbol: 'sayHi',
      line: 12,
      startCol: 4,
      targetSymbolId: null,
      targetFilePath: null,
      callerSymbolId: null,
      callerSymbolUid: 'uid:app:run',
      calleeSymbolUid: null,
      dispatchKind: 'direct',
      callKind: 'member',
      resolutionKind: 'unresolved',
      resolutionConfidence: 0,
      resolutionStrategy: '',
      receiverExpr: 'greeter',
      argCount: 1,
      isOptionalChain: true,
      isAwaited: true,
      isConstructor: false,
      parserTier: TIER,
      parserConfidence: 0.8,
    }])
    expect(rows!.literals).toEqual([{
      literalId: 'lit:app:1',
      filePath: 'src/app.ts',
      literal: 'GET',
      literalKind: null,
      line: 15,
      container: 'run',
      confidence: null,
      enclosingSymbolUid: 'uid:app:run',
    }])
    // Refs are not parsed this phase; test edges belong to the rebuild pass.
    expect(rows!.symbolRefs).toEqual([])
    expect(rows!.testEdges).toEqual([])
    // Export fingerprints are caller-computed, so the delta carries none.
    expect(rows!.exportFingerprint).toBeUndefined()
  })

  it('keys one delta entry per outcome and accepts an empty batch', () => {
    const outcome = richOutcome()
    const delta = buildGraphDelta(new Map([['src/renamed.ts', outcome], ['src/other.ts', outcome]]))
    expect([...delta.byFile.keys()]).toEqual(['src/renamed.ts', 'src/other.ts'])
    expect(graphRowsForOutcome(outcome)).toEqual(delta.byFile.get('src/renamed.ts'))
    expect(buildGraphDelta(new Map())).toEqual({ byFile: new Map(), duplicatesDropped: 0 })
  })

  it('drops same-key repeats keeping the first row and counts them', () => {
    const outcome = richOutcome()
    const repeated = {
      ...outcome,
      // Same-key overload pair: same uid, distinct spans — second loses.
      symbols: [
        outcome.symbols[0]!,
        { ...outcome.symbols[0]!, symbolId: 'sym:app:sayHi2', startLine: 40, endLine: 44 },
      ],
      // Same-position repeat: same edge and literal ids — seconds lose.
      callEdges: [outcome.callEdges[0]!, { ...outcome.callEdges[0]!, calleeSymbol: 'other' }],
      literals: [outcome.literals[0]!, { ...outcome.literals[0]!, literal: 'POST' }],
    }
    const delta = buildGraphDelta(new Map([['src/app.ts', repeated]]))
    const rows = delta.byFile.get('src/app.ts')!
    expect(rows.symbols).toHaveLength(1)
    expect(rows.symbols[0]!.symbolId).toBe('sym:app:sayHi')
    expect(rows.callEdges).toHaveLength(1)
    expect(rows.callEdges[0]!.calleeSymbol).toBe('sayHi')
    expect(rows.literals).toHaveLength(1)
    expect(rows.literals[0]!.literal).toBe('GET')
    expect(delta.duplicatesDropped).toBe(3)
    // The entry stays equal to what graphRowsForOutcome derives for the file.
    expect(graphRowsForOutcome(repeated)).toEqual(rows)
  })

  it('keeps distinct symbols sharing nothing and repeats the count across files', () => {
    const outcome = richOutcome()
    const withUidPair = {
      ...outcome,
      // Same uid again (same-key pair), but graphRowsForOutcome still maps it.
      symbols: [
        outcome.symbols[0]!,
        { ...outcome.symbols[0]!, symbolId: 'sym:app:sayHi2', startLine: 40 },
      ],
    }
    const delta = buildGraphDelta(new Map([['a.ts', withUidPair], ['b.ts', withUidPair]]))
    expect(delta.duplicatesDropped).toBe(2)
    expect(graphRowsForOutcome(withUidPair).symbols).toHaveLength(1)
  })
})
