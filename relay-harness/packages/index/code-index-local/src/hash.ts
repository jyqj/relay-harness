/**
 * Content hashing for index identity: truncated SHA-256 hex digests stored on
 * every `files` row and compared during refresh passes.
 *
 * @module @relay-harness/rlh-code-index-local/hash
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/** Digest length persisted in `files.content_hash` (full SHA-256, truncated). */
export const CONTENT_HASH_HEX_LENGTH = 16

/** Render one SHA-256 digest as its leading lowercase hex prefix. */
function truncateDigest(digest: string): string {
  return digest.slice(0, CONTENT_HASH_HEX_LENGTH)
}

/**
 * Hash an in-memory payload.
 * @param data - raw bytes or UTF-8 text.
 * @returns 16 lowercase hex characters identifying the content revision.
 */
export function contentHash(data: Uint8Array | string): string {
  return truncateDigest(createHash('sha256').update(data).digest('hex'))
}

/**
 * Stream-hash a file from disk without loading it fully into memory.
 * @param filePath - absolute path to hash.
 * @returns 16 lowercase hex characters identifying the file's bytes.
 */
export function contentHashFile(filePath: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', (error) => {
      rejectPromise(error)
    })
    stream.on('end', () => {
      resolvePromise(truncateDigest(hash.digest('hex')))
    })
  })
}
