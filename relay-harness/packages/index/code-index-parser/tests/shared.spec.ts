import { describe, expect, it } from 'vitest'
import { Parser } from 'web-tree-sitter'
import { mergeCallEdges } from '../src/shared/call-merge.ts'
import { argumentLikeChildren, childAt, childByKind, countArgs, fieldOf, firstStringChildText, nthArgNode, stripQuotes } from '../src/shared/cursor.ts'
import type { Node as TsNode } from 'web-tree-sitter'
import { JS_KEYWORDS, qualify } from '../src/shared/identifiers.ts'
import type { CallEdgeRecord } from '../src/types.ts'
import { initParser, loadLanguage } from '../src/loader.ts'

async function parseJavaScript(code: string) {
  await initParser()
  const parser = new Parser()
  parser.setLanguage(await loadLanguage('javascript'))
  const tree = parser.parse(code)
  return { tree, parser }
}

function edge(line: number, startCol: number, callee: string): CallEdgeRecord {
  return {
    edgeId: `call:${callee}:${line}:${startCol}`,
    filePath: 'a.js',
    callerSymbol: null,
    calleeSymbol: callee,
    line,
    startCol,
    endLine: line,
    endCol: startCol,
    callerSymbolUid: null,
    dispatchKind: 'direct',
    callKind: 'direct',
    receiverExpr: null,
    argCount: null,
    isOptionalChain: false,
    isAwaited: false,
    isConstructor: false,
    parserTier: 'semantic',
    parserConfidence: 0.85,
  }
}

describe('shared cursor helpers', () => {
  it('finds children by kind including anonymous nodes', async () => {
    const { tree, parser } = await parseJavaScript('foo(1, 2)')
    const call = tree!.rootNode.namedChildren[0]!.namedChildren[0]!
    expect(call.type).toBe('call_expression')
    expect(childByKind(call, 'arguments')).not.toBeNull()
    expect(childByKind(call, 'missing')).toBeNull()
    const args = childByKind(call, 'arguments')!
    // `(`, `1`, `,`, `2`, `)` — punctuation included in the child list.
    expect(args.childCount).toBe(5)
    expect(argumentLikeChildren(args)).toHaveLength(2)
    expect(nthArgNode(call, 0)!.text).toBe('1')
    expect(nthArgNode(call, 1)!.text).toBe('2')
    expect(nthArgNode(call, 2)).toBeNull()
    // A node without an arguments child has no nth argument.
    expect(nthArgNode(call.namedChildren[0]!, 0)).toBeNull()
    expect(countArgs(call)).toBe(2)
    // A call whose arguments node is absent counts zero (identifier node).
    expect(countArgs(call.namedChildren[0]!)).toBe(0)
    parser.delete()
    tree!.delete()
  })

  it('reads and strips module specifier strings', async () => {
    const { tree, parser } = await parseJavaScript('import x from "./mod"')
    const statement = tree!.rootNode.namedChildren[0]!
    expect(firstStringChildText(statement)).toBe('./mod')
    expect(firstStringChildText(statement.namedChildren[0]!)).toBeNull()
    expect(stripQuotes('"a\'`b"')).toBe('a\'`b')
    parser.delete()
    tree!.delete()
  })
})

describe('contract-violation guards', () => {
  it('childAt and fieldOf throw on stub nodes missing the expected shape', () => {
    const stub = { child: () => null, childForFieldName: () => null, type: 'stub' } as unknown as TsNode
    expect(() => childAt(stub, 0)).toThrow("node 'stub' has no child at index 0")
    expect(() => fieldOf(stub, 'name')).toThrow("node 'stub' has no field 'name'")
  })
})

describe('shared call merge', () => {
  it('keeps AST edges and drops fallback duplicates by (line, startCol)', () => {
    const ast = [edge(3, 4, 'astOnly'), edge(5, 0, 'shared')]
    const fallback = [edge(5, 0, 'dup'), edge(7, 2, 'fallbackOnly')]
    const merged = mergeCallEdges(ast, fallback)
    expect(merged.map(e => e.calleeSymbol)).toEqual(['astOnly', 'shared', 'fallbackOnly'])
    // Inputs untouched.
    expect(ast).toHaveLength(2)
    expect(fallback).toHaveLength(2)
  })
})

describe('shared identifiers', () => {
  it('qualifies names under a container and passes top-level names through', () => {
    expect(qualify('Foo', 'bar')).toBe('Foo.bar')
    expect(qualify(null, 'bar')).toBe('bar')
  })

  it('carries the reference reserved-word table', () => {
    expect(JS_KEYWORDS.has('function')).toBe(true)
    expect(JS_KEYWORDS.has('undefined')).toBe(true)
    expect(JS_KEYWORDS.has('constructor')).toBe(false)
    expect(JS_KEYWORDS.size).toBe(41)
  })
})
