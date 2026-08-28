import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** Per-file and total byte budgets for the vendored grammars. */
const SINGLE_FILE_MAX_BYTES = 5 * 1024 * 1024
const TOTAL_MAX_BYTES = 25 * 1024 * 1024

const GRAMMAR_FILES = [
  'tree-sitter-c.wasm',
  'tree-sitter-cpp.wasm',
  'tree-sitter-go.wasm',
  'tree-sitter-java.wasm',
  'tree-sitter-javascript.wasm',
  'tree-sitter-python.wasm',
  'tree-sitter-rust.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-typescript.wasm',
] as const

const grammarsDir = fileURLToPath(new URL('../resources/grammars/', import.meta.url))

function grammarBytes(file: string): Buffer {
  return readFileSync(grammarsDir + file)
}

describe('vendored grammar provenance', () => {
  it('vendors exactly the nine grammar files plus the VERSION record', () => {
    const entries = readdirSync(grammarsDir).sort()
    expect(entries).toEqual([...GRAMMAR_FILES, 'VERSION'].sort())
  })

  it.each(GRAMMAR_FILES)('%s is a wasm module within the per-file budget', (file) => {
    const bytes = grammarBytes(file)
    expect(bytes.subarray(0, 4).toString('latin1')).toBe('\0asm')
    expect(bytes.length).toBeLessThan(SINGLE_FILE_MAX_BYTES)
  })

  it('stays within the total vendored-grammar budget', () => {
    const total = GRAMMAR_FILES.reduce((sum, file) => sum + grammarBytes(file).length, 0)
    expect(total).toBeLessThan(TOTAL_MAX_BYTES)
  })

  it('VERSION records the source and exact byte size of every file', () => {
    const version = readFileSync(grammarsDir + 'VERSION', 'utf8')
    expect(version).toMatch(/^source: official tree-sitter grammar release artifacts/)

    const recorded = new Map<string, number>()
    for (const line of version.split('\n')) {
      const match = /^(tree-sitter-[a-z]+\.wasm) \S+ (\d+)$/.exec(line)
      if (match !== null) recorded.set(match[1]!, Number(match[2]))
    }
    expect([...recorded.keys()].sort()).toEqual([...GRAMMAR_FILES].sort())
    for (const [file, bytes] of recorded) {
      expect(grammarBytes(file).length, `${file} matches VERSION`).toBe(bytes)
    }
  })
})
