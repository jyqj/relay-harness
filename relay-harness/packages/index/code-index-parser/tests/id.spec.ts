import { createHash } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'
import { chunkId, edgeId, literalId, normalizeWhitespace, refId, symbolUid } from '../src/id.ts'

/** sha256 of a UTF-8 string or raw bytes, hex. */
function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

/** One position word as a little-endian unsigned 32-bit value. */
function le32(value: number): Buffer {
  const encoded = Buffer.alloc(4)
  encoded.writeUInt32LE(value, 0)
  return encoded
}

describe('stable id generation', () => {
  it('builds symbol uids from the documented input construction', () => {
    const expected = `uid:${sha256('sym:src/main.ts\0Foo.bar\0method').slice(0, 24)}`
    expect(symbolUid('src/main.ts', 'Foo.bar', 'method')).toBe(expected)
    expect(symbolUid('src/main.ts', 'Foo.bar', 'method')).toHaveLength('uid:'.length + 24)
  })

  it('appends the whitespace-normalized signature when present', () => {
    const expected = `uid:${sha256('sym:f.ts\0add\0function\0(a: number, b: number) => number').slice(0, 24)}`
    expect(symbolUid('f.ts', 'add', 'function', '(a:  number,\t b: number) => number')).toBe(expected)
    expect(symbolUid('f.ts', 'add', 'function', '(a: number, b: number) => number')).toBe(expected)
  })

  it('differs by kind and file', () => {
    const base = symbolUid('a.ts', 'foo', 'function')
    expect(base).not.toBe(symbolUid('a.ts', 'foo', 'method'))
    expect(base).not.toBe(symbolUid('b.ts', 'foo', 'function'))
  })

  it('builds ref ids from the documented input construction', () => {
    const expected = `ref:${sha256(Buffer.concat([Buffer.from('ref:src/a.ts\0helper:', 'utf8'), le32(12), le32(4)])).slice(0, 16)}`
    expect(refId('src/a.ts', 'helper', 12, 4)).toBe(expected)
    expect(refId('src/a.ts', 'helper', 12, 4)).toHaveLength('ref:'.length + 16)
  })

  it('builds edge ids from the documented input construction', () => {
    const expected = `call:${sha256(Buffer.concat([Buffer.from('call:src/a.ts:', 'utf8'), le32(3), le32(10)])).slice(0, 16)}`
    expect(edgeId('call', 'src/a.ts', 3, 10)).toBe(expected)
    expect(edgeId('call', 'src/a.ts', 3, 10)).toHaveLength('call:'.length + 16)
  })

  it('folds line and column in as little-endian u32 words, so positions never collide', () => {
    // Byte-level pin: the position enters the hash as raw le32, not decimal text.
    expect(edgeId('call', 'src/a.ts', 3, 10)).toBe(
      `call:${sha256(Buffer.concat([Buffer.from('call:src/a.ts:', 'utf8'), Buffer.from([3, 0, 0, 0, 10, 0, 0, 0])])).slice(0, 16)}`,
    )
    // Equal text at distinct positions hashes apart (same line, other column).
    expect(edgeId('lit', 'f.ts', 7, 2)).not.toBe(edgeId('lit', 'f.ts', 7, 9))
    expect(refId('f.ts', 'helper', 7, 2)).not.toBe(refId('f.ts', 'helper', 7, 9))
    // ...and so do positions sharing a decimal-text prefix.
    expect(edgeId('lit', 'f.ts', 1, 23)).not.toBe(edgeId('lit', 'f.ts', 12, 3))
  })

  it('literal ids share the edge-id construction under the lit kind', () => {
    expect(literalId('f.js', 7, 2)).toBe(edgeId('lit', 'f.js', 7, 2))
  })

  it('chunk ids concatenate file and index', () => {
    expect(chunkId('src/main.rs', 3)).toBe('chunk:src/main.rs:3')
  })

  it('normalizes whitespace runs to single spaces', () => {
    expect(normalizeWhitespace('  a\t b   c ')).toBe('a b c')
    expect(normalizeWhitespace('')).toBe('')
  })
})
