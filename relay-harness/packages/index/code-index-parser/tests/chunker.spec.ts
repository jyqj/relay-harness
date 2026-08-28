import { describe, expect, it } from 'vitest'
import { LINE_BUDGET, chunkByLines, chunkWithSymbols } from '../src/chunker.ts'
import type { SymbolRecord } from '../src/types.ts'

const BASE = {
  filePath: 'f.py',
  language: 'python' as const,
  parserTier: 'generic' as const,
  parserConfidence: 0.3,
}

function symbol(name: string, startLine: number, endLine: number): SymbolRecord {
  return {
    symbolId: `sym:${name}`,
    filePath: 'f.py',
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

function lines(from: number, to: number): string {
  const parts: string[] = []
  for (let i = from; i <= to; i++) parts.push(`line ${i}`)
  return parts.join('\n')
}

describe('chunker (reference chunker.rs cases)', () => {
  it('chunk_by_lines splits 12 lines with a 5-line budget into 3 windows', () => {
    const chunks = chunkByLines({ ...BASE, content: lines(1, 12), lineBudget: 5 })
    expect(chunks).toHaveLength(3)
    expect(chunks[0]!.startLine).toBe(1)
    expect(chunks[0]!.endLine).toBe(5)
    expect(chunks[2]!.startLine).toBe(11)
    expect(chunks[2]!.endLine).toBe(12)
  })

  it('chunk ids are stable and positional', () => {
    const chunks = chunkByLines({ ...BASE, filePath: 'f.py', content: 'a\nb\nc', lineBudget: 10 })
    expect(chunks[0]!.chunkId).toBe('chunk:f.py:0')
  })

  it('blank windows are skipped and do not advance the chunk index', () => {
    const content = `${lines(1, 5)}\n\n\n\n\n\n${lines(11, 15)}`
    const chunks = chunkByLines({ ...BASE, content, lineBudget: 5 })
    // Two content windows; the blank middle window is dropped entirely.
    expect(chunks).toHaveLength(2)
    expect(chunks.map(chunk => chunk.chunkId)).toEqual(['chunk:f.py:0', 'chunk:f.py:1'])
    expect(chunks[1]!.startLine).toBe(11)
  })

  it('a trailing newline does not produce an empty trailing line', () => {
    const chunks = chunkByLines({ ...BASE, content: 'a\nb\n', lineBudget: 10 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.text).toBe('a\nb')
    expect(chunks[0]!.endLine).toBe(2)
  })

  it('returns no chunks for empty content', () => {
    expect(chunkByLines({ ...BASE, content: '' })).toEqual([])
    expect(chunkWithSymbols({ ...BASE, content: '', symbols: [symbol('a', 1, 2)] })).toEqual([])
  })

  it('each top-level symbol becomes a chunk with its name as breadcrumb', () => {
    const content = 'function a() {}\n\nfunction b() {}'
    const chunks = chunkWithSymbols({
      ...BASE,
      filePath: 'm.ts',
      language: 'typescript',
      content,
      symbols: [symbol('a', 1, 1), symbol('b', 3, 3)],
    })
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toMatchObject({ breadcrumb: 'a', symbolName: 'a', startLine: 1, endLine: 1 })
    expect(chunks[1]).toMatchObject({ breadcrumb: 'b', symbolName: 'b', startLine: 3, endLine: 3 })
  })

  it('non-blank gaps between symbols become gap chunks without a symbol', () => {
    const chunks = chunkWithSymbols({
      ...BASE,
      filePath: 'm.ts',
      language: 'typescript',
      content: 'const x = 1;\nconst y = 2;',
      symbols: [symbol('x', 1, 1), symbol('y', 2, 2)],
    })
    // Both symbols are adjacent lines: no gap chunk appears.
    expect(chunks).toHaveLength(2)
    const spread = chunkWithSymbols({
      ...BASE,
      filePath: 'm.ts',
      language: 'typescript',
      content: 'function a() {}\n// free text\n// more text\nfunction b() {}',
      symbols: [symbol('a', 1, 1), symbol('b', 4, 4)],
    })
    expect(spread).toHaveLength(3)
    expect(spread[1]).toMatchObject({
      breadcrumb: '',
      symbolName: null,
      startLine: 2,
      endLine: 3,
    })
    expect(spread[1]!.chunkId).toBe('chunk:m.ts:1')
  })

  it('blank gaps produce no chunk', () => {
    const chunks = chunkWithSymbols({
      ...BASE,
      filePath: 'm.ts',
      language: 'typescript',
      content: 'function a() {}\n\n\nfunction b() {}',
      symbols: [symbol('a', 1, 1), symbol('b', 4, 4)],
    })
    expect(chunks).toHaveLength(2)
  })

  it('splits over-budget symbols into fixed windows keeping the plain name breadcrumb', () => {
    // 200 body lines, budget 80 → windows of 80 + 80 + 40.
    const body = Array.from({ length: 200 }, (_, i) => `x = ${i}`).join('\n')
    const content = `function big() {\n${body}\n}`
    const chunks = chunkWithSymbols({
      ...BASE,
      filePath: 'big.ts',
      language: 'typescript',
      content,
      symbols: [symbol('big', 1, 202)],
      lineBudget: 80,
    })
    expect(chunks).toHaveLength(3)
    expect(chunks.map(chunk => chunk.breadcrumb)).toEqual(['big', 'big', 'big'])
    expect(chunks[0]).toMatchObject({ startLine: 1, endLine: 80 })
    expect(chunks[1]).toMatchObject({ startLine: 81, endLine: 160 })
    expect(chunks[2]).toMatchObject({ startLine: 161, endLine: 202 })
  })

  it('overlapping spans assign covered unconditionally (reference quirk)', () => {
    const chunks = chunkWithSymbols({
      ...BASE,
      filePath: 'm.ts',
      language: 'typescript',
      content: 'function a() {\n  function inner() {}\n}',
      symbols: [symbol('a', 1, 3), symbol('inner', 2, 2)],
    })
    // The inner span (lines 2-2) is still emitted inside the outer span's
    // range, and `covered` is rolled back to the inner span's end — the
    // trailing `}` then re-appears as a gap chunk. This mirrors the
    // reference implementation's unconditional `covered = el`.
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toMatchObject({ breadcrumb: 'a', startLine: 1, endLine: 3 })
    expect(chunks[1]).toMatchObject({ breadcrumb: 'inner', startLine: 2, endLine: 2 })
    expect(chunks[2]).toMatchObject({ breadcrumb: '', startLine: 3, endLine: 3 })
  })

  it('falls back to line windows when no symbols exist', () => {
    const chunks = chunkWithSymbols({ ...BASE, content: lines(1, 12), symbols: [], lineBudget: 5 })
    expect(chunks).toHaveLength(3)
  })

  it('estimates tokens as UTF-8 bytes over four, rounding up', () => {
    const chunks = chunkByLines({ ...BASE, content: 'abcdabcd', lineBudget: 10 })
    expect(chunks[0]!.tokenEstimate).toBe(2)
    const wide = chunkByLines({ ...BASE, content: '"你好"', lineBudget: 10 })
    expect(wide[0]!.tokenEstimate).toBe(2)
  })

  it('uses the 80-line default budget', () => {
    expect(LINE_BUDGET).toBe(80)
    const chunks = chunkByLines({ ...BASE, content: lines(1, 81) })
    expect(chunks).toHaveLength(2)
  })
})
