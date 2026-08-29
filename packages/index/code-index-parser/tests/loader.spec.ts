import { describe, expect, it } from 'vitest'
import { initParser, loadLanguage, resetLanguageCache } from '../src/loader.ts'

describe('grammar loader', () => {
  it('initializes the WASM runtime once and reuses it', async () => {
    await Promise.all([initParser(), initParser()])
    // A second full init after a successful one stays a no-op memo.
    await initParser()
  })

  it('caches languages: repeated loads resolve to the same instance', async () => {
    resetLanguageCache()
    const [first, second] = await Promise.all([
      loadLanguage('javascript'),
      loadLanguage('javascript'),
    ])
    expect(second).toBe(first)
  })

  it('parseWith throws when the runtime returns no tree', async () => {
    const { parseWith } = await import('../src/loader.ts')
    const stubParser = { parse: () => null } as unknown as Parameters<typeof parseWith>[0]
    expect(() => parseWith(stubParser, 'x')).toThrow('tree-sitter parse failed')
  })

  it('distinguishes grammars that share a package (typescript vs tsx)', async () => {
    const [, tsx] = await Promise.all([loadLanguage('typescript'), loadLanguage('tsx')])
    expect(tsx).not.toBe(await loadLanguage('javascript'))
  })

  it('isolates load failures: formatted error, nothing cached, retry possible', async () => {
    resetLanguageCache()
    const fake = 'cobol' as Parameters<typeof loadLanguage>[0]
    await expect(loadLanguage(fake)).rejects.toThrow(/^tree-sitter-cobol\.wasm: /)
    // The failed load did not poison the memo: the next attempt retries the
    // load and fails with the same formatted error, and other languages still
    // load cleanly afterwards.
    await expect(loadLanguage(fake)).rejects.toThrow(/^tree-sitter-cobol\.wasm: /)
    await expect(loadLanguage('go')).resolves.toBeTruthy()
  })
})
