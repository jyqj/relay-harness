import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { Language, Parser } from 'web-tree-sitter'
import { describe, expect, it } from 'vitest'

/**
 * Coexistence probe: `node:sqlite` (the code-index storage lane) and
 * web-tree-sitter's Emscripten WASM runtime must coexist inside one process.
 * This is a preflight gate for the whole parser package — if this suite
 * fails, the walker must not be built on top of in-process web-tree-sitter
 * (a worker/subprocess pool around the WASM runtime would be the fallback).
 */
describe('node:sqlite and web-tree-sitter in-process coexistence', () => {
  it('runs SQLite DDL/DML and a tree-sitter parse in the same process', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, note TEXT)')
    db.prepare('INSERT INTO probe (note) VALUES (?)').run('before-parse')
    const before = db.prepare('SELECT note FROM probe WHERE id = 1').get()

    await Parser.init()
    const grammarPath = fileURLToPath(
      new URL('../resources/grammars/tree-sitter-javascript.wasm', import.meta.url),
    )
    const language = await Language.load(readFileSync(grammarPath))
    const parser = new Parser()
    parser.setLanguage(language)
    const tree = parser.parse('function greet(name) { return "hi " + name; }')
    expect(tree).not.toBeNull()

    const after = db.prepare('SELECT note FROM probe WHERE id = 1').get()

    // SQLite survived the WASM instantiation, and vice versa.
    expect(before).toEqual({ note: 'before-parse' })
    expect(after).toEqual({ note: 'before-parse' })

    // The AST is real: a program containing a function declaration.
    const root = tree!.rootNode
    expect(root.type).toBe('program')
    const fn = root.namedChildren[0]!
    expect(fn.type).toBe('function_declaration')
    expect(fn.childForFieldName('name')!.text).toBe('greet')
    parser.delete()
    db.close()
  })
})
