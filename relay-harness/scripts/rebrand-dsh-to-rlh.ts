/**
 * Idempotent codemod: rebrand DeepSeek Harness (dsh) to Relay Harness (rlh).
 *
 * Rewrites tracked file contents and renames tracked files/directories:
 * - npm scope `@deepseek-ai/` -> `@relay-harness/` (harness and vendored packages)
 * - package/product names `deepseek-harness` / `DeepSeek Harness` -> `relay-harness` / `Relay Harness`
 * - CLI/bin/env/identifier tokens `dsh` / `Dsh` / `DSH_` -> `rlh` / `Rlh` / `RLH_`
 * - CSS custom properties `--dsw-*` -> `--rlw-*`, `--dsh-*` -> `--rlh-*`, `--ds-*` -> `--rl-*`
 * - repository URLs -> github.com/jyqj/relay-harness
 *
 * Never touched: `pnpm-lock.yaml` (regenerate with `pnpm install`), frozen
 * archived Agent Notes (`.agents/notes/archived/`), vendor LLM API references
 * (`DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `api.deepseek.com`, model names,
 * `llm-deepseek` suffix), and external ecosystem project URLs (dshget.com,
 * dshdesktop.com, dataelement/dsh-desktop).
 *
 * Usage: node --experimental-strip-types scripts/rebrand-dsh-to-rlh.ts [--dry-run]
 * Idempotent: outputs never match any rule input, so a second run is a no-op.
 */

import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DRY_RUN = process.argv.includes('--dry-run')
const SELF = 'scripts/rebrand-dsh-to-rlh.ts'

/** Spans that must survive every content rule, in match order. */
const PROTECTED: RegExp[] = [
  // Links into frozen archived Agent Notes keep their historical dsh filenames.
  /[\w\-./]*notes\/archived\/[\w\-./]*/g,
  // Third-party plugin registry: live HTTP endpoints and community plugin pages.
  /(?:https?:\/\/)?awesome-dsh-plugin\.com[^\s"'`),\]]*/g,
  /github\.com\/awesome-dsh-plugin\/awesome-dsh-plugin/g,
  /\bawesome-dsh-plugin\b/g,
  /(?:https?:\/\/)?(?:www\.)?dshmarket\.com/g,
  /(?:github\.com|github\/stars)\/dsh-market\/dsh-market(?:\.git)?/g,
  // Community plugin identities: npm names and GitHub install specs owned by others.
  /@dsh-external\/[\w.-]+/g,
  /github:[\w.-]+\/dsh-[\w./#:-]+/g,
  /github\.com\/[\w.-]+\/dsh-[\w.-]+/g,
  /\bdsh-(?:composer-expand|status-rotator|aionui-panel|spotlight|genui|skins|web-ui|wallpaper-engine|whale-desktop-launcher)\b/g,
  // External ecosystem projects (not this repository's brand).
  /github\.com\/dataelement\/dsh-desktop/g,
  /github\.com\/bobby-sheng\/dshget-data/g,
  /(?:www\.)?dshget\.com/g,
  /dshdesktop\.com/g,
  /\bdsh-desktop\b/g,
  /\bDSH Get\b/g,
]

/**
 * Verbatim mirror of the third-party plugin registry. Every plugin name, owner,
 * npm coordinate, and page URL belongs to its author, so only the leading CLI
 * token of each `install` command names this repository's binary.
 */
const REGISTRY_SNAPSHOT = 'apps/desktop/src/main/marketplace-registry-snapshot.json'

interface Rule {
  find: RegExp
  replace: string
}

const rule = (find: RegExp, replace: string): Rule => ({ find, replace })

/** Ordered content rules; more specific patterns run before generic ones. */
const RULES: Rule[] = [
  // Repository and product URLs.
  rule(/github\.com\/deepseek-ai\/deepseek-harness/g, 'github.com/jyqj/relay-harness'),
  rule(/github\.com\/ChisaAlter\/Deepseek-Harness-Desktop/g, 'github.com/jyqj/relay-harness'),
  rule(/github\.com\/deepseek-harness\//g, 'github.com/relay-harness/'),
  rule(/ai\.deepseek\.harness\.gui/g, 'com.relayharness.desktop'),
  // npm scope (harness packages and rescoped vendor packages).
  rule(/@deepseek-ai\//g, '@relay-harness/'),
  rule(/@deepseek-ai/g, '@relay-harness'),
  // Product/package name variants.
  rule(/deepseek_harness/g, 'relay_harness'),
  rule(/deepseek-harness/g, 'relay-harness'),
  rule(/Deepseek-Harness-Desktop/g, 'Relay-Harness-Desktop'),
  rule(/DeepSeekHarness/g, 'RelayHarness'),
  rule(/DeepSeek Harness/g, 'Relay Harness'),
  rule(/Deepseek Harness/g, 'Relay Harness'),
  rule(/deepseek harness/g, 'relay harness'),
  // CSS custom properties (web tokens before the shorter motion prefix).
  rule(/--dsw-static-deepseek-/g, '--rlw-static-relay-'),
  rule(/--dsw-/g, '--rlw-'),
  rule(/dsw\|dsh\|ds/g, 'rlw|rlh|rl'),
  rule(/--ds-/g, '--rl-'),
  // Uppercase brand compounds (lookbehind keeps HANDSHAKE etc. intact).
  rule(/(?<![A-Za-z0-9])DSHMARKET/g, 'RLHMARKET'),
  rule(/(?<![A-Za-z0-9])DSHBOT/g, 'RLHBOT'),
  rule(/(?<![A-Za-z0-9])DSHD(?![a-z])/g, 'RLHD'),
  rule(/(?<![A-Za-z0-9])DSHM(?![A-Za-z])/g, 'RLHM'),
  rule(/(?<![A-Za-z0-9])DSH_/g, 'RLH_'),
  rule(/(?<![A-Za-z0-9])DSH(?![A-Za-z0-9_])/g, 'RLH'),
  // Lowercase brand compounds.
  rule(/(?<![A-Za-z0-9])dshbot/g, 'rlhbot'),
  rule(/(?<![A-Za-z0-9])dshmarket/g, 'rlhmarket'),
  rule(/(?<![A-Za-z0-9])dshd(?![a-z])/g, 'rlhd'),
  rule(/(?<![A-Za-z0-9])dshm(?![a-z])/g, 'rlhm'),
  rule(/(?<![A-Za-z0-9])dshunknown/g, 'rlhunknown'),
  // Identifier prefixes: DshEnvironmentKey, resolvedDshHome, dshHome, dsh-, .dsh, dsh CLI.
  rule(/Dsh/g, 'Rlh'),
  rule(/(?<![A-Za-z0-9])dsh(?![a-z])/g, 'rlh'),
]

/** Path-component rename rules (lowercase file names only). */
const NAME_RULES: Rule[] = [
  rule(/deepseek_harness/g, 'relay_harness'),
  rule(/deepseek-harness/g, 'relay-harness'),
  rule(/Deepseek-Harness-Desktop/g, 'Relay-Harness-Desktop'),
  rule(/dshbot/g, 'rlhbot'),
  rule(/dshmarket/g, 'rlhmarket'),
  rule(/(?<![a-z0-9])dsh(?![a-z])/g, 'rlh'),
]

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'ico', 'icns', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'wasm', 'node', 'zip', 'gz', 'tgz', 'br', 'jar', 'pdf', 'mp4', 'webm', 'mp3',
  'exe', 'dll', 'dylib', 'so', 'a', 'o', 'bin', 'sqlite', 'db', 'pack', 'idx', 'gguf',
])

function isExcluded(path: string): boolean {
  return path === 'pnpm-lock.yaml'
    || path === SELF
    || path.includes('.agents/notes/archived/')
}

function isBinaryPath(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return BINARY_EXTENSIONS.has(ext)
}

function applyRules(text: string, rules: Rule[]): string {
  let out = text
  for (const { find, replace } of rules) out = out.replace(find, replace)
  return out
}

/** Replace outside protected spans by masking them with unmatchable placeholders. */
function rewriteContent(text: string): string {
  const masked: string[] = []
  let working = text
  for (const pattern of PROTECTED) {
    working = working.replace(pattern, (span) => {
      masked.push(span)
      return `\u0000${masked.length - 1}\u0000`
    })
  }
  working = applyRules(working, RULES)
  return working.replace(/\u0000(\d+)\u0000/g, (_, index: string) => masked[Number(index)] as string)
}

function renameTarget(path: string): string {
  return path.split('/').map(component => applyRules(component, NAME_RULES)).join('/')
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
}

const files = git(['ls-files', '-z']).split('\0').filter(Boolean)
let contentChanged = 0
let renamed = 0

for (const path of files) {
  if (isExcluded(path) || isBinaryPath(path)) continue
  const absolute = join(ROOT, path)
  const stat = lstatSync(absolute)
  if (stat.isSymbolicLink()) continue
  const buffer = readFileSync(absolute)
  if (buffer.subarray(0, 8192).includes(0)) continue
  const text = buffer.toString('utf8')
  const next = path === REGISTRY_SNAPSHOT
    ? text.replace(/("install":\s*")dsh /g, '$1rlh ')
    : rewriteContent(text)
  if (next !== text) {
    contentChanged += 1
    if (DRY_RUN) console.log(`rewrite ${path}`)
    else writeFileSync(absolute, next)
  }
}

for (const path of files) {
  if (isExcluded(path)) continue
  const target = renameTarget(path)
  if (target === path) continue
  renamed += 1
  if (DRY_RUN) {
    console.log(`rename  ${path} -> ${target}`)
    continue
  }
  mkdirSync(join(ROOT, dirname(target)), { recursive: true })
  git(['mv', path, target])
}

console.log(`${DRY_RUN ? '[dry-run] ' : ''}content rewrites: ${contentChanged}, renames: ${renamed}`)
