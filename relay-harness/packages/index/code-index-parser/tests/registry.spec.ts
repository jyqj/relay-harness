import { describe, expect, it } from 'vitest'
import { languageForPath, supportedLanguageFor, tierForLanguage } from '../src/registry.ts'
import type { LanguageName } from '../src/registry.ts'

/** Full extension map transcribed from the reference implementation. */
const EXTENSION_TABLE: ReadonlyArray<readonly [string, LanguageName]> = [
  ['a.py', 'python'],
  ['a.js', 'javascript'],
  ['a.mjs', 'javascript'],
  ['a.cjs', 'javascript'],
  ['a.ts', 'typescript'],
  ['a.mts', 'typescript'],
  ['a.cts', 'typescript'],
  ['a.tsx', 'tsx'],
  ['a.jsx', 'jsx'],
  ['a.java', 'java'],
  ['a.go', 'go'],
  ['a.rs', 'rust'],
  ['a.vue', 'vue'],
  ['a.svelte', 'svelte'],
  ['a.md', 'markdown'],
  ['a.mdx', 'markdown'],
  ['a.cs', 'csharp'],
  ['a.php', 'php'],
  ['a.rb', 'ruby'],
  ['a.rake', 'ruby'],
  ['a.swift', 'swift'],
  ['a.kt', 'kotlin'],
  ['a.kts', 'kotlin'],
  ['a.c', 'c'],
  ['a.h', 'c'],
  ['a.cpp', 'cpp'],
  ['a.cc', 'cpp'],
  ['a.cxx', 'cpp'],
  ['a.hpp', 'cpp'],
  ['a.hxx', 'cpp'],
  ['a.dart', 'dart'],
  ['a.scala', 'scala'],
  ['a.sc', 'scala'],
  ['a.lua', 'lua'],
  ['a.luau', 'lua'],
  ['a.sql', 'sql'],
  ['a.yaml', 'yaml'],
  ['a.yml', 'yaml'],
  ['a.toml', 'toml'],
  ['a.tf', 'hcl'],
  ['a.tfvars', 'hcl'],
  ['a.sh', 'bash'],
  ['a.bash', 'bash'],
  ['a.zsh', 'bash'],
  ['a.proto', 'protobuf'],
  ['a.graphql', 'graphql'],
  ['a.gql', 'graphql'],
  ['a.cmake', 'cmake'],
]

describe('language registry', () => {
  it.each(EXTENSION_TABLE)('classifies %s as %s', (path, language) => {
    expect(languageForPath(path)).toBe(language)
  })

  it('returns unknown for unrecognized or extensionless paths', () => {
    expect(languageForPath('a.zig')).toBe('unknown')
    expect(languageForPath('Makefile')).toBe('unknown')
    expect(languageForPath('a')).toBe('unknown')
  })

  it('accepts the ten grammar-backed language names', () => {
    expect(supportedLanguageFor('src/a.js')).toBe('javascript')
    expect(supportedLanguageFor('src/a.mjs')).toBe('javascript')
    expect(supportedLanguageFor('src/a.cjs')).toBe('javascript')
    expect(supportedLanguageFor('src/a.ts')).toBe('typescript')
    expect(supportedLanguageFor('src/a.mts')).toBe('typescript')
    expect(supportedLanguageFor('src/a.cts')).toBe('typescript')
    expect(supportedLanguageFor('src/a.tsx')).toBe('tsx')
    expect(supportedLanguageFor('src/a.jsx')).toBe('jsx')
    expect(supportedLanguageFor('a.py')).toBe('python')
    expect(supportedLanguageFor('a.rs')).toBe('rust')
    expect(supportedLanguageFor('a.go')).toBe('go')
    expect(supportedLanguageFor('a.java')).toBe('java')
    expect(supportedLanguageFor('a.c')).toBe('c')
    expect(supportedLanguageFor('a.h')).toBe('c')
    expect(supportedLanguageFor('a.cpp')).toBe('cpp')
    expect(supportedLanguageFor('a.cc')).toBe('cpp')
    expect(supportedLanguageFor('a.cxx')).toBe('cpp')
    expect(supportedLanguageFor('a.hpp')).toBe('cpp')
    expect(supportedLanguageFor('a.hxx')).toBe('cpp')
  })

  it('accepts the eight spec-driven language names', () => {
    expect(supportedLanguageFor('a.cs')).toBe('csharp')
    expect(supportedLanguageFor('a.php')).toBe('php')
    expect(supportedLanguageFor('a.rb')).toBe('ruby')
    expect(supportedLanguageFor('a.rake')).toBe('ruby')
    expect(supportedLanguageFor('a.swift')).toBe('swift')
    expect(supportedLanguageFor('a.kt')).toBe('kotlin')
    expect(supportedLanguageFor('a.kts')).toBe('kotlin')
    expect(supportedLanguageFor('a.dart')).toBe('dart')
    expect(supportedLanguageFor('a.scala')).toBe('scala')
    expect(supportedLanguageFor('a.sc')).toBe('scala')
    expect(supportedLanguageFor('a.lua')).toBe('lua')
    expect(supportedLanguageFor('a.luau')).toBe('lua')
  })

  it('accepts the SFC language names', () => {
    expect(supportedLanguageFor('src/App.vue')).toBe('vue')
    expect(supportedLanguageFor('src/lib.svelte')).toBe('svelte')
  })

  it('rejects languages without a parser', () => {
    expect(supportedLanguageFor('a.md')).toBeNull()
    expect(supportedLanguageFor('Makefile')).toBeNull()
  })

  it('assigns the semantic tier to the JS/TS family, Python, and Rust', () => {
    for (const language of ['javascript', 'typescript', 'tsx', 'jsx', 'python', 'rust'] as const) {
      expect(tierForLanguage(language)).toEqual({ tier: 'semantic', confidence: 0.85 })
    }
  })

  it('assigns the tree-sitter tier to Go, Java, C, and C++', () => {
    for (const language of ['go', 'java', 'c', 'cpp'] as const) {
      expect(tierForLanguage(language)).toEqual({ tier: 'tree-sitter', confidence: 0.7 })
    }
  })

  it('assigns the heuristic tier to the spec-driven languages', () => {
    for (const language of ['csharp', 'php', 'ruby', 'swift', 'kotlin', 'dart', 'scala', 'lua'] as const) {
      expect(tierForLanguage(language)).toEqual({ tier: 'heuristic', confidence: 0.5 })
    }
  })

  it('assigns the SFC languages the heuristic tier with the reference confidence pin', () => {
    // The reference `parse_sfc` hardcodes 0.78 despite the heuristic default 0.5.
    for (const language of ['vue', 'svelte'] as const) {
      expect(tierForLanguage(language)).toEqual({ tier: 'heuristic', confidence: 0.78 })
    }
  })

  it('has no tier for languages without a parser', () => {
    expect(tierForLanguage('unknown')).toBeNull()
    expect(tierForLanguage('markdown')).toBeNull()
  })
})
