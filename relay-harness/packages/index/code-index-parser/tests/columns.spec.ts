import { describe, expect, it } from 'vitest'
import { positionOf, spanOf } from '../src/columns.ts'

describe('source positions', () => {
  it('resolves the first index to line 1, column 0', () => {
    expect(positionOf('abc', 0)).toEqual({ line: 1, col: 0 })
  })

  it('counts 1-based lines', () => {
    const source = 'a\nb\nc'
    expect(positionOf(source, 0)).toEqual({ line: 1, col: 0 })
    expect(positionOf(source, 2)).toEqual({ line: 2, col: 0 })
    expect(positionOf(source, 4)).toEqual({ line: 3, col: 0 })
  })

  it('measures columns in UTF-8 bytes, not UTF-16 units', () => {
    // λ is 2 UTF-8 bytes (1 UTF-16 unit); 😀 is 4 UTF-8 bytes (2 units).
    const source = 'λx\n😀y'
    expect(positionOf(source, 1)).toEqual({ line: 1, col: 2 })
    expect(positionOf(source, 3)).toEqual({ line: 2, col: 0 })
    expect(positionOf(source, 5)).toEqual({ line: 2, col: 4 })
  })

  it('resolves end positions on later lines for multi-line spans', () => {
    const source = 'function a() {\n  return 1;\n}\n'
    expect(spanOf(source, 0, source.length - 1)).toEqual({
      startLine: 1,
      endLine: 3,
      startCol: 0,
      endCol: 1,
    })
  })

  it('keeps earlier lines multi-byte text out of later columns', () => {
    const source = 'const s = "你好";\nnext();'
    expect(positionOf(source, source.indexOf('next'))).toEqual({ line: 2, col: 0 })
  })
})
