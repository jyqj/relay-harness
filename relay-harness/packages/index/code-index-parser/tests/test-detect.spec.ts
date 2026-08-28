import { describe, expect, it } from 'vitest'
import { isTestFile } from '../src/test-detect.ts'

describe('test-file detection (reference parse_common.rs table)', () => {
  it('rust: /tests/ directories or _test.rs suffixes', () => {
    expect(isTestFile('crates/x/tests/it.rs', 'rust')).toBe(true)
    expect(isTestFile('crates/x/src/thing_test.rs', 'rust')).toBe(true)
    expect(isTestFile('crates/x/src/thing.rs', 'rust')).toBe(false)
  })

  it('python: tests dirs, test_ prefixes, _test.py and tests.py suffixes', () => {
    expect(isTestFile('pkg/tests/helper.py', 'python')).toBe(true)
    expect(isTestFile('pkg/test_util.py', 'python')).toBe(true)
    expect(isTestFile('pkg/mod_test.py', 'python')).toBe(true)
    expect(isTestFile('pkg/tests.py', 'python')).toBe(true)
    expect(isTestFile('pkg/mod.py', 'python')).toBe(false)
  })

  it('js/ts family: .test., .spec., __tests__', () => {
    for (const language of ['javascript', 'typescript', 'tsx', 'jsx'] as const) {
      expect(isTestFile(`src/a.test.${language}`, language)).toBe(true)
      expect(isTestFile(`src/a.spec.${language}`, language)).toBe(true)
      expect(isTestFile(`src/__tests__/a.${language}`, language)).toBe(true)
      expect(isTestFile(`src/a.${language}`, language)).toBe(false)
    }
  })

  it('go: _test.go suffix', () => {
    expect(isTestFile('pkg/server_test.go', 'go')).toBe(true)
    expect(isTestFile('pkg/server.go', 'go')).toBe(false)
  })

  it('java: filename-based Test prefix/suffix', () => {
    expect(isTestFile('src/main/java/com/Thing.java', 'java')).toBe(false)
    expect(isTestFile('src/TestThing.java', 'java')).toBe(true)
    expect(isTestFile('src/ThingTest.java', 'java')).toBe(true)
  })

  it('c/cpp: shared lowercase rules', () => {
    for (const language of ['c', 'cpp'] as const) {
      expect(isTestFile(`src/A_TEST.${language}`, language)).toBe(true)
      expect(isTestFile(`src/a_test.${language === 'c' ? 'cpp' : 'c'}`, language)).toBe(true)
      expect(isTestFile('src/test_thing.c', language)).toBe(true)
      expect(isTestFile('src/tests/thing.c', language)).toBe(true)
      expect(isTestFile('src/thing_tests.cpp', language)).toBe(true)
      expect(isTestFile('src/thing.c', language)).toBe(false)
    }
  })

  it('languages without heuristics are never test files', () => {
    expect(isTestFile('spec/thing.rb', 'ruby')).toBe(false)
    expect(isTestFile('internal/x.go', 'kotlin')).toBe(false)
    expect(isTestFile('a.md', 'unknown')).toBe(false)
  })
})
