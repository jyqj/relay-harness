import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parseFile } from '../src/index.ts'

const root = mkdtempSync(join(tmpdir(), 'rlh-parser-parsefile-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const OPTIONS = { projectRoot: root, maxFileBytes: 512_000 }

describe('parseFile entry', () => {
  it('returns null for oversized files', async () => {
    const outcome = await parseFile('a.js', 'const x = 1;', { ...OPTIONS, maxFileBytes: 4 })
    expect(outcome).toBeNull()
  })

  it('returns null for files without a parser', async () => {
    expect(await parseFile('a.md', '# hi', OPTIONS)).toBeNull()
    expect(await parseFile('Makefile', 'all:', OPTIONS)).toBeNull()
  })

  it('parses js and resolves relative imports against the project root', async () => {
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'helper.ts'), 'export const k = 1;')
    const outcome = await parseFile('src/main.ts', 'import { k } from "./helper";\nk();\n', OPTIONS)
    expect(outcome).not.toBeNull()
    expect(outcome!.language).toBe('typescript')
    expect(outcome!.parserTier).toBe('semantic')
    expect(outcome!.imports[0]).toMatchObject({ importString: './helper', resolvedPath: 'src/helper.ts' })
    expect(outcome!.callEdges.some(edge => edge.calleeSymbol === 'k')).toBe(true)
  })

  it('parses jsx files with the javascript grammar', async () => {
    const outcome = await parseFile('src/app.jsx', 'export function App() {\n  return <B />;\n}\n', OPTIONS)
    expect(outcome).not.toBeNull()
    expect(outcome!.language).toBe('jsx')
    expect(outcome!.symbols[0]).toMatchObject({ name: 'App', exportName: 'App' })
  })

  it('dispatches the go/java/c/cpp walkers at tree-sitter tier', async () => {
    const go = await parseFile('a.go', 'package main\n\nfunc main() { helper() }', OPTIONS)
    expect(go).not.toBeNull()
    expect(go!.parserTier).toBe('tree-sitter')
    expect(go!.parserConfidence).toBe(0.7)
    expect(go!.symbols.some(symbol => symbol.name === 'main')).toBe(true)

    const java = await parseFile('a.java', 'class A { void run() { go(); } }', OPTIONS)
    expect(java!.parserTier).toBe('tree-sitter')
    expect(java!.symbols.some(symbol => symbol.name === 'A')).toBe(true)

    const c = await parseFile('a.c', 'int main() { return 0; }', OPTIONS)
    expect(c!.language).toBe('c')
    expect(c!.symbols.some(symbol => symbol.name === 'main')).toBe(true)

    const cpp = await parseFile('a.cpp', 'int main() { return 0; }', OPTIONS)
    expect(cpp!.language).toBe('cpp')
    expect(cpp!.symbols.some(symbol => symbol.name === 'main')).toBe(true)
  })

  it('marks test files through the language heuristics', async () => {
    const outcome = await parseFile('src/a.test.ts', 'const x = 1;', OPTIONS)
    expect(outcome!.isTestFile).toBe(true)
    const source = await parseFile('src/a.ts', 'const x = 1;', OPTIONS)
    expect(source!.isTestFile).toBe(false)
  })

  it('summarizes and excerpts the file content', async () => {
    const code = 'function first() {\n  return "lit-one";\n}\n\nfunction second() {\n  return 2;\n}\n'
    const outcome = await parseFile('src/sum.js', code, OPTIONS)
    expect(outcome!.summary).toBe('src/sum.js (javascript, 7 lines, 2 symbols)')
    expect(outcome!.contentExcerpt).toContain('function first() {')
    expect(outcome!.parseErrorCount).toBe(0)
    expect(outcome!.parseErrors).toEqual([])
    // General identifier refs ship with the resolution phase; only the SFC
    // template layer produces refs in this phase.
    expect(outcome!.symbolRefs).toEqual([])
  })
})
