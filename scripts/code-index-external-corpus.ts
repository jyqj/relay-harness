/**
 * Repeatable real-repository Code Index benchmark. Repository source stays in
 * its own checkout; this runner writes only a temporary SQLite store and one
 * collision-checked probe file that is removed in `finally`.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  assertRetrievalThresholds,
  evaluateRetrieval,
  percentile95,
  type RetrievalEvalCase,
} from '../packages/index/code-index-local/src/eval.ts'
import { LocalCodeIndexRuntime } from '../packages/index/code-index-local/src/provider.ts'

interface CorpusThresholds {
  readonly minRecallAt5: number
  readonly minMrr: number
  readonly maxFullIndexMs: number
  readonly maxIncrementalP95Ms: number
  readonly maxSearchP95Ms: number
}

export interface ExternalCorpusDefinition {
  readonly id: string
  readonly description: string
  readonly ci: 'required' | 'optional'
  readonly rootEnv: string
  readonly rootCandidates: readonly string[]
  readonly markers: readonly string[]
  readonly incrementalProbePath: string
  readonly cases: readonly RetrievalEvalCase[]
  readonly thresholds: CorpusThresholds
}

export interface ExternalCorpusManifest {
  readonly schemaVersion: 1
  readonly defaults: {
    readonly searchIterations: number
    readonly incrementalIterations: number
    readonly maxFileBytes: number
  }
  readonly corpora: readonly ExternalCorpusDefinition[]
}

interface ResolvedCorpus {
  readonly definition: ExternalCorpusDefinition
  readonly root: string
  readonly rootSource: 'environment' | 'candidate'
}

export interface ExternalCorpusReport {
  readonly schemaVersion: 1
  readonly generatedAt: string
  readonly corpusId: string
  readonly rootLabel: string
  readonly rootSource: ResolvedCorpus['rootSource']
  readonly fullIndex: {
    readonly observedMs: number
    readonly providerDurationMs: number
    readonly changedFiles: number
    readonly removedFiles: number
    readonly chunksWritten: number
  }
  readonly index: {
    readonly files: number
    readonly chunks: number
    readonly tier: string
    readonly parserErrors: 0
    readonly parserFailurePolicy: 'fatal-atomic'
    readonly parserTierFiles: Readonly<Record<string, number>>
    readonly filesWithoutChunks: number
    readonly degraded: boolean
    readonly degradationReasons: readonly string[]
  }
  readonly incremental: { readonly samplesMs: readonly number[]; readonly p95Ms: number }
  readonly search: { readonly samplesMs: readonly number[]; readonly p50Ms: number; readonly p95Ms: number }
  readonly quality: Awaited<ReturnType<typeof evaluateRetrieval>>
  readonly thresholds: CorpusThresholds
  readonly gate: 'passed'
}

const DEFAULT_MANIFEST = fileURLToPath(new URL('./corpora/code-index-real-repositories.json', import.meta.url))

/** Read and validate the checked-in corpus protocol. */
export async function loadExternalCorpusManifest(path = DEFAULT_MANIFEST): Promise<ExternalCorpusManifest> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!isRecord(value) || value['schemaVersion'] !== 1 || !isRecord(value['defaults'])
    || !Array.isArray(value['corpora'])) {
    throw new Error(`code-index external corpus: invalid manifest ${path}`)
  }
  const ids = new Set<string>()
  for (const corpus of value['corpora']) {
    if (!isRecord(corpus) || typeof corpus['id'] !== 'string'
      || corpus['id'] === '' || ids.has(corpus['id'])) {
      throw new Error('code-index external corpus: invalid or duplicate corpus id')
    }
    ids.add(corpus['id'])
    if (!Array.isArray(corpus['cases']) || corpus['cases'].length === 0
      || !Array.isArray(corpus['markers']) || corpus['markers'].length === 0
      || !Array.isArray(corpus['rootCandidates']) || corpus['rootCandidates'].length === 0) {
      throw new Error(`code-index external corpus: ${corpus['id']} must declare cases, markers, and root candidates`)
    }
  }
  return value as unknown as ExternalCorpusManifest
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Find the monorepo root without assuming whether the checkout has been flattened. */
export function findWorkspaceRoot(start = import.meta.dirname): string {
  let current = resolve(start)
  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current
    const parent = dirname(current)
    if (parent === current) throw new Error(`code-index external corpus: pnpm workspace not found from ${start}`)
    current = parent
  }
}

/** Resolve one corpus by explicit env first, then cwd/workspace-relative candidates. */
export function resolveExternalCorpus(
  definition: ExternalCorpusDefinition,
  workspaceRoot = findWorkspaceRoot(),
  cwd = process.cwd(),
): ResolvedCorpus | undefined {
  const configured = process.env[definition.rootEnv]?.trim()
  const candidates: Array<{ path: string; source: ResolvedCorpus['rootSource'] }> = []
  if (configured !== undefined && configured !== '') {
    candidates.push({ path: isAbsolute(configured) ? configured : resolve(cwd, configured), source: 'environment' })
  }
  for (const candidate of definition.rootCandidates) {
    for (const base of [workspaceRoot, cwd]) {
      candidates.push({ path: isAbsolute(candidate) ? candidate : resolve(base, candidate), source: 'candidate' })
    }
  }
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const root = resolve(candidate.path)
    if (seen.has(root)) continue
    seen.add(root)
    if (definition.markers.every(marker => existsSync(join(root, marker)))) {
      return { definition, root, rootSource: candidate.source }
    }
  }
  return undefined
}

function percentile(samples: readonly number[], quantile: number): number {
  if (samples.length === 0) throw new Error('code-index external corpus: percentile needs samples')
  const sorted = [...samples].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)] as number
}

function databaseStats(path: string): {
  parserTierFiles: Record<string, number>
  filesWithoutChunks: number
} {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const rows = db.prepare('SELECT parser_tier AS tier, COUNT(*) AS count FROM files GROUP BY parser_tier')
      .all() as unknown as Array<{ tier: string; count: number }>
    const without = db.prepare(
      'SELECT COUNT(*) AS count FROM files f WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.file_path = f.file_path)',
    ).get() as { count: number }
    return {
      parserTierFiles: Object.fromEntries(rows.map(row => [row.tier, row.count])),
      filesWithoutChunks: without.count,
    }
  } finally {
    db.close()
  }
}

/** Run one full/index/incremental/search quality gate through the public runtime seam. */
export async function runExternalCorpus(
  resolved: ResolvedCorpus,
  defaults: ExternalCorpusManifest['defaults'],
  workspaceRoot = findWorkspaceRoot(),
): Promise<ExternalCorpusReport> {
  const temporary = await mkdtemp(join(tmpdir(), `rlh-code-index-corpus-${resolved.definition.id}-`))
  const databasePath = join(temporary, 'index.sqlite3')
  const runtime = new LocalCodeIndexRuntime({
    workspaceRoot: resolved.root,
    databasePath,
    journalMode: 'wal',
    excludePatterns: [],
    maxFileBytes: defaults.maxFileBytes,
  })
  const probe = join(resolved.root, resolved.definition.incrementalProbePath)
  if (existsSync(probe)) {
    throw new Error(`code-index external corpus: refusing to overwrite probe path ${probe}`)
  }
  try {
    const fullStarted = performance.now()
    const summary = await runtime.refresh({ reason: 'manual', forceRebuild: true })
    const fullObservedMs = performance.now() - fullStarted
    const management = runtime.managementStatus()
    const quality = await evaluateRetrieval(runtime, resolved.definition.cases)

    const searchSamples: number[] = []
    for (let iteration = 0; iteration < defaults.searchIterations; iteration++) {
      for (const item of resolved.definition.cases) {
        const started = performance.now()
        await runtime.search({ query: item.query, topK: 5 })
        searchSamples.push(performance.now() - started)
      }
    }

    const incrementalSamples: number[] = []
    try {
      for (let revision = 1; revision <= defaults.incrementalIterations; revision++) {
        await writeFile(probe, `export const relayExternalCorpusProbe = ${revision}\n`)
        const incremental = await runtime.refresh({
          reason: 'stale',
          paths: [resolved.definition.incrementalProbePath],
        })
        if (incremental.changedFiles !== 1) {
          throw new Error(`code-index external corpus: incremental probe changed ${incremental.changedFiles} files`)
        }
        incrementalSamples.push(incremental.durationMs)
      }
    } finally {
      await rm(probe, { force: true })
      await runtime.refresh({ reason: 'stale', paths: [resolved.definition.incrementalProbePath] })
    }

    assertRetrievalThresholds(quality, incrementalSamples, resolved.definition.thresholds)
    const searchP95Ms = percentile95(searchSamples)
    if (fullObservedMs > resolved.definition.thresholds.maxFullIndexMs) {
      throw new Error(`full index ${fullObservedMs.toFixed(2)}ms exceeds ${resolved.definition.thresholds.maxFullIndexMs}ms`)
    }
    if (searchP95Ms > resolved.definition.thresholds.maxSearchP95Ms) {
      throw new Error(`search p95 ${searchP95Ms.toFixed(2)}ms exceeds ${resolved.definition.thresholds.maxSearchP95Ms}ms`)
    }
    const stats = databaseStats(databasePath)
    const degradationReasons = summary.explain?.degradationReasons ?? []
    return {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      corpusId: resolved.definition.id,
      rootLabel: rootLabel(resolved.root, workspaceRoot),
      rootSource: resolved.rootSource,
      fullIndex: {
        observedMs: fullObservedMs,
        providerDurationMs: summary.durationMs,
        changedFiles: summary.changedFiles,
        removedFiles: summary.removedFiles,
        chunksWritten: summary.chunksWritten,
      },
      index: {
        files: management.indexedFileCount,
        chunks: management.chunkCount,
        tier: management.tier,
        parserErrors: 0,
        parserFailurePolicy: 'fatal-atomic',
        parserTierFiles: stats.parserTierFiles,
        filesWithoutChunks: stats.filesWithoutChunks,
        degraded: management.degraded || summary.explain?.degraded === true,
        degradationReasons,
      },
      incremental: { samplesMs: incrementalSamples, p95Ms: percentile95(incrementalSamples) },
      search: {
        samplesMs: searchSamples,
        p50Ms: percentile(searchSamples, 0.5),
        p95Ms: searchP95Ms,
      },
      quality,
      thresholds: resolved.definition.thresholds,
      gate: 'passed',
    }
  } finally {
    await rm(probe, { force: true })
    await runtime.dispose()
    await rm(temporary, { recursive: true, force: true })
  }
}

function rootLabel(root: string, workspaceRoot: string): string {
  const rel = relative(workspaceRoot, root)
  return rel === '' ? '.' : rel.startsWith('..') ? basename(root) : rel
}

async function main(): Promise<void> {
  const parsed = parseArgs({
    args: process.argv.slice(2).filter((argument, index) => !(index === 0 && argument === '--')),
    options: {
      manifest: { type: 'string', default: DEFAULT_MANIFEST },
      corpus: { type: 'string', multiple: true },
      ci: { type: 'boolean', default: false },
      list: { type: 'boolean', default: false },
      output: { type: 'string' },
    },
  })
  const manifest = await loadExternalCorpusManifest(parsed.values.manifest)
  if (parsed.values.list) {
    for (const corpus of manifest.corpora) console.log(`${corpus.id}\t${corpus.ci}\t${corpus.description}`)
    return
  }
  const selectedIds = new Set(parsed.values.corpus ?? [])
  const definitions = selectedIds.size === 0
    ? manifest.corpora
    : manifest.corpora.filter(corpus => selectedIds.has(corpus.id))
  if (definitions.length !== (selectedIds.size === 0 ? manifest.corpora.length : selectedIds.size)) {
    throw new Error(`code-index external corpus: unknown corpus selection ${[...selectedIds].join(', ')}`)
  }
  const workspaceRoot = findWorkspaceRoot()
  const reports: ExternalCorpusReport[] = []
  for (const definition of definitions) {
    const resolved = resolveExternalCorpus(definition, workspaceRoot)
    if (resolved === undefined) {
      if (selectedIds.has(definition.id) || (parsed.values.ci && definition.ci === 'required')) {
        throw new Error(
          `code-index external corpus: ${definition.id} unavailable; set ${definition.rootEnv} or provide one of `
          + definition.rootCandidates.join(', '),
        )
      }
      process.stderr.write(`code-index external corpus: skip optional unavailable ${definition.id}\n`)
      continue
    }
    process.stderr.write(`code-index external corpus: run ${definition.id} (${rootLabel(resolved.root, workspaceRoot)})\n`)
    reports.push(await runExternalCorpus(resolved, manifest.defaults, workspaceRoot))
  }
  if (reports.length === 0) throw new Error('code-index external corpus: no available corpus selected')
  const output = `${JSON.stringify({ schemaVersion: 1, reports }, null, 2)}\n`
  if (parsed.values.output === undefined) process.stdout.write(output)
  else {
    const target = resolve(process.cwd(), parsed.values.output)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, output)
    process.stderr.write(`code-index external corpus: wrote ${target}\n`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error))
    process.exitCode = 1
  })
}
