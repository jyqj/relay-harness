import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseFile } from '../src/index.ts'
import { symbolUid } from '../src/id.ts'
import { extractSpecDriven, HEURISTIC_CONFIDENCE } from '../src/languages/spec-driven/index.ts'
import type { SpecDrivenLanguage } from '../src/languages/spec-driven/table.ts'
import { CALL_KEYWORD_BLOCKLIST, CALL_SITE_RE, SPEC_TABLE, specForLanguage } from '../src/languages/spec-driven/table.ts'

const root = mkdtempSync(join(tmpdir(), 'rlh-parser-specdriven-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const OPTIONS = { projectRoot: root, maxFileBytes: 512_000 }

/**
 * Extraction assertions trimmed relative to the reference implementation's
 * embedded tests, because this package's record vocabulary is narrower:
 * - exact confidence `0.5` replaces the reference's `> 0.3` band;
 * - `callee_symbol_uid.is_some()` / resolution-kind assertions have no
 *   counterpart field — every emitted edge is intra-file resolved by
 *   construction (unresolved callees never emit), so edge presence is the
 *   equivalent claim;
 * - the reference summary's `via <grammar>` tag has no counterpart (the
 *   package's summary format owns that surface);
 * - C# `Environment.GetEnvironmentVariable` data-flow edges are out of scope
 *   for this phase (no data-flow records in the package vocabulary).
 */
function extract(language: SpecDrivenLanguage, filePath: string, content: string) {
  return extractSpecDriven(language, filePath, content)
}

describe('spec-driven table', () => {
  it('carries the reference metadata verbatim for all eight languages', () => {
    expect(SPEC_TABLE.map(spec => [
      spec.language,
      spec.grammarName,
      [...spec.extensions],
      spec.qnameSeparator,
    ])).toEqual([
      ['csharp', 'c_sharp', ['cs'], '.'],
      ['php', 'php', ['php'], '\\'],
      ['ruby', 'ruby', ['rb', 'rake'], '::'],
      ['swift', 'swift', ['swift'], '.'],
      ['kotlin', 'kotlin', ['kt', 'kts'], '.'],
      ['dart', 'dart', ['dart'], '.'],
      ['scala', 'scala', ['scala', 'sc'], '.'],
      ['lua', 'lua', ['lua', 'luau'], '.'],
    ])
  })

  it('looks up rows by language and rejects non-spec-driven languages', () => {
    expect(specForLanguage('csharp')?.language).toBe('csharp')
    expect(specForLanguage('lua')?.extensions).toEqual(['lua', 'luau'])
    expect(specForLanguage('python')).toBeUndefined()
    expect(specForLanguage('vue')).toBeUndefined()
  })

  it('covers every listed extension and names every row', () => {
    for (const spec of SPEC_TABLE) {
      expect(spec.extensions.length).toBeGreaterThan(0)
      expect(spec.grammarName.length).toBeGreaterThan(0)
      expect(specForLanguage(spec.language)).toBe(spec)
    }
  })

  it('blocks exactly the reference control-flow keyword list', () => {
    expect(CALL_KEYWORD_BLOCKLIST.size).toBe(68)
    for (const keyword of ['if', 'while', 'for', 'match', 'return', 'new', 'require', 'self', 'echo']) {
      expect(CALL_KEYWORD_BLOCKLIST.has(keyword)).toBe(true)
    }
  })

  it('captures the qualified receiver and the bare callee of a call site', () => {
    const dotted = CALL_SITE_RE.exec('ctx.repo.find(id)')
    expect(dotted?.[1]).toBe('ctx.repo')
    expect(dotted?.[2]).toBe('find')
    CALL_SITE_RE.lastIndex = 0
    const scoped = CALL_SITE_RE.exec('Foo::bar(x)')
    expect(scoped?.[1]).toBe('Foo')
    expect(scoped?.[2]).toBe('bar')
    CALL_SITE_RE.lastIndex = 0
    const arrow = CALL_SITE_RE.exec('self ->run()')
    expect(arrow?.[1]).toBe('self')
    expect(arrow?.[2]).toBe('run')
  })
})

describe('reference extraction cases', () => {
  it('csharp: extracts class, methods, using import, and the dotted qname', () => {
    const content = [
      '',
      'using System;',
      '',
      'namespace MyApp.Services',
      '{',
      '    public class UserService',
      '    {',
      '        public async Task<User> GetUser(int id)',
      '        {',
      '            return await _repo.Find(id);',
      '        }',
      '',
      '        private void Validate(User user)',
      '        {',
      '            // validation',
      '        }',
      '    }',
      '}',
    ].join('\n')
    const outcome = extract('csharp', 'UserService.cs', content)
    expect(outcome.symbols.find(sym => sym.name === 'UserService')).toMatchObject({
      kind: 'class',
      container: 'MyApp.Services',
      qname: 'MyApp.Services.UserService',
      startLine: 6,
      endLine: 17,
      parserTier: 'heuristic',
      parserConfidence: HEURISTIC_CONFIDENCE,
    })
    const methods = outcome.symbols.filter(sym => sym.kind === 'method')
    expect(methods.map(sym => sym.name)).toEqual(['GetUser', 'Validate'])
    expect(methods[0]).toMatchObject({ startLine: 8, endLine: 11 })
    expect(outcome.imports).toEqual([{
      filePath: 'UserService.cs',
      importString: 'System',
      resolvedPath: null,
      importedName: null,
      alias: null,
      isNamespace: false,
      isDefault: false,
      isReexport: false,
    }])
  })

  it('ruby: extracts class, defs, requires, and end-delimited spans', () => {
    const content = [
      '',
      "require 'json'",
      "require_relative 'base_service'",
      '',
      'class UserService',
      '  def initialize(repo)',
      '    @repo = repo',
      '  end',
      '',
      '  def find_user(id)',
      '    @repo.find(id)',
      '  end',
      '',
      '  def self.create(params)',
      '    new(params)',
      '  end',
      'end',
    ].join('\n')
    const outcome = extract('ruby', 'user_service.rb', content)
    expect(outcome.symbols.find(sym => sym.name === 'UserService')).toMatchObject({
      kind: 'class',
      qname: 'UserService',
      startLine: 5,
      endLine: 17,
    })
    expect(outcome.symbols.filter(sym => sym.kind === 'method').map(sym => sym.name))
      .toEqual(['initialize', 'find_user', 'create'])
    expect(outcome.symbols.find(sym => sym.name === 'initialize')).toMatchObject({ startLine: 6, endLine: 8 })
    expect(outcome.imports.map(imp => imp.importString)).toEqual(['json', 'base_service'])
  })

  it('kotlin: extracts class, funs, package qname, and imports', () => {
    const content = [
      '',
      'package com.example.service',
      '',
      'import com.example.model.User',
      'import com.example.repo.UserRepo',
      '',
      'class UserService(private val repo: UserRepo) {',
      '    suspend fun getUser(id: Int): User {',
      '        return repo.find(id)',
      '    }',
      '',
      '    fun deleteUser(id: Int) {',
      '        repo.delete(id)',
      '    }',
      '}',
    ].join('\n')
    const outcome = extract('kotlin', 'UserService.kt', content)
    expect(outcome.symbols.find(sym => sym.name === 'UserService')).toMatchObject({
      kind: 'class',
      qname: 'com.example.service.UserService',
      startLine: 7,
      endLine: 15,
    })
    expect(outcome.symbols.filter(sym => sym.kind === 'method').map(sym => sym.name))
      .toEqual(['getUser', 'deleteUser'])
    expect(outcome.imports.map(imp => imp.importString))
      .toEqual(['com.example.model.User', 'com.example.repo.UserRepo'])
  })

  it('php: extracts class, functions, namespace qname with backslash separator, and use', () => {
    const content = [
      '<?php',
      'namespace App\\Services;',
      '',
      'use App\\Models\\User;',
      "require 'vendor/autoload.php';",
      '',
      'class UserService',
      '{',
      '    public function getUser(int $id): User',
      '    {',
      '        return User::find($id);',
      '    }',
      '',
      '    private function validate(User $user): void',
      '    {',
      '        // ...',
      '    }',
      '}',
    ].join('\n')
    const outcome = extract('php', 'UserService.php', content)
    expect(outcome.symbols.find(sym => sym.name === 'UserService')).toMatchObject({
      kind: 'class',
      container: 'App\\Services',
      qname: 'App\\Services\\UserService',
      startLine: 7,
      endLine: 18,
    })
    expect(outcome.symbols.filter(sym => sym.kind === 'method').map(sym => sym.name))
      .toEqual(['getUser', 'validate'])
    // `use` fills capture 1; `require` skips it and fills capture 2.
    expect(outcome.imports.map(imp => imp.importString))
      .toEqual(['App\\Models\\User', 'vendor/autoload.php'])
  })

  it('swift: extracts class, funcs, and the import', () => {
    const content = [
      '',
      'import Foundation',
      '',
      'class UserService {',
      '    func getUser(id: Int) -> User {',
      '        return repo.find(id)',
      '    }',
      '',
      '    private func validate(_ user: User) {',
      '        // ...',
      '    }',
      '}',
    ].join('\n')
    const outcome = extract('swift', 'UserService.swift', content)
    expect(outcome.symbols.find(sym => sym.name === 'UserService')).toMatchObject({
      kind: 'class',
      startLine: 4,
      endLine: 12,
    })
    expect(outcome.symbols.filter(sym => sym.kind === 'method').map(sym => sym.name))
      .toEqual(['getUser', 'validate'])
    expect(outcome.imports.map(imp => imp.importString)).toEqual(['Foundation'])
  })

  it('dart: extracts class, enum, methods, and quoted imports', () => {
    const content = [
      '',
      "import 'package:flutter/material.dart';",
      "import 'dart:async';",
      '',
      'class UserService {',
      '    Future<User> getUser(int id) {',
      '        return _repo.find(id);',
      '    }',
      '',
      '    void deleteUser(int id) {',
      '        _repo.delete(id);',
      '    }',
      '}',
      '',
      'enum Status {',
      '    active,',
      '    inactive,',
      '}',
    ].join('\n')
    const outcome = extract('dart', 'user_service.dart', content)
    expect(outcome.symbols.find(sym => sym.name === 'UserService')).toMatchObject({
      kind: 'class',
      startLine: 5,
      endLine: 13,
    })
    expect(outcome.symbols.find(sym => sym.name === 'Status')).toMatchObject({
      kind: 'enum',
      startLine: 15,
      endLine: 18,
    })
    expect(outcome.symbols.filter(sym => sym.kind === 'method').map(sym => sym.name))
      .toEqual(['getUser', 'deleteUser'])
    expect(outcome.imports.map(imp => imp.importString))
      .toEqual(['package:flutter/material.dart', 'dart:async'])
  })

  it('scala: extracts object, trait, defs, package qname, and imports', () => {
    const content = [
      '',
      'package com.example.service',
      '',
      'import com.example.model.User',
      'import com.example.repo.UserRepo',
      '',
      'object UserService {',
      '    def getUser(id: Int): User = {',
      '        UserRepo.find(id)',
      '    }',
      '',
      '    def deleteUser(id: Int): Unit = {',
      '        UserRepo.delete(id)',
      '    }',
      '}',
      '',
      'trait Serializable {',
      '    def serialize(): String',
      '}',
    ].join('\n')
    const outcome = extract('scala', 'UserService.scala', content)
    expect(outcome.symbols.find(sym => sym.name === 'UserService')).toMatchObject({
      kind: 'class',
      qname: 'com.example.service.UserService',
      startLine: 7,
      endLine: 15,
    })
    expect(outcome.symbols.find(sym => sym.name === 'Serializable')).toMatchObject({
      kind: 'interface',
      startLine: 17,
      endLine: 19,
    })
    expect(outcome.symbols.filter(sym => sym.kind === 'method').map(sym => sym.name))
      .toEqual(['getUser', 'deleteUser', 'serialize'])
    expect(outcome.imports.map(imp => imp.importString))
      .toEqual(['com.example.model.User', 'com.example.repo.UserRepo'])
  })

  it('lua: extracts plain, local, and qualified functions plus requires', () => {
    const content = [
      '',
      "local json = require('cjson')",
      "local utils = require 'utils'",
      '',
      'function greet(name)',
      '    print("Hello, " .. name)',
      'end',
      '',
      'local function helper(x)',
      '    return x * 2',
      'end',
      '',
      'function MyModule.doStuff(a, b)',
      '    return a + b',
      'end',
    ].join('\n')
    const outcome = extract('lua', 'main.lua', content)
    expect(outcome.symbols.map(sym => [sym.name, sym.kind, sym.startLine, sym.endLine])).toEqual([
      ['greet', 'function', 5, 7],
      ['helper', 'function', 9, 11],
      ['MyModule.doStuff', 'method', 13, 15],
    ])
    expect(outcome.imports.map(imp => imp.importString)).toEqual(['cjson', 'utils'])
  })

  it('produces symbol chunks and the package summary line', async () => {
    const outcome = await parseFile('test.rb', 'def foo\n  42\nend\n\ndef bar\n  43\nend\n', OPTIONS)
    expect(outcome).not.toBeNull()
    expect(outcome!.parserTier).toBe('heuristic')
    expect(outcome!.symbols.map(sym => sym.name)).toEqual(['foo', 'bar'])
    // The reference summary appends `via <grammar>`; this package's format owns it.
    expect(outcome!.summary).toBe('test.rb (ruby, 7 lines, 2 symbols)')
    expect(outcome!.contentExcerpt).toContain('def foo')
  })

  it('parses empty content into empty records', async () => {
    const outcome = await parseFile('empty.cs', '', OPTIONS)
    expect(outcome).not.toBeNull()
    expect(outcome!.symbols).toEqual([])
    expect(outcome!.imports).toEqual([])
    expect(outcome!.callEdges).toEqual([])
    expect(outcome!.contentExcerpt).toBe('')
  })
})

describe('same-file call edges', () => {
  it('csharp: connects Run to the in-file Helper across the phantom declaration', () => {
    const content = [
      '',
      'public class Calc',
      '{',
      '    public int Helper(int n)',
      '    {',
      '        return n * 2;',
      '    }',
      '',
      '    public int Run(int x)',
      '    {',
      '        return Helper(x);',
      '    }',
      '}',
    ].join('\n')
    const outcome = extract('csharp', 'Calc.cs', content)
    const edges = outcome.callEdges.filter(edge => edge.calleeSymbol === 'Helper')
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({
      callerSymbol: 'Run',
      line: 11,
      dispatchKind: 'direct',
      callKind: 'direct',
      parserTier: 'heuristic',
      parserConfidence: HEURISTIC_CONFIDENCE,
    })
    // The misparse of `return Helper(x)` as a method declaration must not
    // become the caller, and the real Helper declaration line never emits.
    expect(outcome.symbols.filter(sym => sym.name === 'Helper')).toHaveLength(2)
  })

  it('ruby: connects run to helper', () => {
    const outcome = extract('ruby', 'calc.rb', '\ndef helper(n)\n  n * 2\nend\n\ndef run(x)\n  helper(x)\nend\n')
    expect(outcome.callEdges).toHaveLength(1)
    expect(outcome.callEdges[0]).toMatchObject({ callerSymbol: 'run', calleeSymbol: 'helper', line: 7 })
  })

  it('lua: connects run to helper', () => {
    const outcome = extract('lua', 'calc.lua', '\nfunction helper(n)\n    return n * 2\nend\n\nfunction run(x)\n    return helper(x)\nend\n')
    expect(outcome.callEdges.map(edge => [edge.callerSymbol, edge.calleeSymbol, edge.line]))
      .toEqual([['run', 'helper', 7]])
  })

  it('never emits edges for control-flow keywords or unresolved callees', () => {
    const content = [
      '',
      'public class Loop',
      '{',
      '    public void Run(int x)',
      '    {',
      '        if (x > 0)',
      '        {',
      '            while (x > 1)',
      '            {',
      '                x = x - 1;',
      '            }',
      '        }',
      '        Undefined(x);',
      '    }',
      '}',
    ].join('\n')
    const outcome = extract('csharp', 'Loop.cs', content)
    expect(outcome.callEdges).toEqual([])
  })

  it('emits a caller-less edge for a top-level call', () => {
    const outcome = extract('ruby', 'top.rb', 'def helper(n)\n  n * 2\nend\nhelper(1)\n')
    expect(outcome.callEdges).toHaveLength(1)
    expect(outcome.callEdges[0]).toMatchObject({
      callerSymbol: null,
      callerSymbolUid: null,
      calleeSymbol: 'helper',
      line: 4,
    })
  })

  it('drops recursion self-loops', () => {
    const outcome = extract('lua', 'fact.lua', 'function fact(n)\n    return fact(n - 1)\nend\n')
    expect(outcome.callEdges).toEqual([])
  })

  it('attributes nested calls to the innermost enclosing definition', () => {
    const outcome = extract('ruby', 'nested.rb', [
      'def outer()',
      '  def inner()',
      '    helper()',
      '  end',
      '  helper()',
      'end',
      'def helper()',
      '  1',
      'end',
    ].join('\n'))
    expect(outcome.symbols.map(sym => [sym.name, sym.kind, sym.startLine, sym.endLine])).toEqual([
      ['outer', 'function', 1, 6],
      ['inner', 'method', 2, 4],
      ['helper', 'function', 7, 9],
    ])
    expect(outcome.callEdges.map(edge => [edge.callerSymbol, edge.calleeSymbol, edge.line])).toEqual([
      ['inner', 'helper', 3],
      ['outer', 'helper', 5],
    ])
  })

  it('produces no edges when the file has no callable symbols', () => {
    const outcome = extract('ruby', 'only.rb', 'class Only\nend\n')
    expect(outcome.symbols.map(sym => sym.name)).toEqual(['Only'])
    expect(outcome.callEdges).toEqual([])
  })
})

describe('end-line estimation boundaries', () => {
  it('closes nested lua functions at their own indentation', () => {
    const outcome = extract('lua', 'nested.lua', [
      'function outer()',
      '    function inner()',
      '        work()',
      '    end',
      'end',
    ].join('\n'))
    expect(outcome.symbols.map(sym => [sym.name, sym.kind, sym.startLine, sym.endLine])).toEqual([
      ['outer', 'function', 1, 5],
      ['inner', 'method', 2, 4],
    ])
    // A method via indentation even without a qualified name.
    expect(outcome.symbols[1]!.kind).toBe('method')
  })

  it('closes a colon-qualified lua function as a method', () => {
    const outcome = extract('lua', 'colon.lua', 'function M:work(a)\n    return a\nend\n')
    expect(outcome.symbols).toHaveLength(1)
    expect(outcome.symbols[0]).toMatchObject({ name: 'M:work', kind: 'method', endLine: 3 })
  })

  it('accepts an `end ` prefixed closer', () => {
    const outcome = extract('ruby', 'trailing.rb', 'def f\n  x\nend # trailing comment\n')
    expect(outcome.symbols[0]).toMatchObject({ startLine: 1, endLine: 3 })
  })

  it('falls back to start+30 when the scan window finds no closer', () => {
    const filler = Array.from({ length: 250 }, () => 'p 1').join('\n')
    const outcome = extract('ruby', 'big.rb', `def big\n${filler}\n`)
    expect(outcome.symbols[0]).toMatchObject({ name: 'big', startLine: 1, endLine: 30 })
  })

  it('caps the fallback at the end of file', () => {
    const outcome = extract('ruby', 'short.rb', 'def f\n  x\n')
    expect(outcome.symbols[0]).toMatchObject({ startLine: 1, endLine: 2 })
  })

  it('estimates a single-line declaration as a one-line span', () => {
    const outcome = extract('ruby', 'one.rb', 'def f; end')
    expect(outcome.symbols[0]).toMatchObject({ name: 'f', startLine: 1, endLine: 1 })
  })
})

describe('class-kind classification order', () => {
  it.each([
    ['csharp', 'public interface IFoo {\n}\n', 'IFoo', 'interface'],
    ['dart', 'enum Status { active }\n', 'Status', 'enum'],
    ['ruby', 'module MyThing\nend\n', 'MyThing', 'module'],
    ['kotlin', 'enum class Color { RED }\n', 'Color', 'enum'],
    ['csharp', 'struct Point { }\n', 'Point', 'class'],
    ['csharp', 'record Person(string Name);\n', 'Person', 'class'],
    ['swift', 'protocol Drivable {\n  func drive()\n}\n', 'Drivable', 'interface'],
    ['scala', 'trait Showable {\n  def show(): Unit\n}\n', 'Showable', 'interface'],
    ['kotlin', 'object Repo {\n  fun get(): Int = 1\n}\n', 'Repo', 'class'],
  ] as const)('%s %s classifies as %s', (language, content, name, kind) => {
    const outcome = extract(language, `kinds.${language}`, content)
    expect(outcome.symbols.find(sym => sym.name === name)?.kind).toBe(kind)
  })

  it('keeps an indented declaration a method and a top-level one a function', () => {
    const outcome = extract('ruby', 'kinds.rb', 'class C\n  def inner\n  end\nend\ndef outer\nend\n')
    expect(outcome.symbols.map(sym => [sym.name, sym.kind])).toEqual([
      ['C', 'class'],
      ['inner', 'method'],
      ['outer', 'function'],
    ])
  })
})

describe('spec symbol ids', () => {
  it('keeps the reference literal format, not the sha256 id family', () => {
    const ruby = extract('ruby', 'user_service.rb', 'class UserService\nend\n')
    expect(ruby.symbols[0]!.symbolId).toBe('spec:user_service.rb:class:UserService')
    const lua = extract('lua', 'main.lua', 'function greet(name)\nend\n')
    expect(lua.symbols[0]!.symbolId).toBe('spec:main.lua:function:greet')
  })

  it('derives symbolUid from the qualified identity', () => {
    const scala = extract('scala', 'UserService.scala', 'package com.example.service\nobject UserService\n')
    const symbol = scala.symbols[0]!
    expect(symbol.qname).toBe('com.example.service.UserService')
    // Same (file, qname, kind) ⇒ same uid as the shared id helper.
    expect(symbol.symbolUid).toBe(symbolUid('UserService.scala', 'com.example.service.UserService', 'class'))
  })
})

describe('spec-driven imports resolve through the project root', () => {
  it('resolves ruby relative requires that carry an extension', async () => {
    mkdirSync(root, { recursive: true })
    writeFileSync(join(root, 'util.rb'), 'def util\nend\n')
    const outcome = await parseFile('lib/main.rb', "require 'cjson'\nrequire_relative '../util.rb'\n", OPTIONS)
    expect(outcome!.imports.map(imp => [imp.importString, imp.resolvedPath])).toEqual([
      ['cjson', null],
      ['../util.rb', 'util.rb'],
    ])
  })

  it('resolves dart relative imports that carry an extension', async () => {
    mkdirSync(join(root, 'helpers'), { recursive: true })
    writeFileSync(join(root, 'helpers', 'util.dart'), 'class Util {}\n')
    const outcome = await parseFile('lib/main.dart', "import 'package:foo/bar.dart';\nimport '../helpers/util.dart';\n", OPTIONS)
    expect(outcome!.imports.map(imp => [imp.importString, imp.resolvedPath])).toEqual([
      ['package:foo/bar.dart', null],
      ['../helpers/util.dart', 'helpers/util.dart'],
    ])
  })

  it('leaves dotted and bare module specifiers unresolved (resolver boundary)', async () => {
    // The shared resolver handles relative JS specifiers and Python dotted
    // modules only; every spec-driven bare/dotted form stays null.
    const cases = [
      ['a.cs', 'using System;\nusing MyApp.Services;\n', ['System', 'MyApp.Services']],
      ['a.php', '<?php\nuse App\\Models\\User;\n', ['App\\Models\\User']],
      ['a.swift', 'import Foundation\nimport UIKit\n', ['Foundation', 'UIKit']],
      ['a.kt', 'import com.example.model.User\nimport com.example.repo.UserRepo\n', ['com.example.model.User', 'com.example.repo.UserRepo']],
      ['a.scala', 'import com.example.service.UserService\n', ['com.example.service.UserService']],
      ['a.lua', "require('cjson')\n", ['cjson']],
    ] as const
    for (const [path, content, specifiers] of cases) {
      const outcome = await parseFile(path, content, OPTIONS)
      expect(outcome, path).not.toBeNull()
      expect(outcome!.imports.map(imp => imp.importString), path).toEqual([...specifiers])
      expect(outcome!.imports.every(imp => imp.resolvedPath === null), path).toBe(true)
    }
  })

  it('throws for a language outside the spec-driven table', () => {
    expect(() => extractSpecDriven('python' as unknown as SpecDrivenLanguage, 'x.py', 'def f:\n  pass\n'))
      .toThrow('no spec-driven table row for')
  })
})
