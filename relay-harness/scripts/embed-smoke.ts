/**
 * Real-endpoint embeddings smoke for the local code-index tier.
 *
 * Reads `EMBEDDING_BASE_URL` / `EMBEDDING_API_KEY` / `EMBEDDING_MODEL`
 * (optionally `EMBEDDING_DIMENSIONS`) from the environment — an optional
 * gitignored `.env` at the repository root is loaded first, matching the
 * real-API demos. Every request goes to the configured endpoint; nothing
 * here is mocked.
 *
 * - Default: one wire request embedding two short texts, printing the vector
 *   dimension, `usage.prompt_tokens`, and the first vector's leading four
 *   components, then checking both vectors agree on dimensionality and are
 *   not all-zero.
 * - `--full`: additionally runs the complete refresh → enqueue → drain →
 *   search chain over a three-file fixture in a temporary directory against
 *   a fresh SQLite store, asserting `chunks_vec` received rows and the
 *   search answer carried no read errors.
 *
 * Exit status 0 means the smoke passed; any failure prints the structured
 * diagnosis plus a next-step hint (credential, base path, dimensionality).
 *
 * Run: `pnpm smoke:embed [--full]`
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { EmbeddingClient } from '../packages/index/code-index-local/src/embed/client.ts'
import type { EmbedError } from '../packages/index/code-index-local/src/embed/errors.ts'
import { drainEmbedJobs } from '../packages/index/code-index-local/src/embed/worker.ts'
import { buildExclusionStack, loadIndexedSnapshot, runRefreshPass } from '../packages/index/code-index-local/src/indexer.ts'
import { DEFAULT_INCLUDE_PATTERNS } from '../packages/index/code-index-local/src/scanner.ts'
import {
  chunkRevisionsForFiles,
  createRetrievalPort,
  enqueueEmbedJobs,
  openCodeIndexDatabase,
  pendingEmbedCount,
  readEpochs,
} from '../packages/index/code-index-sqlite/src/index.ts'
import {
  createSearchEngine,
  createVectorLane,
  defaultPreselectLayersForEngine,
  defaultRetrievalLanes,
} from '../packages/index/code-index-search/src/index.ts'
import type { EngineSearchRequest } from '../packages/index/code-index-search/src/index.ts'

const REQUIRED_ENV = ['EMBEDDING_BASE_URL', 'EMBEDDING_API_KEY', 'EMBEDDING_MODEL'] as const

/** Two short texts packed into one wire request for the default probe. */
const PROBE_TEXTS = ['relay-harness embed smoke', '本地代码索引'] as const

/** Three-file fixture the --full chain indexes, drains, and searches. */
const FIXTURE_FILES: Readonly<Record<string, string>> = {
  'src/auth/session.ts': [
    'export interface SessionState {',
    '  token: string',
    '  expiresAt: number',
    '}',
    '',
    '/** Refresh the bearer token before it expires. */',
    'export function refreshSession(state: SessionState, ttlMs: number): SessionState {',
    '  return { token: issueToken(state.token), expiresAt: Date.now() + ttlMs }',
    '}',
    '',
  ].join('\n'),
  'src/auth/login.ts': [
    '/** 校验用户名与口令，通过后签发会话。 */',
    'export function verifyLogin(user: string, password: string): boolean {',
    '  const ok = checkPassword(user, password)',
    '  if (ok) startSession(user)',
    '  return ok',
    '}',
    '',
  ].join('\n'),
  'docs/embed-notes.md': [
    '# Embedding smoke notes',
    '',
    'The local code index stores int8-quantized vectors beside the chunk text',
    'so the retrieval engine can fuse lexical and semantic lanes.',
    '',
  ].join('\n'),
}

/** Exit with a structured missing-variable report. */
function failMissingEnv(missing: readonly string[]): never {
  console.error('embed smoke: missing required environment variables:')
  for (const key of missing) console.error(`  - ${key}`)
  console.error('export them in your shell or place them in the repository-root .env (gitignored):')
  console.error('  EMBEDDING_BASE_URL=https://api.example.com/v1')
  console.error('  EMBEDDING_API_KEY=sk-...')
  console.error('  EMBEDDING_MODEL=text-embedding-3-small')
  console.error('  # optional: EMBEDDING_DIMENSIONS=1024')
  process.exit(1)
}

/** Build the client from the environment, refusing a bad EMBEDDING_DIMENSIONS up front. */
function clientFromEnv(): EmbeddingClient {
  loadRootEnvFile()
  const missing = REQUIRED_ENV.filter(key => !readEnv(key))
  if (missing.length > 0) failMissingEnv(missing)
  const baseURL = readEnv('EMBEDDING_BASE_URL') as string
  const apiKey = readEnv('EMBEDDING_API_KEY') as string
  const model = readEnv('EMBEDDING_MODEL') as string
  const dimensions = parseDimensions(readEnv('EMBEDDING_DIMENSIONS'))
  console.log(`endpoint : ${baseURL}`)
  console.log(`model    : ${model}`)
  console.log(`dimension: ${dimensions ?? 'auto (first reply locks it)'}`)
  return new EmbeddingClient({
    baseURL,
    apiKey,
    model,
    batchSize: 16,
    timeoutMs: 30_000,
    maxInputsPerRequest: 16,
    ...(dimensions === undefined ? {} : { dimensions }),
  })
}

/** The environment override, undefined when unset or blank. */
function readEnv(key: string): string | undefined {
  const value = process.env[key]
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

/**
 * Load the optional repository-root `.env`. A missing file is the normal
 * ambient-environment path; anything unreadable is reported and ignored so
 * the smoke still runs on exported shell variables.
 */
function loadRootEnvFile(): void {
  try {
    process.loadEnvFile(resolve(import.meta.dirname, '../.env'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    console.warn(`embed smoke: ignored unreadable root .env (${String(error)})`)
  }
}

/** Parse the optional dimensionality override; a bad value fails loudly. */
function parseDimensions(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0) {
    console.error(`embed smoke: EMBEDDING_DIMENSIONS must be a positive integer, got ${JSON.stringify(raw)}`)
    process.exit(1)
  }
  return value
}

/** Step 1: one wire request over two short texts, reported component-level. */
async function probeSingleRequest(client: EmbeddingClient): Promise<Float32Array[]> {
  console.log('\n[1/3] single-request embed of two short texts')
  const { vectors, promptTokens } = await client.embed(PROBE_TEXTS)
  const first = vectors[0]
  if (first === undefined) throw new Error('the endpoint returned no vector for the probe texts')
  console.log(`  vectors        : ${vectors.length}`)
  console.log(`  dimension      : ${first.length}`)
  console.log(`  usage          : ${promptTokens} prompt_tokens`)
  console.log(`  first[0..3]    : [${[...first.slice(0, 4)].map(component => component.toFixed(6)).join(', ')}]`)
  return vectors
}

/** Step 2: both probe vectors agree on dimensionality and carry signal. */
function assertVectorSanity(vectors: readonly Float32Array[]): void {
  const [first, second] = vectors
  if (first === undefined || second === undefined) throw new Error('fewer than two probe vectors came back')
  if (first.length !== second.length) {
    throw new Error(`probe vectors disagree on dimensionality: ${first.length} vs ${second.length}`)
  }
  for (const [index, vector] of vectors.entries()) {
    let squares = 0
    for (const component of vector) squares += component * component
    if (squares === 0) throw new Error(`probe vector ${index + 1} is all-zero; the endpoint returned no signal`)
  }
  console.log('\n[2/3] vector sanity: dimensions agree, vectors are non-zero')
}

/** Step 3 (--full): refresh → enqueue → drain → search over a 3-file fixture. */
async function fullPipeline(client: EmbeddingClient, model: string): Promise<void> {
  console.log('\n[3/3] full refresh → drain → search over a 3-file fixture')
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'rlh-embed-smoke-'))
  try {
    for (const [relativePath, content] of Object.entries(FIXTURE_FILES)) {
      const absolute = join(workspaceRoot, relativePath)
      mkdirSync(dirname(absolute), { recursive: true })
      writeFileSync(absolute, content)
    }
    const databasePath = join(workspaceRoot, 'code-index.db')
    const db = await openCodeIndexDatabase(databasePath, 'wal')
    try {
      const outcome = await runRefreshPass({
        db,
        workspaceRoot,
        includePatterns: DEFAULT_INCLUDE_PATTERNS,
        exclusionFilters: await buildExclusionStack(workspaceRoot, []),
        maxFileBytes: 1_000_000,
        previousGeneration: loadIndexedSnapshot(db),
      })
      console.log(`  refresh        : ${outcome.changedFiles} files, ${outcome.chunksWritten} chunks`)

      const targets = chunkRevisionsForFiles(db, outcome.changedPaths)
      const enqueue = enqueueEmbedJobs(
        db,
        targets.map(target => ({ chunkId: target.chunkId, model, contentHash: target.contentHash })),
      )
      console.log(`  enqueue        : ${enqueue.enqueued} jobs`)
      if (enqueue.enqueued === 0) throw new Error('the refresh produced no embedding jobs; the fixture chunked to nothing')

      const drain = await drainEmbedJobs({
        db,
        client,
        owner: 'embed-smoke',
        maxJobs: 32,
        maxPromptTokens: 500_000,
      })
      console.log(
        `  drain          : ${drain.jobsCompleted} completed, ${drain.vectorsWritten} vectors, `
          + `${drain.promptTokens} prompt_tokens, stopped because "${drain.stoppedBecause}"`,
      )
      if (drain.jobsCompleted === 0) throw new Error('the drain completed no jobs; see the queue or endpoint output above')

      const vectorRows = (db.prepare('SELECT COUNT(*) AS n FROM chunks_vec').get() as { n: number }).n
      const pending = pendingEmbedCount(db, model)
      console.log(`  chunks_vec     : ${vectorRows} rows, ${pending} jobs still pending`)
      if (vectorRows === 0) throw new Error('chunks_vec holds no rows after a successful drain')

      const port = createRetrievalPort(db)
      const engine = createSearchEngine({
        port,
        lanes: defaultRetrievalLanes(undefined, createVectorLane({ model })),
        layers: defaultPreselectLayersForEngine(),
        resolveEpochs: () => readEpochs(db),
      })
      const query = '登录验证 session refresh'
      const { vectors } = await client.embed([query])
      const queryVector = vectors[0]
      if (queryVector === undefined) throw new Error('the endpoint returned no vector for the search query')
      const request: EngineSearchRequest = { query, topK: 3, queryVector }
      const answer = engine.search(request)
      if (answer.readErrors.length > 0) {
        throw new Error(`the search answer degraded: ${answer.readErrors.join('; ')}`)
      }
      console.log(`  search         : "${query}" — ${answer.hits.length} hits, readErrors none`)
      for (const hit of answer.hits) {
        console.log(`    #${hit.rank} ${hit.filePath}:${hit.startLine} score ${hit.score.toFixed(4)} [${hit.reasons.join(', ')}]`)
      }
      if (answer.hits.length === 0) throw new Error('the search returned no hits for a fixture the index just ingested')
    } finally {
      db.close()
    }
  } finally {
    rmSync(workspaceRoot, { recursive: true, force: true })
  }
}

/** Map a smoke failure onto the next diagnostic step. */
function hintFor(error: unknown): string {
  const code = (error as EmbedError).code as string | undefined
  const message = String(error)
  if (code === 'EMBED_INVALID_CREDENTIAL') {
    return 'check EMBEDDING_API_KEY — the endpoint refused the credential'
  }
  if (code === 'EMBED_DIMENSION_MISMATCH') {
    return `align EMBEDDING_DIMENSIONS with the endpoint's vector size (${message})`
  }
  if (code === 'EMBED_TIMEOUT') {
    return 'the endpoint did not answer inside 30s — check network reachability or raise the budget'
  }
  if (/401|403|auth|credential|api[ _-]?key|\bkey\b/i.test(message)) {
    return 'check EMBEDDING_API_KEY — the endpoint answered 401/403'
  }
  if (/404|not found|fetch failed|ENOTFOUND|ECONNREFUSED|CORS/i.test(message)) {
    return 'check EMBEDDING_BASE_URL — it must be the API root including the version segment (usually ends in /v1); the client posts to <base>/embeddings'
  }
  return 'verify the endpoint, model name, and network path, then re-run'
}

/** Run every requested step, exiting non-zero with a hint on the first failure. */
async function main(): Promise<void> {
  const full = process.argv.slice(2).includes('--full')
  if (process.argv.slice(2).some(argument => argument !== '--full')) {
    console.error('embed smoke: unknown arguments; usage: pnpm smoke:embed [--full]')
    process.exit(1)
  }
  console.log('== relay-harness embed smoke ==')
  const client = clientFromEnv()
  try {
    const vectors = await probeSingleRequest(client)
    assertVectorSanity(vectors)
    if (full) await fullPipeline(client, client.model)
    console.log('\nEMBED SMOKE PASSED')
  } catch (error) {
    console.error(`\nembed smoke failed: ${String(error)}`)
    console.error(`next step: ${hintFor(error)}`)
    process.exit(1)
  }
}

await main()
