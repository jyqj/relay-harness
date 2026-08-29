import { describe, expect, it, vi } from 'vitest'

// Force a non-Error rejection from Language.load to cover the loader's
// message formatting fallback and the stale-promise cache cleanup.
vi.mock('web-tree-sitter', () => ({
  Parser: { init: vi.fn(async () => {}) },
  Language: {
    load: vi.fn(async () => {
      throw 'wasm disk exploded'
    }),
  },
}))

const { loadLanguage, resetLanguageCache } = await import('../src/loader.ts')

describe('grammar loader failure formatting', () => {
  it('formats non-Error rejections and keeps the cache clean', async () => {
    resetLanguageCache()
    // The mocked Language.load rejects with a bare string; the wasm file
    // itself exists, so the read succeeds and the mock throws.
    const pending = loadLanguage('javascript')
    // Dropping the memo before the rejection resolves leaves the stale
    // promise's cleanup a no-op (slot already replaced).
    resetLanguageCache()
    await expect(pending).rejects.toThrow('tree-sitter-javascript.wasm: wasm disk exploded')
  })
})
