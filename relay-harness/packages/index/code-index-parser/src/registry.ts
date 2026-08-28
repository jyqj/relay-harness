/**
 * Path-to-language classification and parser-tier assignment. The extension
 * map is transcribed from the reference implementation's `Language::
 * from_extension` (cc-model `lib.rs`); support covers the grammars vendored
 * in this phase plus the eight spec-driven (regex-heuristic) languages.
 * @module
 */

import type { ParserTier } from '@relay-harness/rlh-code-index'

/**
 * Language vocabulary recognized at path classification (lowercase, the
 * reference implementation's `as_str` names). `'unknown'` marks extensions
 * with no mapping.
 */
export type LanguageName =
  | 'python'
  | 'javascript'
  | 'typescript'
  | 'tsx'
  | 'jsx'
  | 'java'
  | 'go'
  | 'rust'
  | 'vue'
  | 'svelte'
  | 'markdown'
  | 'csharp'
  | 'php'
  | 'ruby'
  | 'swift'
  | 'kotlin'
  | 'c'
  | 'cpp'
  | 'dart'
  | 'scala'
  | 'lua'
  | 'sql'
  | 'yaml'
  | 'toml'
  | 'hcl'
  | 'dockerfile'
  | 'bash'
  | 'protobuf'
  | 'graphql'
  | 'cmake'
  | 'unknown'

/**
 * Languages with a parser. Ten names parse through vendored grammars (`jsx`
 * shares the JavaScript grammar; nine wasm files), `vue`/`svelte` reuse the
 * JS/TS grammars over their extracted `<script>` blocks (no dedicated wasm),
 * and the eight spec-driven names parse through regex heuristics with no
 * grammar at all.
 */
export type SupportedLanguage =
  | 'javascript'
  | 'typescript'
  | 'tsx'
  | 'jsx'
  | 'python'
  | 'rust'
  | 'go'
  | 'java'
  | 'c'
  | 'cpp'
  | 'vue'
  | 'svelte'
  | 'csharp'
  | 'php'
  | 'ruby'
  | 'swift'
  | 'kotlin'
  | 'dart'
  | 'scala'
  | 'lua'

const EXTENSION_TO_LANGUAGE: Readonly<Record<string, LanguageName>> = {
  py: 'python',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  jsx: 'jsx',
  java: 'java',
  go: 'go',
  rs: 'rust',
  vue: 'vue',
  svelte: 'svelte',
  md: 'markdown',
  mdx: 'markdown',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  rake: 'ruby',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  dart: 'dart',
  scala: 'scala',
  sc: 'scala',
  lua: 'lua',
  luau: 'lua',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  tf: 'hcl',
  tfvars: 'hcl',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  proto: 'protobuf',
  graphql: 'graphql',
  gql: 'graphql',
  cmake: 'cmake',
}

/**
 * Classify a workspace-relative path by extension (no extension → `'unknown'`).
 * @param relPath - workspace-relative file path.
 * @returns the classified language name.
 */
export function languageForPath(relPath: string): LanguageName {
  const dot = relPath.lastIndexOf('.')
  if (dot < 0) return 'unknown'
  return EXTENSION_TO_LANGUAGE[relPath.slice(dot + 1)] ?? 'unknown'
}

/**
 * The language a path parses with, or `null` when no vendored grammar applies.
 * @param relPath - workspace-relative file path.
 * @returns the supported language name or `null`.
 */
export function supportedLanguageFor(relPath: string): SupportedLanguage | null {
  const language = languageForPath(relPath)
  return SUPPORTED_LANGUAGES.has(language) ? (language as SupportedLanguage) : null
}

const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set<SupportedLanguage>([
  'javascript',
  'typescript',
  'tsx',
  'jsx',
  'python',
  'rust',
  'go',
  'java',
  'c',
  'cpp',
  'vue',
  'svelte',
  'csharp',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'dart',
  'scala',
  'lua',
])

/**
 * Tier + baseline confidence for a supported language, `null` for the rest.
 * @param language - classified language name.
 * @returns the parser tier with its baseline confidence, or `null`.
 */
export function tierForLanguage(language: LanguageName): { tier: ParserTier; confidence: number } | null {
  switch (language) {
    case 'javascript':
    case 'typescript':
    case 'tsx':
    case 'jsx':
    case 'python':
    case 'rust':
      return { tier: 'semantic', confidence: 0.85 }
    case 'go':
    case 'java':
    case 'c':
    case 'cpp':
      return { tier: 'tree-sitter', confidence: 0.7 }
    case 'vue':
    case 'svelte':
      // Named deviation from the tier default: the reference `parse_sfc`
      // hardcodes 0.78 on its outcome while `ParserTier::Heuristic` defaults
      // to 0.5, so the SFC languages carry the pin here.
      return { tier: 'heuristic', confidence: 0.78 }
    case 'csharp':
    case 'php':
    case 'ruby':
    case 'swift':
    case 'kotlin':
    case 'dart':
    case 'scala':
    case 'lua':
      return { tier: 'heuristic', confidence: 0.5 }
    default:
      return null
  }
}
