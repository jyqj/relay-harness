/**
 * Test-file heuristics per language, transcribed from the reference
 * implementation's `parse_common.rs::is_test_file`. Covers every classified
 * language (not just the vendored grammars); unknown languages are not test
 * files.
 * @module
 */

import type { LanguageName } from './registry.ts'

/**
 * Whether `relPath` looks like a test file for `language`, by the reference
 * implementation's path conventions.
 * @param relPath - workspace-relative file path.
 * @param language - classified language name.
 * @returns true when the path matches the language's test conventions.
 */
export function isTestFile(relPath: string, language: LanguageName): boolean {
  switch (language) {
    case 'rust':
      return relPath.includes('/tests/') || relPath.endsWith('_test.rs')
    case 'python':
      return relPath.includes('/tests/')
        || relPath.includes('test_')
        || relPath.includes('_test.py')
        || relPath.endsWith('tests.py')
    // JS/TS and dialects share the .test./.spec./__tests__ conventions.
    case 'javascript':
    case 'typescript':
    case 'tsx':
    case 'jsx':
      return relPath.includes('.test.')
        || relPath.includes('.spec.')
        || relPath.includes('__tests__')
    case 'go':
      return relPath.endsWith('_test.go')
    case 'java': {
      // Filename-based (not full-path) prefix/suffix checks, as upstream.
      const fileName = relPath.slice(relPath.lastIndexOf('/') + 1)
      return fileName.startsWith('Test') || fileName.endsWith('Test.java')
    }
    case 'c':
    case 'cpp': {
      const lower = relPath.toLowerCase()
      return lower.endsWith('_test.c')
        || lower.endsWith('_test.cpp')
        || lower.endsWith('_test.cc')
        || lower.endsWith('_test.cxx')
        || lower.includes('/test_')
        || lower.includes('/tests/')
        || lower.includes('_tests.c')
        || lower.includes('_tests.cpp')
    }
    default:
      return false
  }
}
