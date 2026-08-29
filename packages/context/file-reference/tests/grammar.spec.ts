/** Mention extraction over completed prompt text. */
import { describe, expect, it } from 'vitest'
import { parseFileMentions } from '../src/grammar.ts'

describe('parseFileMentions', () => {
  it('extracts unquoted and quoted mentions in first-occurrence order and collapses duplicates', () => {
    expect(parseFileMentions('open @src/a.ts and @"notes draft.md", then @src/a.ts again'))
      .toEqual(['src/a.ts', 'notes draft.md'])
    expect(parseFileMentions('@first\n@second @first')).toEqual(['first', 'second'])
  })

  it('leaves email-like tokens, mid-token @ signs, and unclosed quotes unmatched', () => {
    expect(parseFileMentions('contact a@b.com or visit x@y now')).toEqual([])
    expect(parseFileMentions('email a@b.com @real.txt')).toEqual(['real.txt'])
    expect(parseFileMentions('look at @"unclosed now')).toEqual([])
  })
})
