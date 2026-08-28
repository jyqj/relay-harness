/**
 * Chunk text codec: converts between in-memory chunk text and the physical
 * `(text_encoding, text)` column pair. `'plain'` stores the text unchanged;
 * `'zstd'` stores a Zstandard frame as base64 text so the payload keeps the
 * column's TEXT contract — readers and the embedding drain see a string in
 * both encodings and decode through this module only.
 *
 * @module @relay-harness/rlh-code-index-sqlite/codec
 */

import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import {
  CodeIndexError,
  CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED,
} from '@relay-harness/rlh-code-index'

/** Encoding tag stored beside every chunk payload. */
export type ChunkTextEncoding = 'plain' | 'zstd'

/** Encoding for payloads kept as their own text. */
export const CHUNK_TEXT_ENCODING_PLAIN: ChunkTextEncoding = 'plain'

/** Encoding for payloads stored as a base64-wrapped Zstandard frame. */
export const CHUNK_TEXT_ENCODING_ZSTD: ChunkTextEncoding = 'zstd'

/**
 * Zstandard compression level, matching the session-log compression decision
 * (`packages/session/session-persistence-sqlite/src/compression.ts`).
 */
const ZSTD_COMPRESSION_LEVEL = 3

/**
 * Storage record for one chunk's text, mirroring the physical columns.
 * The two halves never merge into one prefixed string so readers can filter
 * and project each column independently. Both encodings store the payload as
 * column-aligned text: `'plain'` verbatim, `'zstd'` base64.
 */
export interface EncodedChunkText {
  readonly encoding: ChunkTextEncoding
  readonly payload: string
}

/**
 * Payload size at or below which compression never pays off (bytes, UTF-8).
 * Ported from the reference implementation's deterministic policy:
 * payloads of at most 128 bytes store as plain text without inspection.
 */
export const CHUNK_TEXT_COMPRESSION_THRESHOLD_BYTES = 128

/**
 * Whether a payload is even eligible for compressed storage. Pure decision
 * half of the reference compression policy — the encoder still discards
 * candidates whose compressed output fails to shrink below the plain bytes.
 * @param text - chunk text to classify.
 * @returns true only for UTF-8 payloads strictly larger than {@link CHUNK_TEXT_COMPRESSION_THRESHOLD_BYTES}.
 */
export function isChunkTextCompressionCandidate(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') > CHUNK_TEXT_COMPRESSION_THRESHOLD_BYTES
}

/**
 * Encode chunk text into its storage form. Payloads at or below the threshold
 * stay plain; larger candidates compress at the fixed level and fall back to
 * plain when the frame does not shrink below the original bytes.
 * @param text - decoded chunk text.
 * @returns the encoding-tagged storage record.
 */
export function encodeChunkText(text: string): EncodedChunkText {
  if (!isChunkTextCompressionCandidate(text)) {
    return { encoding: CHUNK_TEXT_ENCODING_PLAIN, payload: text }
  }
  const original = Buffer.from(text, 'utf8')
  const compressed = zstdCompressSync(original, {
    params: { [constants.ZSTD_c_compressionLevel]: ZSTD_COMPRESSION_LEVEL },
  })
  if (compressed.length >= original.length) {
    return { encoding: CHUNK_TEXT_ENCODING_PLAIN, payload: text }
  }
  return { encoding: CHUNK_TEXT_ENCODING_ZSTD, payload: compressed.toString('base64') }
}

/**
 * Decode one stored `(text_encoding, text)` pair back to chunk text.
 * @param encoding - encoding tag read from `chunks.text_encoding`.
 * @param payload - stored text read from `chunks.text`.
 * @returns the original chunk text.
 * @throws {CodeIndexError} with `CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED` when
 *   the tag names an encoding this reader does not register, or when a
 *   `'zstd'` payload fails to decompress — never guessed at.
 */
export function decodeChunkText(encoding: string, payload: string): string {
  if (encoding === CHUNK_TEXT_ENCODING_PLAIN) return payload
  if (encoding === CHUNK_TEXT_ENCODING_ZSTD) {
    let decoded: Buffer
    try {
      decoded = zstdDecompressSync(Buffer.from(payload, 'base64'))
    } catch (error) {
      throw new CodeIndexError(
        `chunk text encoding 'zstd' payload failed to decompress: ${String(error)}`,
        CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED,
      )
    }
    return decoded.toString('utf8')
  }
  throw new CodeIndexError(
    `chunk text encoding ${JSON.stringify(encoding)} is not supported by this code-index reader`,
    CODE_INDEX_SCHEMA_VERSION_UNSUPPORTED,
  )
}
