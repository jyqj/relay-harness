/**
 * Stable, deterministic id generation (SHA-256 instead of the reference
 * implementation's blake3 — Node ships SHA-256; ids are NOT compatible with
 * the Rust implementation's, which is fine: the two stores never mix).
 *
 * Per-occurrence ids hash the occurrence's line/column as little-endian u32
 * words (the reference `to_le_bytes` input encoding), so two records with
 * equal text at different positions never collide. Semantic ids
 * ({@link symbolUid}) stay content-derived: same-key overloads within a file
 * can share a uid, and the graph writer's dedupe pass resolves that
 * deterministically (first record wins).
 *
 * Input constructions are locked by `tests/id.spec.ts`.
 * @module
 */

import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

/**
 * Collapse every whitespace run to one space and trim (reference `normalize_signature`).
 * @param text - arbitrary text.
 * @returns the whitespace-normalized text.
 */
export function normalizeWhitespace(text: string): string {
  return text.split(/\s+/).filter(part => part.length > 0).join(' ')
}

function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex')
}

/**
 * Encode the position words the way the reference hashes them: two
 * little-endian unsigned 32-bit values (`line.to_le_bytes()`,
 * `col.to_le_bytes()`).
 * @param line - 1-based line.
 * @param col - 0-based UTF-8 byte column.
 * @returns the 8-byte little-endian encoding of the position.
 */
function positionWords(line: number, col: number): Buffer {
  const encoded = Buffer.alloc(8)
  encoded.writeUInt32LE(line, 0)
  encoded.writeUInt32LE(col, 4)
  return encoded
}

/**
 * Semantic identity of a symbol: changes only when the qualified identity
 * changes, never on line drift. `"uid:" + sha256("sym:" + file + "\0" + qname
 * + "\0" + kind [+ "\0" + normalizeWhitespace(signature)]).hex[0..24]`.
 * @param file - workspace-relative file path.
 * @param qname - qualified symbol name.
 * @param kind - symbol kind string.
 * @param signature - optional signature; whitespace-normalized before hashing.
 * @returns the `uid:<hex24>` identifier.
 */
export function symbolUid(file: string, qname: string, kind: string, signature?: string): string {
  let input = `sym:${file}\0${qname}\0${kind}`
  if (signature !== undefined) input += `\0${normalizeWhitespace(signature)}`
  return `uid:${sha256(input).slice(0, 24)}`
}

/**
 * Positional identity of a symbol reference:
 * `"ref:" + sha256("ref:" + file + "\0" + name + ":" + line_le32 +
 * col_le32).hex[0..16]`.
 * @param file - workspace-relative file path.
 * @param name - referenced identifier.
 * @param line - 1-based line.
 * @param col - 0-based UTF-8 byte column.
 * @returns the `ref:<hex16>` identifier.
 */
export function refId(file: string, name: string, line: number, col: number): string {
  const input = Buffer.concat([
    Buffer.from(`ref:${file}\0${name}:`, 'utf8'),
    positionWords(line, col),
  ])
  return `ref:${sha256(input).slice(0, 16)}`
}

/**
 * Positional identity of an edge of `kind`:
 * `kind + ":" + sha256(kind + ":" + file + ":" + line_le32 +
 * col_le32).hex[0..16]`. Two occurrences of the same text at different
 * positions hash differently, so per-occurrence store keys stay unique.
 * @param kind - edge family prefix (`call`, `lit`, `sym`, ...).
 * @param file - workspace-relative file path.
 * @param line - 1-based line.
 * @param col - 0-based UTF-8 byte column.
 * @returns the `<kind>:<hex16>` identifier.
 */
export function edgeId(kind: string, file: string, line: number, col: number): string {
  const input = Buffer.concat([
    Buffer.from(`${kind}:${file}:`, 'utf8'),
    positionWords(line, col),
  ])
  return `${kind}:${sha256(input).slice(0, 16)}`
}

/**
 * Positional identity of an indexed literal (same construction as
 * {@link edgeId} with the `lit` kind).
 * @param file - workspace-relative file path.
 * @param line - 1-based line.
 * @param col - 0-based UTF-8 byte column.
 * @returns the `lit:<hex16>` identifier.
 */
export function literalId(file: string, line: number, col: number): string {
  return edgeId('lit', file, line, col)
}

/**
 * Positional identity of a chunk (`chunk:<file>:<index>`).
 * @param file - workspace-relative file path.
 * @param chunkIndex - 0-based chunk position.
 * @returns the `chunk:<file>:<index>` identifier.
 */
export function chunkId(file: string, chunkIndex: number): string {
  return `chunk:${file}:${chunkIndex}`
}
