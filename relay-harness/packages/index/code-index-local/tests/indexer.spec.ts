/** Indexer pass: exclusion stack assembly, snapshots, upserts, delta commits, ledger row. */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { revivePersistedRecord } from '../src/provider.ts'
import {
  buildExclusionStack,
  composeFileUpsert,
  loadIndexedSnapshot,
  loadPersistedLastRefresh,
  openStore,
  persistLastRefresh,
  runRefreshPass,
} from '../src/indexer.ts'
import type { RefreshPassIo } from '../src/indexer.ts'
import { CODE_INDEX_METADATA_INDEX_EPOCH, readEpochs } from '@relay-harness/rlh-code-index-sqlite'
import { DEFAULT_INCLUDE_PATTERNS } from '../src/scanner.ts'
import { makeWorkspace, sweepWorkspaces } from './support.ts'

afterEach(sweepWorkspaces)

async function fixture(): Promise<{ root: string; db: DatabaseSync }> {
  const root = await makeWorkspace('rlh-idx-', {
    files: {
      'app.ts': 'export const app = 1\n',
      'src/util.py': 'value = "μ"\n',
      'junk.log': 'ignored extension\n',
    },
    gitignore: 'ignored/\n',
  })
  const decoy = join(root, 'ignored/decoy.ts')
  await mkdir(dirname(decoy), { recursive: true })
  await writeFile(decoy, '')
  const { db } = await openStore(':memory:', 'wal')
  return { root, db }
}

async function passInputs(root: string, db: DatabaseSync): Promise<{
  db: DatabaseSync
  workspaceRoot: string
  includePatterns: readonly string[]
  exclusionFilters: Awaited<ReturnType<typeof buildExclusionStack>>
  maxFileBytes: number
}> {
  return {
    db,
    workspaceRoot: root,
    includePatterns: DEFAULT_INCLUDE_PATTERNS,
    exclusionFilters: await buildExclusionStack(root, []),
    maxFileBytes: 512_000,
  }
}

describe('buildExclusionStack', () => {
  it('keeps only static hard/config layers while the scanner reloads gitignore documents', async () => {
    const plain = await makeWorkspace('rlh-idx-bare-', { files: {} })
    expect(await buildExclusionStack(plain, [])).toHaveLength(1)
    const layered = await makeWorkspace('rlh-idx-cfg-', { files: {}, gitignore: 'x/\n' })
    expect(await buildExclusionStack(layered, ['*.tmp'])).toHaveLength(2)
    const gitignoreOnly = await makeWorkspace('rlh-idx-gi-', { files: {} })
    expect(await buildExclusionStack(gitignoreOnly, [])).toHaveLength(1)
  })
})

describe('loadIndexedSnapshot', () => {
  it('reads exactly the fast-path columns for every stored file', async () => {
    const { root, db } = await fixture()
    await runRefreshPass({ ...await passInputs(root, db), previousGeneration: new Map() })
    const snapshot = loadIndexedSnapshot(db)
    expect([...snapshot.keys()].sort()).toEqual(['app.ts', 'src/util.py'])
    for (const record of snapshot.values()) {
      expect(Object.keys(record).sort()).toEqual(['contentHash', 'mtimeMs', 'size'])
    }
  })
})

describe('composeFileUpsert', () => {
  it('binds generic-tier metadata and stable chunk ids over decoded bytes', () => {
    const bytes = new TextEncoder().encode('const a = 1\nconst b = 2\n')
    const upsert = composeFileUpsert('pkg/mod.ts', 12.5, bytes.byteLength, bytes, 512_000)
    if (upsert === null) throw new Error('fixture must decode')
    expect(upsert.filePath).toBe('pkg/mod.ts')
    expect(upsert.contentHash).toMatch(/^[0-9a-f]{16}$/u)
    expect(upsert.parserTier).toBe('generic')
    expect(upsert.parserConfidence).toBe(0.5)
    expect(upsert.chunks[0]?.chunkId).toBe('chunk:pkg/mod.ts:0')
    expect(upsert.summary).toBe('const a = 1')
    expect(upsert.isTestFile).toBe(false)
    expect(upsert.language).toBe('typescript')
    expect(upsert.chunks.every(chunk => chunk.breadcrumb === '' && chunk.symbolName === null)).toBe(true)
  })

  it('returns null for undecodable payloads and chunk-free rows past the ceiling', () => {
    expect(composeFileUpsert('img.bin', 1, 3, new Uint8Array([1, 0xff, 0xfe]), 100)).toBeNull()
    const bytes = new TextEncoder().encode('alpha\nbeta gamma\n')
    const row = composeFileUpsert('big.md', 9, bytes.byteLength, bytes, 4)
    expect(row?.chunks).toEqual([])
    expect(row?.summary).toBe('alpha')
    expect(row?.isTestFile).toBe(false)
  })
})

describe('runRefreshPass', () => {
  it('commits a full first generation honoring every exclusion layer', async () => {
    const { root, db } = await fixture()
    const before = readEpochs(db)
    const outcome = await runRefreshPass({ ...await passInputs(root, db), previousGeneration: new Map() })
    expect(outcome).toMatchObject({
      changedFiles: 2,
      removedFiles: 0,
      binarySkipped: 0,
      unchangedFiles: 0,
    })
    expect(outcome.chunksWritten).toBeGreaterThan(0)
    expect(readEpochs(db).indexEpoch - before.indexEpoch).toBeGreaterThanOrEqual(1)
  })

  it('leaves fast-path survivors untouched on an identical second pass', async () => {
    const { root, db } = await fixture()
    const inputs = await passInputs(root, db)
    await runRefreshPass({ ...inputs, previousGeneration: new Map() })
    const second = await runRefreshPass({ ...inputs, previousGeneration: loadIndexedSnapshot(db) })
    expect(second.changedFiles).toBe(0)
    expect(second.unchangedFiles).toBe(2)
    expect(second.chunksWritten).toBe(0)
  })

  it('routes mid-pass vanishing candidates into the same delta removal half', async () => {
    const { root, db } = await fixture()
    const filters = await buildExclusionStack(root, [])
    await runRefreshPass({
      db,
      workspaceRoot: root,
      includePatterns: DEFAULT_INCLUDE_PATTERNS,
      exclusionFilters: filters,
      maxFileBytes: 512_000,
      previousGeneration: new Map(),
    })
    await writeFile(join(root, 'ghost.ts'), 'ephemeral\n')
    await rm(join(root, 'src/util.py'), { force: true })
    const inflightIo: RefreshPassIo = {
      // Hash gate reports unreadable for the phantom candidate; byte re-read
      // agrees ENOENT, so both vanish into one atomic delta.
      readHash: async relPath => relPath === 'ghost.ts' ? null : 'unchangedhash0000000',
      readBytes: async (relPath) => {
        if (relPath !== 'ghost.ts') return new Uint8Array([1])
        throw Object.assign(new Error('no such file'), { code: 'ENOENT' })
      },
    }
    const second = await runRefreshPass(
      {
        db,
        workspaceRoot: root,
        includePatterns: DEFAULT_INCLUDE_PATTERNS,
        exclusionFilters: filters,
        maxFileBytes: 512_000,
        previousGeneration: loadIndexedSnapshot(db),
      },
      inflightIo,
    )
    expect(second.changedFiles).toBe(0)
    expect(second.removedFiles).toBe(1)
    expect(second.binarySkipped).toBe(0)
  })

  it('propagates non-ENOENT byte-read failures instead of writing partial data', async () => {
    const { root, db } = await fixture()
    await writeFile(join(root, 'sealed.ts'), 'reach me\n')
    const deny: RefreshPassIo = {
      readHash: async () => 'irrelevant-hash00',
      readBytes: async () => {
        throw Object.assign(new Error('EACCES check failed'), { code: 'EACCES' })
      },
    }
    await expect(runRefreshPass(
      { ...await passInputs(root, db), previousGeneration: loadIndexedSnapshot(db) },
      deny,
    )).rejects.toThrow('EACCES check failed')
  })

  it('counts accepted-but-binary payloads without storing them', async () => {
    const root = await makeWorkspace('rlh-idx-bin-', {
      files: {
        'ok.ts': 'good = true\n',
        'blob.rs': '',
      },
    })
    await writeFile(join(root, 'blob.rs'), Buffer.from([0xff, 0xfe]))
    const db = (await openStore(':memory:', 'wal')).db
    const outcome = await runRefreshPass({
      db,
      workspaceRoot: root,
      includePatterns: ['**/*.ts', '**/*.rs'],
      exclusionFilters: [],
      maxFileBytes: 512_000,
      previousGeneration: new Map(),
    })
    expect(outcome.changedFiles).toBe(1)
    expect(outcome.binarySkipped).toBe(1)
  })

  it('keeps failing hash gates loud rather than silently classifying', async () => {
    const root = await makeWorkspace('rlh-idx-loud-', { files: { 'present.ts': 'visible\n' } })
    const db = (await openStore(':memory:', 'wal')).db
    const loudFail: RefreshPassIo = {
      readHash: async () => {
        throw new Error('hash storage exploded')
      },
      readBytes: async () => {
        throw new Error('never reached')
      },
    }
    await expect(runRefreshPass(
      {
        db,
        workspaceRoot: root,
        includePatterns: ['**/*.ts'],
        exclusionFilters: [],
        maxFileBytes: 512_000,
        previousGeneration: new Map(),
      },
      loudFail,
    )).rejects.toThrow('hash storage exploded')
  })
})

describe('last_refresh ledger helpers', () => {
  const summary = {
    reason: 'manual' as const,
    changedFiles: 2,
    removedFiles: 1,
    chunksWritten: 7,
    durationMs: 33,
    epochsAfter: { indexEpoch: 4, evidenceEpoch: 0 },
  }

  it('round-trips a committed summary through the shared metadata table', async () => {
    const { db } = await fixture()
    persistLastRefresh(db, summary)
    const loaded = loadPersistedLastRefresh(db, revivePersistedRecord)
    expect(loaded).toEqual(summary)
    // The seeded epoch rows stay intact beside the side key.
    expect(readEpochs(db)).toEqual({ indexEpoch: 0, evidenceEpoch: 0, embeddingEpoch: 0 })
    expect(CODE_INDEX_METADATA_INDEX_EPOCH).toBe('index_epoch')
  })

  it('answers undefined for a missing row, unparsable JSON, or a mistyped payload', async () => {
    const { db } = await fixture()
    expect(loadPersistedLastRefresh(db, revivePersistedRecord)).toBeUndefined()

    const putRow = db.prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
    putRow.run('last_refresh', '{broken json')
    expect(loadPersistedLastRefresh(db, revivePersistedRecord)).toBeUndefined()

    putRow.run('last_refresh', '{"reason":42}')
    expect(loadPersistedLastRefresh(db, revivePersistedRecord)).toBeUndefined()

    putRow.run('last_refresh', '{"extra":true}')
    expect(loadPersistedLastRefresh(db, revivePersistedRecord)).toBeUndefined()
  })
})
