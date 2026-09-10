#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { verifyWorkflowPnpm } from './verify-workflow-pnpm.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPOSITORY_ROOT = resolve(ROOT, '..')
const STATUS = resolve(ROOT, 'docs/feature-status.json')
const REQUIRED_EVIDENCE = ['composition', 'remote', 'ui', 'e2e', 'docs']
const REQUIRED_WORKFLOWS = [
  'build-exe-for-python-sdk.yml', 'ci.yml', 'docs-pages.yml', 'e2b-e2e.yml',
  'e2e.yml', 'expected-filenames.yml', 'issue-lifecycle.yml', 'issue-policy.yml',
  'landlock-run-release.yml', 'landlock-run.yml', 'pi-ai-provider-e2e.yml',
  'python-release.yml', 'release-vendor.yml', 'release.yml', 'sandbox.yml',
]
const execFileAsync = promisify(execFile)

function fail(message) {
  throw new Error(`feature-status: ${message}`)
}

async function exists(path) {
  try { await stat(path); return true } catch { return false }
}

async function verifyEvidence(feature, category, rows) {
  if (!Array.isArray(rows) || rows.length === 0) fail(`${feature.id}: shipped feature lacks ${category} evidence`)
  for (const row of rows) {
    if (typeof row?.path !== 'string' || row.path.startsWith('/') || row.path.includes('..')) {
      fail(`${feature.id}: invalid ${category} evidence path`)
    }
    const absolute = resolve(ROOT, row.path)
    if (!absolute.startsWith(`${ROOT}/`) || !(await exists(absolute))) fail(`${feature.id}: missing ${row.path}`)
    if (row.contains !== undefined) {
      if (!Array.isArray(row.contains) || row.contains.length === 0) fail(`${feature.id}: empty contains list for ${row.path}`)
      const text = await readFile(absolute, 'utf8')
      for (const marker of row.contains) {
        if (typeof marker !== 'string' || !text.includes(marker)) fail(`${feature.id}: ${row.path} lacks ${JSON.stringify(marker)}`)
      }
    }
  }
}

async function verifyFeatures() {
  const model = JSON.parse(await readFile(STATUS, 'utf8'))
  if (model.schemaVersion !== 1 || model.runtimeRoot !== 'relay-harness') fail('unsupported manifest header')
  if (model.repositoryGovernance?.sourceLayout !== 'nested-monorepo'
    || model.repositoryGovernance?.workflowAuthority !== '.github/workflows') {
    fail('repository layout/workflow authority is not explicit')
  }
  if (!Array.isArray(model.features) || model.features.length === 0) fail('manifest has no features')
  const ids = new Set()
  for (const feature of model.features) {
    if (typeof feature.id !== 'string' || ids.has(feature.id)) fail(`invalid or duplicate id ${feature.id}`)
    ids.add(feature.id)
    if (!['shipped', 'partial', 'planned'].includes(feature.status)) fail(`${feature.id}: invalid status`)
    if (typeof feature.summary !== 'string' || feature.summary.length < 20) fail(`${feature.id}: summary is not meaningful`)
    if (!Array.isArray(feature.limitations) || feature.limitations.length === 0) fail(`${feature.id}: limitations must be explicit`)
    if (feature.status === 'shipped') {
      for (const category of REQUIRED_EVIDENCE) await verifyEvidence(feature, category, feature.evidence?.[category])
      const compositionPaths = feature.evidence.composition.map(row => row.path)
      if (!compositionPaths.some(path => path === 'packages/bundle/base/cordis.patch.yml'
        || path === 'packages/bundle/web-app/cordis.patch.yml')) {
        fail(`${feature.id}: shipped feature is not closed by a default bundle composition`)
      }
    } else {
      const rows = Object.values(feature.evidence ?? {}).flat()
      if (rows.length === 0) fail(`${feature.id}: non-shipped status still needs documentary evidence`)
      for (const [category, evidence] of Object.entries(feature.evidence ?? {})) await verifyEvidence(feature, category, evidence)
    }
  }
}

async function verifyWorkflowDiscovery() {
  if (!(await exists(ROOT))) fail('physical relay-harness/ runtime root is missing')
  const { stdout: nestedTracked } = await execFileAsync('git', ['ls-files', '--', 'relay-harness'], { cwd: REPOSITORY_ROOT })
  if (nestedTracked.trim() === '') fail('tracked relay-harness/ runtime root is missing')
  const workflowRoot = resolve(REPOSITORY_ROOT, '.github/workflows')
  const names = new Set(await readdir(workflowRoot))
  for (const name of REQUIRED_WORKFLOWS) if (!names.has(name)) fail(`root workflow missing ${name}`)
  for (const name of names) {
    if (!name.endsWith('.yml')) continue
    const text = await readFile(resolve(workflowRoot, name), 'utf8')
    if (/node \.\.\/scripts\//.test(text)) fail(`${name}: runtime command incorrectly escapes relay-harness`)
  }
  const ci = await readFile(resolve(workflowRoot, 'ci.yml'), 'utf8')
  if (!/working-directory:\s*relay-harness(?:\s|$)/.test(ci)) {
    fail('CI does not run from the relay-harness runtime root')
  }
  const dependabot = await readFile(resolve(REPOSITORY_ROOT, '.github/dependabot.yml'), 'utf8')
  if (!dependabot.includes('directory: "/relay-harness"')
    || !dependabot.includes('directory: "/relay-harness/python/sdk"')) {
    fail('Dependabot directories do not target the relay-harness runtime root')
  }
}

async function verifyDocsAuthority() {
  const rootReadme = await readFile(resolve(ROOT, 'README.md'), 'utf8')
  const context = await readFile(resolve(ROOT, 'docs/CONTEXT.md'), 'utf8')
  const docsMap = await readFile(resolve(ROOT, 'docs/README.md'), 'utf8')
  for (const [name, text] of [['README.md', rootReadme], ['docs/CONTEXT.md', context], ['docs/README.md', docsMap]]) {
    if (!text.includes('feature-status.json')) fail(`${name}: does not point to the feature-status authority`)
  }
  if (/Rust agent 的总体架构|Rust 技术基线/.test(docsMap)) fail('docs/README.md still presents Rust as current architecture')
  if (/产品语义仍是缺口：chat\/work 双模式、Prompt Enhancing/.test(context)) fail('docs/CONTEXT.md carries a stale feature claim')
}

async function markdownFiles(directory) {
  const rows = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) rows.push(...await markdownFiles(path))
    else if (entry.isFile() && entry.name.endsWith('.md')) rows.push(path)
  }
  return rows
}

const HTML_BLOCK = /^(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)$/i

/**
 * Remove Markdown regions in which the formal mdast link gate creates no
 * link/image/definition node. This dependency-free projection keeps the
 * pre-install governance check aligned with `verify-md-links` without trying
 * to treat documentation examples as repository references.
 * @param {string} source Markdown source.
 * @returns {string} Prose-only Markdown preserving source line boundaries.
 */
function markdownProse(source) {
  const output = []
  let fence
  let htmlUntilClose
  let htmlBlock = false
  let comment = false
  for (const line of source.split('\n')) {
    if (fence !== undefined) {
      const closing = line.match(/^ {0,3}(`+|~+)\s*$/)
      if (closing && closing[1][0] === fence.char && closing[1].length >= fence.length) fence = undefined
      output.push('')
      continue
    }
    const opening = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (opening) {
      fence = { char: opening[1][0], length: opening[1].length }
      output.push('')
      continue
    }
    if (comment) {
      if (line.includes('-->')) comment = false
      output.push('')
      continue
    }
    if (line.includes('<!--')) {
      comment = !line.slice(line.indexOf('<!--') + 4).includes('-->')
      output.push('')
      continue
    }
    if (htmlUntilClose !== undefined) {
      if (new RegExp(`</${htmlUntilClose}\\s*>`, 'i').test(line)) htmlUntilClose = undefined
      output.push('')
      continue
    }
    if (htmlBlock) {
      if (line.trim() === '') htmlBlock = false
      output.push('')
      continue
    }
    const htmlOpen = line.match(/^ {0,3}<([A-Za-z][A-Za-z0-9-]*)(?:\s|>|\/)/)
    if (htmlOpen && /^(?:pre|script|style|textarea)$/i.test(htmlOpen[1])) {
      if (!new RegExp(`</${htmlOpen[1]}\\s*>`, 'i').test(line)) htmlUntilClose = htmlOpen[1]
      output.push('')
      continue
    }
    if (htmlOpen && HTML_BLOCK.test(htmlOpen[1])) {
      htmlBlock = true
      output.push('')
      continue
    }
    if (/^(?: {4}|\t)/.test(line)) {
      output.push('')
      continue
    }
    output.push(line
      .replace(/<(?:code|pre)\b[^>]*>[\s\S]*?<\/(?:code|pre)>/gi, '')
      .replace(/(`+)[^`]*?\1/g, ''))
  }
  return output.join('\n')
}

/**
 * URLs represented by real Markdown link, image, or definition nodes.
 * @param {string} source Markdown source.
 * @returns {string[]} Link targets from prose nodes.
 */
export function markdownLinkTargets(source) {
  const prose = markdownProse(source)
  const targets = []
  for (const match of prose.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))[^\n]*?\)/g)) {
    targets.push(match[1] ?? match[2])
  }
  for (const match of prose.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm)) {
    targets.push(match[1] ?? match[2])
  }
  return targets.filter(target => typeof target === 'string')
}

function decodedPath(raw) {
  const path = raw.replace(/[#?].*$/, '')
  try { return decodeURIComponent(path) } catch { return path }
}

async function verifyRootMarkdownLinks() {
  const files = [resolve(ROOT, 'README.md'), ...await markdownFiles(resolve(ROOT, 'docs'))]
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const raw of markdownLinkTargets(text)) {
      if (/^(?:https?:|mailto:|#)/.test(raw)) continue
      const target = decodedPath(raw)
      if (target.length === 0) continue
      if (target.startsWith('/')) fail(`${file.slice(ROOT.length + 1)}: repository-local link must be relative: ${raw}`)
      if (!(await exists(resolve(dirname(file), target)))) fail(`${file.slice(ROOT.length + 1)}: broken link ${raw}`)
    }
  }
}

export async function main() {
  await verifyFeatures()
  await verifyWorkflowDiscovery()
  await verifyWorkflowPnpm(resolve(REPOSITORY_ROOT, '.github/workflows'))
  await verifyDocsAuthority()
  await verifyRootMarkdownLinks()
  console.log('feature-status: PASS')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main()
