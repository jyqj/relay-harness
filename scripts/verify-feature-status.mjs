#!/usr/bin/env node
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATUS = resolve(ROOT, 'docs/feature-status.json')
const REQUIRED_EVIDENCE = ['composition', 'remote', 'ui', 'e2e', 'docs']
const REQUIRED_WORKFLOWS = [
  'ci.yml', 'docs-pages.yml', 'e2e.yml', 'release.yml', 'release-vendor.yml',
  'sandbox.yml', 'landlock-run.yml', 'landlock-run-release.yml',
  'python-release.yml', 'build-exe-for-python-sdk.yml',
]

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
      if (!compositionPaths.some(path => path.endsWith('/packages/bundle/base/cordis.patch.yml') || path.endsWith('/packages/bundle/web-app/cordis.patch.yml'))) {
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
  if (await exists(resolve(ROOT, 'relay-harness/.github'))) fail('nested relay-harness/.github is a false GitHub authority')
  const workflowRoot = resolve(ROOT, '.github/workflows')
  const names = new Set(await readdir(workflowRoot))
  for (const name of REQUIRED_WORKFLOWS) if (!names.has(name)) fail(`root workflow missing ${name}`)
  for (const name of names) {
    if (!name.endsWith('.yml')) continue
    const text = await readFile(resolve(workflowRoot, name), 'utf8')
    if (!text.includes('working-directory: relay-harness')) fail(`${name}: no explicit monorepo working-directory`)
    if (/hashFiles\(['"]pnpm-lock\.yaml['"]\)/.test(text)) fail(`${name}: hashes a nonexistent root lockfile`)
    if (/cache-dependency-path:\s*pnpm-lock\.yaml/.test(text)) fail(`${name}: caches a nonexistent root lockfile`)
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

async function verifyRootMarkdownLinks() {
  const files = [resolve(ROOT, 'README.md'), ...await markdownFiles(resolve(ROOT, 'docs'))]
  for (const file of files) {
    const text = await readFile(file, 'utf8')
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = match[1].trim().replace(/^<|>$/g, '')
      if (/^(?:https?:|mailto:|#)/.test(raw)) continue
      const target = decodeURIComponent(raw.split('#', 1)[0].split('?', 1)[0])
      if (target.length === 0) continue
      if (target.startsWith('/')) fail(`${file.slice(ROOT.length + 1)}: repository-local link must be relative: ${raw}`)
      if (!(await exists(resolve(dirname(file), target)))) fail(`${file.slice(ROOT.length + 1)}: broken link ${raw}`)
    }
  }
}

await verifyFeatures()
await verifyWorkflowDiscovery()
await verifyDocsAuthority()
await verifyRootMarkdownLinks()
console.log('feature-status: PASS')
