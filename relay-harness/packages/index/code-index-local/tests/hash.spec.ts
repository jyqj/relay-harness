/** Content-hash helpers: deterministic truncation over memory and streamed files. */

import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTENT_HASH_HEX_LENGTH, contentHash, contentHashFile } from '../src/hash.ts'

const roots: string[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('contentHash', () => {
  it('truncates the full SHA-256 digest to sixteen hex characters', () => {
    const bytes = new Uint8Array([1, 2, 3])
    const expected = createHash('sha256').update(bytes).digest('hex')
    expect(contentHash(bytes)).toBe(expected.slice(0, 16))
    expect(contentHash('')).toMatch(/^[0-9a-f]{16}$/u)
    expect(CONTENT_HASH_HEX_LENGTH).toBe(16)
  })

  it('agrees between text and byte spellings of the same payload', () => {
    expect(contentHash('héllo 世界')).toEqual(contentHash(new TextEncoder().encode('héllo 世界')))
  })
})

describe('contentHashFile', () => {
  it('streams the same identity as the in-memory hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-cih-'))
    roots.push(root)
    const filePath = join(root, 'payload.bin')
    const payload = Buffer.concat([
      Buffer.alloc(70_000, 7),
      Buffer.from('tài 子续流'),
    ])
    await writeFile(filePath, payload)
    expect(await contentHashFile(filePath)).toBe(contentHash(new Uint8Array(payload)))
  })

  it('rejects when the stream cannot open its target', async () => {
    await expect(contentHashFile('/nonexistent/rlh-hash-target')).rejects.toThrow()
  })
})
