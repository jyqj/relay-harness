/** Generic chunker: language/test heuristics, UTF-8 gate, line windows, byte ceiling. */

import { describe, expect, it } from 'vitest'
import {
  CHUNK_LINE_BUDGET,
  FILE_EXCERPT_MAX_CHARS,
  FILE_SUMMARY_MAX_CHARS,
  decodeUtf8Strict,
  deriveLanguage,
  isTestFile,
  prepareFileDocument,
} from '../src/chunker.ts'

describe('deriveLanguage', () => {
  it('maps known extensions and Dockerfile variants', () => {
    expect(deriveLanguage('src/a.ts')).toBe('typescript')
    expect(deriveLanguage('X.Y.Z/py.rs')).toBe('rust')
    expect(deriveLanguage('deploy/Dockerfile')).toBe('dockerfile')
    expect(deriveLanguage('deploy/Dockerfile.prod')).toBe('dockerfile')
    expect(deriveLanguage('makefile')).toBe('plaintext')
  })

  it('falls back for dotfiles, trailing dots, unknown extensions, and case', () => {
    expect(deriveLanguage('.gitignore')).toBe('plaintext')
    expect(deriveLanguage('weird.')).toBe('plaintext')
    expect(deriveLanguage('graph.custom')).toBe('plaintext')
    expect(deriveLanguage('TYPES.ts')).toBe('typescript')
  })
})

describe('isTestFile', () => {
  it('detects suffix style, prefix style, and directory segments', () => {
    expect(isTestFile('src/app.test.ts')).toBe(true)
    expect(isTestFile('src/app.spec.js')).toBe(true)
    expect(isTestFile('tests/test_app.py')).toBe(true)
    expect(isTestFile('py/test_app.py')).toBe(true)
    expect(isTestFile('suite/spec_runner.rb')).toBe(true)
    expect(isTestFile('packages/x/__tests__/a.ts')).toBe(true)
    expect(isTestFile('packages/x/test/a.ts')).toBe(true)
    expect(isTestFile('src/domain/user.py')).toBe(false)
  })
})

describe('decodeUtf8Strict', () => {
  it('decodes valid UTF-8 including CJK and rejects invalid sequences', () => {
    const text = '索引 // 中文 núcleo'
    expect(decodeUtf8Strict(new TextEncoder().encode(text))).toBe(text)
    expect(decodeUtf8Strict(new Uint8Array([0x61, 0xff, 0xfe, 0x62]))).toBeNull()
  })
})

describe('prepareFileDocument', () => {
  const maxFileBytes = 512_000

  it('windows files into 1-based inclusive ranges of at most the chunk budget', () => {
    const lines = Array.from({ length: CHUNK_LINE_BUDGET * 2 + 3 }, (_, index) => `line ${index + 1}`)
    const document = prepareFileDocument('big.ts', new TextEncoder().encode(lines.join('\n')), { maxFileBytes })
    if (document === null) throw new Error('fixture must decode')
    expect(document.chunks).toHaveLength(3)
    expect(document.chunks[0]).toMatchObject({ startLine: 1, endLine: CHUNK_LINE_BUDGET })
    expect(document.chunks[1]).toMatchObject({ startLine: CHUNK_LINE_BUDGET + 1, endLine: CHUNK_LINE_BUDGET * 2 })
    expect(document.chunks[2]).toMatchObject({ chunkIndex: 2, startLine: 161, endLine: 163 })
    expect(document.chunks.at(-1)?.text.endsWith('line 163')).toBe(true)
    expect(document.isTestFile).toBe(false)
    expect(document.language).toBe('typescript')
  })

  it('preserves interior newlines inside window text and strips CRLF endings', () => {
    const document = prepareFileDocument('a.md', new TextEncoder().encode('one\r\ntwo\r\nthree\r\n'), { maxFileBytes })
    expect(document?.chunks.map(chunk => chunk.text)).toEqual(['one\ntwo\nthree'])
  })

  it('summarizes from the first meaningful line and bounds summary/excerpt budgets', () => {
    const head = '# 项目标题'.repeat(FILE_SUMMARY_MAX_CHARS)
    const filler = Array.from({ length: FILE_EXCERPT_MAX_CHARS + 40 }, (_, index) => `l${index}`)
    const bytes = new TextEncoder().encode(['', '', head, ...filler].join('\n'))
    const document = prepareFileDocument('notes/zh.md', bytes, { maxFileBytes })
    expect(document?.summary.startsWith('# 项目标题')).toBe(true)
    expect(Array.from(document?.summary ?? '').length).toBeLessThanOrEqual(FILE_SUMMARY_MAX_CHARS)
    expect(Array.from(document?.contentExcerpt ?? '').length).toBeLessThanOrEqual(FILE_EXCERPT_MAX_CHARS)
  })

  it('produces an empty but complete row payload for blank-only files', () => {
    const document = prepareFileDocument('empty.ts', new TextEncoder().encode('\n\n'), { maxFileBytes })
    expect(document?.summary).toBe('')
    expect(document?.contentExcerpt).toBe('\n')
    expect(document?.chunks[0]).toMatchObject({ startLine: 1, endLine: 2, text: '\n', tokenEstimate: 1 })
  })

  it('treats a zero-byte file as fully blank with no windows at all', () => {
    const document = prepareFileDocument('void.ts', new Uint8Array(0), { maxFileBytes })
    expect(document?.summary).toBe('')
    expect(document?.contentExcerpt).toBe('')
    expect(document?.chunks).toEqual([])
  })

  it('records an oversized file without chunks but keeps its row-level texts', () => {
    const bytes = new TextEncoder().encode('alpha\nbeta\n' + 'x'.repeat(64))
    const document = prepareFileDocument('big.ts', bytes, { maxFileBytes: 8 })
    expect(document?.chunks).toEqual([])
    expect(document?.summary).toBe('alpha')
    // Oversized rows keep their file-level texts but carry no first-window excerpt.
    expect(document?.contentExcerpt).toBe('')
  })

  it('returns null for binary payloads so callers skip the file entirely', () => {
    expect(prepareFileDocument('img.bin', new Uint8Array([0x00, 0xff, 0xfe]), { maxFileBytes })).toBeNull()
  })

  it('estimates tokens as ceil(text length / four)', () => {
    const document = prepareFileDocument('t.ts', new TextEncoder().encode('abcd'.repeat(9)), { maxFileBytes })
    expect(document?.chunks[0]?.tokenEstimate).toBe(9)
  })
})
