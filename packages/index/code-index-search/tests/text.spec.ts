import { describe, expect, it } from 'vitest'
import {
  expandQueryText,
  sanitizeFtsQuery,
  splitCamelCase,
  tokenizeCodeish,
} from '../src/text.ts'

describe('sanitizeFtsQuery (cc-db fts.rs vectors)', () => {
  it('extracts tokens and OR-joins them', () => {
    expect(sanitizeFtsQuery('hello world')).toBe('hello OR world')
    expect(sanitizeFtsQuery('foo_bar')).toBe('foo_bar')
  })

  it('returns the neutral empty phrase for input without tokenizable content', () => {
    expect(sanitizeFtsQuery('')).toBe('""')
    expect(sanitizeFtsQuery('!!! ...')).toBe('""')
  })

  it('caps extracted tokens at twelve', () => {
    const many = Array.from({ length: 20 }, (_, i) => `tok${i}`).join(' ')
    expect(sanitizeFtsQuery(many).split(' OR ')).toHaveLength(12)
    expect(sanitizeFtsQuery(many)).not.toContain('tok12')
  })

  it('groups CJK runs of up to eight characters per token and caps at twelve segments', () => {
    // Four CJK chars stay one segment; OR-free single token.
    expect(sanitizeFtsQuery('用户登录测试')).toBe('用户登录测试')
    // Nine CJK chars split into 8 + 1.
    expect(sanitizeFtsQuery('一二三四五六七八九')).toBe('一二三四五六七八 OR 九')
    // CJK interleaves with ASCII words under the same OR join.
    expect(sanitizeFtsQuery('搜索 handleRequest 用户')).toBe('搜索 OR handleRequest OR 用户')
    // Twenty-four CJK chars => exactly three 8-char segments (and never a partial fourth).
    const long = '一'.repeat(24)
    expect(sanitizeFtsQuery(long).split(' OR ')).toEqual(['一'.repeat(8), '一'.repeat(8), '一'.repeat(8)])
  })

  it('treats underscores as token content, not separators', () => {
    expect(sanitizeFtsQuery('get_user_name')).toBe('get_user_name')
  })
})

describe('splitCamelCase (camel_case_split vectors)', () => {
  it('splits at every lower→upper boundary', () => {
    expect(splitCamelCase('handleRequest')).toEqual(['handle', 'Request'])
    expect(splitCamelCase('foo')).toEqual(['foo'])
    expect(splitCamelCase('HTTPRequest')).toEqual(['HTTPRequest'])
    expect(splitCamelCase('getUserById')).toEqual(['get', 'User', 'By', 'Id'])
  })
})

describe('expandQueryText', () => {
  it('appends lowercased camel parts for multi-part identifiers', () => {
    const expanded = expandQueryText('handleRequest')
    expect(expanded).toContain('handle')
    expect(expanded).toContain('request')
    expect(expanded.split(' ')[0]).toBe('handleRequest')
  })

  it('appends snake parts of length >= 2 only, each once', () => {
    const expanded = expandQueryText('get_user_name')
    expect(expanded).toContain('get')
    expect(expanded).toContain('user')
    expect(expanded).toContain('name')
    expect(expanded.match(/\buser\b/g)).toHaveLength(1)
  })

  it('keeps single-letter snake parts out but keeps short whole words', () => {
    expect(expandQueryText('a_b_c').split(' ').filter(part => part === 'a')).toHaveLength(0)
    expect(expandQueryText('ok')).toBe('ok')
  })

  it('is case-insensitively idempotent across parts', () => {
    // "Request" appears both via camel split ("request") and …the word itself stays unique.
    expect(expandQueryText('HandleRequest Handle')).toBe('HandleRequest handle request Handle')
  })

  it('skips derived parts a later word already provided verbatim', () => {
    expect(expandQueryText('FooBar foo_bar')).toBe('FooBar foo bar foo_bar')
  })
})

describe('tokenizeCodeish', () => {
  it('lowercases alphanumeric/CJK runs and drops punctuation (no camel splitting)', () => {
    expect(tokenizeCodeish('Hello_World, getUserById!')).toEqual(['hello_world', 'getuserbyid'])
    expect(tokenizeCodeish('用户 Login')).toEqual(['用户', 'login'])
  })

  it('yields an empty list for punctuation-only text', () => {
    expect(tokenizeCodeish('!!!')).toEqual([])
  })
})
