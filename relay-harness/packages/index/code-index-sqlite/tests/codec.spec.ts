import { describe, expect, it } from 'vitest'
import {
  CodeIndexError,
  CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED,
} from '@relay-harness/rlh-code-index'
import {
  decodeChunkText,
  encodeChunkText,
  isChunkTextCompressionCandidate,
  CHUNK_TEXT_COMPRESSION_THRESHOLD_BYTES,
  CHUNK_TEXT_ENCODING_PLAIN,
  CHUNK_TEXT_ENCODING_ZSTD,
} from '../src/codec.ts'

describe('chunk text codec', () => {
  it('round-trips through the plain encoding and keeps small payloads column-aligned text', () => {
    const small = 'export function answer(): number {\n  return 42\n}\n'
    const encoded = encodeChunkText(small)
    expect(encoded).toEqual({ encoding: CHUNK_TEXT_ENCODING_PLAIN, payload: small })
    expect(decodeChunkText(encoded.encoding, encoded.payload)).toBe(small)
  })

  it('stores large compressible payloads as zstd frames and round-trips them', () => {
    const compressible = 'export function repeated(): number {\n  return 42\n}\n'.repeat(8)
    expect(Buffer.byteLength(compressible, 'utf8')).toBeGreaterThan(CHUNK_TEXT_COMPRESSION_THRESHOLD_BYTES)
    const encoded = encodeChunkText(compressible)
    expect(encoded.encoding).toBe(CHUNK_TEXT_ENCODING_ZSTD)
    expect(encoded.payload).not.toBe(compressible)
    expect(decodeChunkText(encoded.encoding, encoded.payload)).toBe(compressible)
  })

  it('round-trips multibyte CJK source text through the zstd encoding', () => {
    const cjk = '导出函数负责把中英混排的源码块原样读回来，保证多字节字符不损坏。\n'.repeat(12)
    expect(Buffer.byteLength(cjk, 'utf8')).toBeGreaterThan(CHUNK_TEXT_COMPRESSION_THRESHOLD_BYTES)
    const encoded = encodeChunkText(cjk)
    expect(encoded.encoding).toBe(CHUNK_TEXT_ENCODING_ZSTD)
    expect(decodeChunkText(encoded.encoding, encoded.payload)).toBe(cjk)
  })

  it('falls back to plain when compression does not shrink the payload', () => {
    // High-entropy printable text barely under ~200 bytes models so poorly
    // that the zstd frame overhead alone exceeds any savings, so the policy
    // keeps the original text. (A base64 random string would not do — past
    // ~200 bytes its 64-symbol alphabet compresses.)
    let state = 0x2545_f491
    let incompressible = ''
    while (Buffer.byteLength(incompressible, 'utf8') < 160) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
      incompressible += String.fromCharCode(0x20 + (state % 95))
    }
    expect(isChunkTextCompressionCandidate(incompressible)).toBe(true)
    const encoded = encodeChunkText(incompressible)
    expect(encoded).toEqual({ encoding: CHUNK_TEXT_ENCODING_PLAIN, payload: incompressible })
    expect(decodeChunkText(encoded.encoding, encoded.payload)).toBe(incompressible)
  })

  it('refuses to guess at an unregistered encoding when decoding stored chunks', () => {
    expect(() => decodeChunkText('lz4', 'binary-ish payload')).toThrow(CodeIndexError)
    try {
      decodeChunkText('lz4', 'binary-ish payload')
      expect.unreachable('decode must throw for an unknown encoding')
    } catch (error) {
      expect((error as CodeIndexError).code).toBe(CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED)
    }
  })

  it('fails closed instead of returning garbage when a zstd payload is corrupt', () => {
    const validBase64NonFrame = Buffer.from('definitely not a zstd frame').toString('base64')
    for (const corrupt of ['not-base64!!', validBase64NonFrame]) {
      try {
        decodeChunkText(CHUNK_TEXT_ENCODING_ZSTD, corrupt)
        expect.unreachable('decode must fail closed on a corrupt zstd payload')
      } catch (error) {
        expect(error).toBeInstanceOf(CodeIndexError)
        expect((error as CodeIndexError).code).toBe(CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED)
      }
    }
  })

  it('classifies the compression-eligibility threshold by UTF-8 bytes, not characters', () => {
    const exactlyThreshold = 'a'.repeat(CHUNK_TEXT_COMPRESSION_THRESHOLD_BYTES)
    expect(isChunkTextCompressionCandidate(exactlyThreshold)).toBe(false)
    expect(isChunkTextCompressionCandidate(`${exactlyThreshold}a`)).toBe(true)

    // 128 two-byte characters equal the byte threshold and stay ineligible.
    const multibyteAtThreshold = 'ä'.repeat(CHUNK_TEXT_COMPRESSION_THRESHOLD_BYTES / 2)
    expect(Buffer.byteLength(multibyteAtThreshold, 'utf8')).toBe(CHUNK_TEXT_COMPRESSION_THRESHOLD_BYTES)
    expect(isChunkTextCompressionCandidate(multibyteAtThreshold)).toBe(false)
  })

  it('keeps payloads on both sides of the 128-byte boundary on their policy side', () => {
    const exactly = 'a'.repeat(CHUNK_TEXT_COMPRESSION_THRESHOLD_BYTES)
    expect(encodeChunkText(exactly).encoding).toBe(CHUNK_TEXT_ENCODING_PLAIN)
    // One byte over the threshold crosses into compression candidacy; highly
    // repetitive filler shrinks, so the stored form becomes zstd.
    const justOver = `${exactly}aaaa`
    expect(isChunkTextCompressionCandidate(justOver)).toBe(true)
    expect(encodeChunkText(justOver).encoding).toBe(CHUNK_TEXT_ENCODING_ZSTD)
  })

  it('records the 1MB zstd round-trip cost without asserting on it', () => {
    // Numbered lines keep the payload representative of real source instead of
    // one pathologically repeated block.
    const lines: string[] = []
    for (let index = 0; index < 20_000; index += 1) {
      lines.push(`export function sample${index}(input: number): number {\n  return input * ${index} // padded body\n}\n`)
    }
    const megabyte = lines.join('')
    expect(Buffer.byteLength(megabyte, 'utf8')).toBeGreaterThan(1_000_000)
    const compressStart = performance.now()
    const encoded = encodeChunkText(megabyte)
    const compressMs = performance.now() - compressStart
    const decompressStart = performance.now()
    const decoded = decodeChunkText(encoded.encoding, encoded.payload)
    const decompressMs = performance.now() - decompressStart
    console.log(
      `[perf] zstd 1MB text: compress ${compressMs.toFixed(1)}ms `
        + `(payload ${(encoded.payload.length / 1024).toFixed(0)}KiB base64), `
        + `decompress ${decompressMs.toFixed(1)}ms`,
    )
    expect(decoded).toBe(megabyte)
  })
})
