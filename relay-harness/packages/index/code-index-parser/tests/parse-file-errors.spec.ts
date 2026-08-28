import { describe, expect, it, vi } from 'vitest'

// Force grammar-load failures so parseFile's extraction catch records a
// formatted error instead of throwing.
const loadMock = vi.fn((_name: string): Promise<never> => Promise.reject(new Error('no load configured')))
vi.mock('../src/loader.ts', () => ({
  initParser: vi.fn(async () => {}),
  loadLanguage: (name: string) => loadMock(name),
  resetLanguageCache: vi.fn(),
}))

const { parseFile } = await import('../src/index.ts')

describe('parseFile failure handling', () => {
  it('counts extraction failures with the "<file>: <message>" format', async () => {
    loadMock.mockRejectedValueOnce(new Error('grammar disk failure'))
    const outcome = await parseFile('src/x.js', 'const ok = 1;', {
      projectRoot: '/proj',
      maxFileBytes: 1000,
    })
    expect(outcome).not.toBeNull()
    expect(outcome!.parseErrors).toEqual(['src/x.js: grammar disk failure'])
    expect(outcome!.parseErrorCount).toBe(1)
    expect(outcome!.symbols).toEqual([])
    expect(outcome!.summary).toBe('src/x.js (javascript, 1 lines, 0 symbols)')
    expect(outcome!.contentExcerpt).toBe('')
  })

  it('stringifies non-Error rejection values the same way', async () => {
    loadMock.mockRejectedValueOnce('plain string failure')
    const outcome = await parseFile('src/y.js', 'const ok = 1;', {
      projectRoot: '/proj',
      maxFileBytes: 1000,
    })
    expect(outcome!.parseErrors).toEqual(['src/y.js: plain string failure'])
  })
})
