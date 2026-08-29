import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { chunkWithSymbols } from '../src/chunker.ts'
import { parseFile } from '../src/index.ts'
import { extractJsts } from '../src/languages/jsts/index.ts'
import type { SymbolRecord } from '../src/types.ts'

const root = mkdtempSync(join(tmpdir(), 'rlh-parser-walker-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const OPTIONS = { projectRoot: root, maxFileBytes: 512_000 }

function bareSymbol(name: string, startLine: number, endLine: number): SymbolRecord {
  return {
    symbolId: `sym:${name}`,
    filePath: 'f.ts',
    name,
    kind: 'function',
    container: null,
    startLine,
    endLine,
    startCol: 0,
    endCol: 0,
    signature: null,
    parserTier: 'semantic',
    parserConfidence: 0.85,
    qname: name,
    parentSymbolId: null,
    exportName: null,
    isDefaultExport: false,
    symbolUid: `uid:${name}`,
    frameworkRole: null,
    receiverType: null,
    paramTypes: null,
    returnType: null,
    paramCount: null,
  }
}

describe('walker branch coverage', () => {
  it('walks generator function declarations and nested functions', async () => {
    const code = 'function* gen() {\n  yield 1;\n}\nfunction outer() {\n  function inner() {}\n}\n'
    const outcome = await parseFile('src/gen.ts', code, OPTIONS)
    expect(outcome!.symbols.find(sym => sym.name === 'gen')).toMatchObject({ kind: 'function' })
    // A nested declaration inherits its parent as container (reference behavior).
    expect(outcome!.symbols.find(sym => sym.name === 'inner')).toMatchObject({ kind: 'method', container: 'outer' })
  })

  it('handles object-literal methods and nameless error-recovered members', async () => {
    const outcome = await extractJsts('obj.js', 'const o = {\n  run() { go(); }\n};', 'javascript')
    // Object methods are reached through the generic walk with no container.
    expect(outcome.symbols.find(sym => sym.name === 'run')).toMatchObject({ kind: 'method', container: null })
    expect(outcome.callEdges.some(edge => edge.calleeSymbol === 'go')).toBe(true)

    // Error recovery: a nameless class member still yields a record, with
    // the empty recovered name (reference behavior).
    const broken = await extractJsts('broken.js', 'class A { () { x(); } }', 'javascript')
    expect(broken.symbols.find(sym => sym.kind === 'method')).toMatchObject({ name: '', container: 'A' })
  })

  it('handles class fields: arrow, concise arrow, plain values, and nameless fields', async () => {
    const outcome = await extractJsts('fields.js', [
      'class A {',
      '  handle = () => { this.run(); }',
      '  concise = () => value();',
      '  count = initCount();',
      '  ;',
      '}',
    ].join('\n'), 'javascript')
    const names = outcome.symbols.map(sym => sym.name)
    expect(names).toContain('A')
    expect(names).toContain('handle')
    expect(outcome.callEdges.some(edge => edge.calleeSymbol === 'this.run')).toBe(true)
    expect(outcome.callEdges.some(edge => edge.calleeSymbol === 'value')).toBe(true)
    expect(outcome.callEdges.some(edge => edge.calleeSymbol === 'initCount')).toBe(true)

    // A field the grammar cannot even name is skipped without crashing.
    const nameless = await extractJsts('nameless.js', 'class B { = 5 }', 'javascript')
    expect(nameless.symbols.map(sym => sym.name)).toEqual(['B'])
  })

  it('marks NestJS route decorators and ignores other decorators', async () => {
    const code = 'class Users {\n  @Get(\'/users\')\n  list() { return []; }\n\n  @Injectable\n  other() {}\n}\n'
    const outcome = await parseFile('src/users.ts', code, OPTIONS)
    expect(outcome!.symbols.find(sym => sym.name === 'list')!.frameworkRole).toBe('route_handler')
    expect(outcome!.symbols.find(sym => sym.name === 'other')!.frameworkRole).toBeNull()
  })

  it('classifies optional chains, IIFE callees, keyword callees, and constructor skips', async () => {
    const code = [
      'function t() {',
      '  a?.b();',
      '  (function iife() {})();',
      '  return foo()();',
      '}',
      'class Child extends Parent {',
      '  constructor() { super(); }',
      '  c() { super.c(); }',
      '  make() { const t = new this(); return t; }',
      '}',
    ].join('\n')
    const outcome = await extractJsts('mix.js', code, 'javascript')
    expect(outcome.callEdges.find(edge => edge.calleeSymbol === 'a.b'))
      .toMatchObject({ dispatchKind: 'optional_chain', isOptionalChain: true })
    // The IIFE callee is a parenthesized function, not member/identifier/call.
    expect(outcome.callEdges.some(edge => edge.calleeSymbol === 'iife')).toBe(true)
    expect(outcome.callEdges.some(edge => edge.calleeSymbol === 'foo')).toBe(true)
    // A member callee over a reserved receiver still records (`super.c`);
    // a bare keyword callee skips (cc's `super()` guard).
    expect(outcome.callEdges.some(edge => edge.calleeSymbol === 'super.c')).toBe(true)
    expect(outcome.callEdges.filter(edge => edge.isConstructor)).toEqual([])
  })

  it('records constructor calls, awaited calls, and twice-bound imports', async () => {
    const code = [
      'import { a } from \'./m\';',
      'import { a } from \'./n\';',
      'class Q {}',
      'async function go() {',
      '  const q = new Q();',
      '  await worker.run();',
      '  await plain();',
      '  return q;',
      '}',
    ].join('\n')
    const outcome = await parseFile('src/ctor.ts', code, OPTIONS)
    expect(outcome!.callEdges.find(edge => edge.calleeSymbol === 'Q')).toMatchObject({ isConstructor: true, dispatchKind: 'constructor' })
    expect(outcome!.callEdges.find(edge => edge.calleeSymbol === 'worker.run')).toMatchObject({ isAwaited: true })
    expect(outcome!.callEdges.find(edge => edge.calleeSymbol === 'plain')).toMatchObject({ isAwaited: true })
  })

  it('handles named function expressions, including already-registered ones', async () => {
    const code = [
      'const handler = function onEvent(ev) {',
      '  react(ev);',
      '};',
      'timer(function tick() {',
      '  tock();',
      '});',
      'timer(function () {',
      '  anonymous();',
      '});',
    ].join('\n')
    const outcome = await extractJsts('fns.js', code, 'javascript')
    // The declarator registered `onEvent` first; the expression walk adopts it.
    expect(outcome.symbols.filter(sym => sym.name === 'onEvent')).toHaveLength(1)
    // A fresh named function expression registers under its own name.
    expect(outcome.symbols.find(sym => sym.name === 'tick')).toBeDefined()
    // Anonymous function expressions just recurse.
    expect(outcome.callEdges.some(edge => edge.calleeSymbol === 'anonymous')).toBe(true)
  })

  it('resolves export-from variants and namespace/default import bindings', async () => {
    mkdirSync(root, { recursive: true })
    const code = [
      'export * from \'./star\';',
      'export { alpha as beta } from \'./named\';',
      'export { alpha } from \'./named\';',
      'import def, { named } from \'./mod\';',
      'import * as ns from \'./nsmod\';',
      'export { named };',
      'export default def;',
      'export { ns };',
      'export { ghost };',
      'function solo() {}',
      'export default solo;',
      'function dup() { return 1; }',
      'function dup() { return 2; }',
    ].join('\n')
    const outcome = await parseFile('src/barrel.ts', code, OPTIONS)
    const imports = outcome!.imports
    expect(imports.find(imp => imp.importString === './star')).toMatchObject({
      isNamespace: true,
      isReexport: true,
      importedName: null,
    })
    expect(imports.find(imp => imp.importString === './named' && imp.alias === 'beta')).toMatchObject({
      isReexport: true,
      importedName: 'alpha',
    })
    expect(imports.filter(imp => imp.importString === './named')).toHaveLength(2)
    // Two-step forwarding marks each originating import as a re-export.
    expect(imports.find(imp => imp.importString === './mod')).toMatchObject({ isReexport: true })
    expect(imports.find(imp => imp.importString === './nsmod')).toMatchObject({ isReexport: true })
    // An export binding nothing resolves to is silently ignored.
    expect(outcome!.symbols.every(sym => sym.name !== 'ghost')).toBe(true)
    // `export default solo` flags the symbol even without a named export;
    // the default application fills the export name from the symbol itself.
    expect(outcome!.symbols.find(sym => sym.name === 'solo')).toMatchObject({
      isDefaultExport: true,
      exportName: 'solo',
    })
  })

  it('classifies component-like ALL-CAPS names as non-components and function middleware', async () => {
    const code = 'function MY_CONST() { return 1; }\nfunction requestMiddleware(next) { return next; }\n'
    const outcome = await parseFile('src/roles.ts', code, OPTIONS)
    expect(outcome!.symbols.find(sym => sym.name === 'MY_CONST')!.frameworkRole).toBeNull()
    expect(outcome!.symbols.find(sym => sym.name === 'requestMiddleware')!.frameworkRole).toBe('middleware')
  })

  it('annotated and truncated declarations surface parameter and return types', async () => {
    const outcome = await parseFile('src/ann.ts', 'function annotated(a: string, b: Date): string {\n  return a;\n}\n', OPTIONS)
    expect(outcome!.symbols.find(sym => sym.name === 'annotated')).toMatchObject({
      paramTypes: 'string, Date',
      returnType: 'string',
      paramCount: 2,
    })
  })

  it('handles malformed imports and exports without crashing', async () => {
    const badImport = await extractJsts('bad-imp.js', 'import something;', 'javascript')
    expect(badImport.imports).toEqual([])
  })

  it('adopts already-registered named function expressions inside bodies', async () => {
    // Inside a body the expression walk registers the named function first;
    // the declarator's RHS visit then adopts the existing record.
    const outcome = await extractJsts('adopt.js', [
      'function outer() {',
      '  const handler = function onEvent(ev) {',
      '    react(ev);',
      '  };',
      '  return handler;',
      '}',
    ].join('\n'), 'javascript')
    expect(outcome.symbols.filter(sym => sym.name === 'onEvent')).toHaveLength(1)
  })

  it('covers awaited non-call values and short templates', async () => {
    const code = [
      'async function go() {',
      '  await later;',
      '  const t = `ab`;',
      '  return t;',
      '}',
    ].join('\n')
    const outcome = await extractJsts('await-val.js', code, 'javascript')
    expect(outcome.literals.map(lit => lit.literal)).not.toContain('ab')
  })

  it('walks exported declarations through the export visitor flags', async () => {
    const code = [
      'export class Repo {}',
      'export function fetchAll() { return []; }',
      'export const limit = 10;',
      'export default function main() {}',
    ].join('\n')
    const outcome = await parseFile('src/exported.ts', code, OPTIONS)
    expect(outcome!.symbols.find(sym => sym.name === 'Repo')).toMatchObject({ exportName: 'Repo' })
    expect(outcome!.symbols.find(sym => sym.name === 'fetchAll')).toMatchObject({ exportName: 'fetchAll' })
    expect(outcome!.symbols.find(sym => sym.name === 'limit')).toMatchObject({ exportName: 'limit' })
    expect(outcome!.symbols.find(sym => sym.name === 'main')).toMatchObject({ exportName: 'main', isDefaultExport: true })
  })

  it('handles error-recovered declarations and require variants', async () => {
    const outcome = await extractJsts('req.js', [
      'const { A, B } = require(\'./pair\');',
      'const { C: sea } = require(\'./aliased\');',
      'const { ...rest } = require(\'./rest\');',
      'const plain = notRequire(\'./x\');',
      'const dynamic = require(moduleName);',
      'const noValue;',
      'const [ soloPattern ];',
    ].join('\n'), 'javascript')
    const imports = outcome.imports
    expect(imports.find(imp => imp.importedName === 'A')).toMatchObject({ importString: './pair', isNamespace: false })
    expect(imports.find(imp => imp.importedName === 'C')).toMatchObject({ alias: 'sea', importString: './aliased' })
    // Non-require calls, non-string arguments, and valueless declarators
    // produce nothing extra.
    expect(imports.filter(imp => imp.importedName === 'plain')).toEqual([])
    expect(imports.filter(imp => imp.importedName === 'dynamic')).toEqual([])
    // Pattern-named declarators still yield verbatim-named variable symbols
    // (reference behavior), while valueless ones yield nothing.
    const variableNames = outcome.symbols.filter(sym => sym.kind === 'variable').map(sym => sym.name)
    expect(variableNames).toContain('plain')
    expect(variableNames).toContain('dynamic')
    expect(variableNames).toContain('{ A, B }')
  })

  it('adopts bodyless named function expressions without crashing', async () => {
    const outcome = await extractJsts('no-body-fn.js', [
      'function outer2() {',
      '  const h = function noBody();',
      '  return h;',
      '}',
    ].join('\n'), 'javascript')
    // The point is the walk completing over the error-recovered bodyless
    // function expression without throwing.
    expect(outcome.symbols.find(sym => sym.name === 'outer2')).toBeDefined()
  })

  it('isolates error-recovered declarators per input', async () => {
    // A valueless declarator still yields a variable symbol (reference behavior).
    const valueless = await extractJsts('valueless.js', 'const noValue;', 'javascript')
    expect(valueless.symbols).toHaveLength(1)
    expect(valueless.symbols[0]).toMatchObject({ name: 'noValue', kind: 'variable' })
    const noArgs = await extractJsts('no-args.js', 'const r = require();', 'javascript')
    expect(noArgs.imports).toEqual([])
  })

  it('keeps empty param type annotations out of paramTypes', async () => {
    const outcome = await parseFile('src/empty-ann.ts', 'function g(a:): string {\n  return a;\n}\n', OPTIONS)
    expect(outcome!.symbols.find(sym => sym.name === 'g')).toMatchObject({ paramTypes: null, paramCount: 1, returnType: 'string' })
  })

  it('falls back to line chunks for symbol-free files', async () => {
    const outcome = await parseFile('src/empty.js', '// just a comment\n', OPTIONS)
    expect(outcome!.symbols).toEqual([])
    expect(outcome!.contentExcerpt).toBe('// just a comment')
  })
})

describe('chunker trailing-gap branch', () => {
  it('drops a trailing all-blank gap after the last symbol', () => {
    const chunks = chunkWithSymbols({
      filePath: 'm.ts',
      content: 'function a() {}\n\n\n',
      language: 'typescript',
      parserTier: 'semantic',
      parserConfidence: 0.85,
      symbols: [bareSymbol('a', 1, 1)],
    })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.endLine).toBe(1)
  })
})
