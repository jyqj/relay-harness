import { describe, expect, it } from 'vitest'
import {
  EXCERPT_MAX_CHARS,
  approxTokens,
  buildContentExcerpt,
  formatSummary,
  textLineCount,
  textLines,
} from '../src/summary.ts'

describe('text shaping', () => {
  it('splits lines with Rust str::lines semantics', () => {
    expect(textLines('')).toEqual([])
    expect(textLines('a')).toEqual(['a'])
    expect(textLines('a\n')).toEqual(['a'])
    expect(textLines('a\nb')).toEqual(['a', 'b'])
    expect(textLines('a\n\nb')).toEqual(['a', '', 'b'])
    expect(textLines('a\r\nb')).toEqual(['a', 'b'])
  })

  it('counts lines the same way', () => {
    expect(textLineCount('')).toBe(0)
    expect(textLineCount('a')).toBe(1)
    expect(textLineCount('a\n')).toBe(1)
    expect(textLineCount('a\nb\nc')).toBe(3)
    expect(textLineCount('a\n\n')).toBe(2)
  })

  it('formats the summary line without a route segment', () => {
    expect(formatSummary('src/a.ts', 'typescript', 12, 3))
      .toBe('src/a.ts (typescript, 12 lines, 3 symbols)')
  })

  it('joins the first three chunk texts into the excerpt', () => {
    const excerpt = buildContentExcerpt([{ text: 'one' }, { text: 'two' }, { text: 'three' }, { text: 'four' }])
    expect(excerpt).toBe('one\ntwo\nthree')
  })

  it('returns an empty excerpt for chunkless files', () => {
    expect(buildContentExcerpt([])).toBe('')
  })

  it('truncates the excerpt at the character budget', () => {
    const big = { text: 'x'.repeat(EXCERPT_MAX_CHARS + 50) }
    expect(buildContentExcerpt([big, { text: 'y' }])).toHaveLength(EXCERPT_MAX_CHARS)
    expect(buildContentExcerpt([big, { text: 'y' }])).toBe('x'.repeat(EXCERPT_MAX_CHARS))
  })

  it('estimates tokens as UTF-8 bytes over four, rounding up', () => {
    expect(approxTokens('')).toBe(0)
    expect(approxTokens('abcd')).toBe(1)
    expect(approxTokens('abcde')).toBe(2)
    expect(approxTokens('你好')).toBe(2)
  })
})
