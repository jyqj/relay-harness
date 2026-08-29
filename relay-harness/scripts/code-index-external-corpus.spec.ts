import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findWorkspaceRoot,
  loadExternalCorpusManifest,
  resolveExternalCorpus,
  runExternalCorpus,
  settleCorpusResources,
  type ExternalCorpusDefinition,
} from './code-index-external-corpus.ts'

const temporary: string[] = []
afterEach(async () => {
  delete process.env.RLH_CODE_INDEX_TEST_CORPUS_ROOT
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function definition(overrides: Partial<ExternalCorpusDefinition> = {}): ExternalCorpusDefinition {
  return {
    id: 'fixture',
    description: 'fixture',
    ci: 'optional',
    rootEnv: 'RLH_CODE_INDEX_TEST_CORPUS_ROOT',
    rootCandidates: ['external'],
    markers: ['marker.txt'],
    incrementalProbePath: 'probe.ts',
    cases: [{ id: 'marker', query: 'marker', relevantPaths: ['marker.txt'] }],
    thresholds: {
      minRecallAt5: 0,
      minMrr: 0,
      maxFullIndexMs: 1,
      maxIncrementalP95Ms: 1,
      maxSearchP95Ms: 1,
    },
    ...overrides,
  }
}

describe('code-index external corpus protocol', () => {
  it('keeps one required in-repo CI corpus and optional non-vendored references', async () => {
    const manifest = await loadExternalCorpusManifest()
    expect(manifest.corpora.find(corpus => corpus.id === 'relay-monorepo')).toMatchObject({
      ci: 'required',
      rootCandidates: ['.'],
    })
    expect(manifest.corpora.filter(corpus => corpus.ci === 'optional').map(corpus => corpus.id)).toEqual([
      'codecortex-rust',
      'auggie-recovered',
    ])
    expect(manifest.corpora.every(corpus => corpus.cases.length > 0)).toBe(true)
  })

  it('discovers the workspace independently of process cwd and resolves relative candidates', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-corpus-resolution-'))
    temporary.push(root)
    await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages: []\n')
    await mkdir(join(root, 'nested', 'scripts'), { recursive: true })
    await mkdir(join(root, 'external'))
    await writeFile(join(root, 'external', 'marker.txt'), 'marker\n')
    expect(findWorkspaceRoot(join(root, 'nested', 'scripts'))).toBe(root)
    expect(resolveExternalCorpus(definition(), root, join(root, 'nested'))).toMatchObject({
      root: join(root, 'external'),
      rootSource: 'candidate',
    })
  })

  it('gives an explicit environment root precedence and rejects incomplete roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-corpus-environment-'))
    temporary.push(root)
    const configured = join(root, 'configured')
    await mkdir(configured)
    process.env.RLH_CODE_INDEX_TEST_CORPUS_ROOT = configured
    expect(resolveExternalCorpus(definition(), root, root)).toBeUndefined()
    await writeFile(join(configured, 'marker.txt'), 'marker\n')
    expect(resolveExternalCorpus(definition(), root, root)).toMatchObject({
      root: configured,
      rootSource: 'environment',
    })
  })

  it('rejects a probe collision before allocating a temporary database', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-corpus-collision-root-'))
    temporary.push(root)
    const id = `collision-${process.pid}-${Date.now()}`
    await writeFile(join(root, 'probe.ts'), 'existing source\n')
    const before = (await readdir(tmpdir())).filter(name => name.startsWith(`rlh-code-index-corpus-${id}-`))
    await expect(runExternalCorpus({
      definition: definition({ id }),
      root,
      rootSource: 'candidate',
    }, {
      searchIterations: 1,
      incrementalIterations: 1,
      maxFileBytes: 512_000,
    }, root)).rejects.toThrow('refusing to overwrite probe path')
    const after = (await readdir(tmpdir())).filter(name => name.startsWith(`rlh-code-index-corpus-${id}-`))
    expect(after).toEqual(before)
  })

  it('does not overwrite or remove a probe that appears after the initial collision check', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-corpus-late-collision-root-'))
    temporary.push(root)
    const id = `late-collision-${process.pid}-${Date.now()}`
    await writeFile(join(root, 'marker.txt'), 'marker\n')
    await Promise.all(Array.from({ length: 200 }, (_, index) => (
      writeFile(join(root, `source-${index}.ts`), `export const corpusSource${index} = ${index}\n`)
    )))
    const prefix = `rlh-code-index-corpus-${id}-`
    const running = runExternalCorpus({
      definition: definition({
        id,
        thresholds: {
          minRecallAt5: 0,
          minMrr: 0,
          maxFullIndexMs: 60_000,
          maxIncrementalP95Ms: 60_000,
          maxSearchP95Ms: 60_000,
        },
      }),
      root,
      rootSource: 'candidate',
    }, {
      searchIterations: 1,
      incrementalIterations: 1,
      maxFileBytes: 512_000,
    }, root).then(
      value => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    )
    for (let attempt = 0; attempt < 1_000; attempt++) {
      if ((await readdir(tmpdir())).some(name => name.startsWith(prefix))) break
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    const probe = join(root, 'probe.ts')
    await writeFile(probe, 'late foreign source\n', { flag: 'wx' })
    const outcome = await running
    expect(outcome.status).toBe('rejected')
    if (outcome.status !== 'rejected') throw new Error('late probe collision unexpectedly completed')
    expect(outcome.error).toBeInstanceOf(Error)
    if (!(outcome.error instanceof Error)) throw new Error('late probe collision rejected with a non-Error value')
    expect(outcome.error.message).toContain('refusing to overwrite probe path')
    expect(await readFile(probe, 'utf8')).toBe('late foreign source\n')
    expect((await readdir(tmpdir())).filter(name => name.startsWith(prefix))).toEqual([])
  })

  it('removes the temporary database when the corpus run rejects before reporting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-corpus-runtime-failure-root-'))
    temporary.push(root)
    const id = `runtime-failure-${process.pid}-${Date.now()}`
    await writeFile(join(root, 'marker.txt'), 'marker\n')
    const prefix = `rlh-code-index-corpus-${id}-`
    const before = (await readdir(tmpdir())).filter(name => name.startsWith(prefix))
    await expect(runExternalCorpus({
      definition: definition({
        id,
        thresholds: {
          minRecallAt5: 0,
          minMrr: 0,
          maxFullIndexMs: 0,
          maxIncrementalP95Ms: 60_000,
          maxSearchP95Ms: 60_000,
        },
      }),
      root,
      rootSource: 'candidate',
    }, {
      searchIterations: 1,
      incrementalIterations: 1,
      maxFileBytes: 512_000,
    }, root)).rejects.toThrow('full index')
    expect((await readdir(tmpdir())).filter(name => name.startsWith(prefix))).toEqual(before)
  })

  it('attempts every cleanup and keeps the run failure first', async () => {
    const runFailure = new Error('run failed')
    const cleanupFailure = new Error('cleanup failed')
    const calls: string[] = []
    const error = await settleCorpusResources(runFailure, [
      () => { calls.push('probe'); return Promise.reject(cleanupFailure) },
      () => { calls.push('runtime'); return Promise.resolve() },
      () => { calls.push('temporary'); return Promise.reject(new Error('temporary failed')) },
    ]).catch((caught: unknown): unknown => caught)
    expect(calls).toEqual(['probe', 'runtime', 'temporary'])
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toEqual([
      runFailure,
      cleanupFailure,
      expect.objectContaining({ message: 'temporary failed' }),
    ])
  })
})
