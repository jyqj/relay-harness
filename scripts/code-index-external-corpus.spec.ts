import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  findWorkspaceRoot,
  loadExternalCorpusManifest,
  resolveExternalCorpus,
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
})
