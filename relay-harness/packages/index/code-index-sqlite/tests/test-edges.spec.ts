import { afterEach, describe, expect, it } from 'vitest'
import { assertExactAdvance, readEpochs } from '../src/epoch.ts'
import { openCodeIndexDatabase } from '../src/open.ts'
import { rebuildTestEdgesForFiles, rebuildTestEdgesFull, testStemCandidateFragments } from '../src/test-edges.ts'
import { fileGraphDelta, fileUpsert, testEdgeRow } from './support.ts'
import { writeFilesDelta } from '../src/writer.ts'
import type { FileUpsert } from '../src/writer.ts'

/** Every test edge, ordered by id, for table-shape assertions. */
function edges(db: import('node:sqlite').DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare(
    'SELECT edge_id, test_file_path, code_file_path, reason, confidence FROM test_edges ORDER BY edge_id',
  ).all()
}

describe('testStemCandidateFragments', () => {
  it('normalizes test stems with the reference fallback chain', () => {
    // base_clean 'user_service' first, then the _-split parts; the whole stem
    // rides the -split pass (no hyphen present) and 'service.test' keeps its
    // dot because the fallback chain only strips it from base_clean.
    expect(testStemCandidateFragments('user_service.test'))
      .toEqual(['user_service', 'user', 'service.test', 'user_service.test'])
    expect(testStemCandidateFragments('user_service')).toEqual(['user_service', 'user', 'service'])
  })

  it('falls back to the original stem when a strip step fails', () => {
    // 'test_a': prefix strips to 'a', the _test suffix then fails and falls
    // back to the ORIGINAL stem — not the prefix-stripped intermediate.
    expect(testStemCandidateFragments('test_a')).toEqual(['test_a'])
    // 'test_user': prefix strips, suffix fails -> original 'test_user'.
    expect(testStemCandidateFragments('test_user')).toEqual(['test_user', 'user'])
    expect(testStemCandidateFragments('user_test')).toEqual(['user', 'user_test'])
  })

  it('strips .test/.spec suffixes and splits on hyphens with dedup', () => {
    expect(testStemCandidateFragments('app.test')).toEqual(['app', 'app.test'])
    expect(testStemCandidateFragments('app.spec')).toEqual(['app', 'app.spec'])
    expect(testStemCandidateFragments('service-x')).toEqual(['service-x', 'service'])
    expect(testStemCandidateFragments('abc-abc')).toEqual(['abc-abc', 'abc'])
    // base_clean '' pushes nothing; '' parts are too short; 'test' is excluded.
    expect(testStemCandidateFragments('')).toEqual([])
    expect(testStemCandidateFragments('a_test')).toEqual(['a', 'a_test'])
  })
})

describe('rebuildTestEdgesForFiles', () => {
  const opened: Array<import('node:sqlite').DatabaseSync> = []
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close()
  })

  async function seed(paths: readonly (FileUpsert | string | [path: string, isTest: boolean])[]): Promise<import('node:sqlite').DatabaseSync> {
    const db = await openCodeIndexDatabase(':memory:')
    opened.push(db)
    writeFilesDelta(db, {
      removals: [],
      upserts: paths.map((entry) => {
        const [path, isTest] = typeof entry === 'string'
          ? [entry, false]
          : Array.isArray(entry) ? entry : [entry.filePath, false]
        return { ...fileUpsert(path, [`body of ${path}`]), isTestFile: isTest }
      }),
    })
    return db
  }

  function count(db: import('node:sqlite').DatabaseSync): number {
    return (db.prepare('SELECT COUNT(*) AS n FROM test_edges').get() as { n: number }).n
  }

  it('rebuilds a changed test file: same-basename then path-overlap candidates', async () => {
    const db = await seed([
      ['src/user_service.test.ts', true],
      'src/user_service.ts',
      'src/deep/nested/user_service_view.ts',
      'src/user.ts',
      'src/unrelated.ts',
      'src/USER_SERVICE.ts',
    ])
    const before = readEpochs(db)
    const result = rebuildTestEdgesForFiles(db, ['src/user_service.test.ts'])
    expect(result).toEqual({ edgesWritten: 3 })
    assertExactAdvance(before, readEpochs(db), 'index')
    expect(edges(db)).toEqual([
      {
        edge_id: 'test:src/user_service.test.ts:src/deep/nested/user_service_view.ts',
        test_file_path: 'src/user_service.test.ts',
        code_file_path: 'src/deep/nested/user_service_view.ts',
        reason: 'path-overlap',
        confidence: 0.7,
      },
      {
        edge_id: 'test:src/user_service.test.ts:src/user.ts',
        test_file_path: 'src/user_service.test.ts',
        code_file_path: 'src/user.ts',
        reason: 'path-overlap',
        confidence: 0.7,
      },
      {
        edge_id: 'test:src/user_service.test.ts:src/user_service.ts',
        test_file_path: 'src/user_service.test.ts',
        code_file_path: 'src/user_service.ts',
        reason: 'same-basename',
        confidence: 0.9,
      },
    ])
  })

  it('rebuilds a changed code file against unchanged test files, skipping changed ones', async () => {
    const db = await seed([
      ['src/user_service.test.ts', true],
      'src/user_service.ts',
    ])
    expect(rebuildTestEdgesForFiles(db, ['src/user_service.ts'])).toEqual({ edgesWritten: 1 })
    expect(count(db)).toBe(1)

    // Both endpoints changed: the test file's own iteration owns the pair, so
    // the code file's iteration must skip it instead of rewriting the edge.
    const before = readEpochs(db)
    expect(rebuildTestEdgesForFiles(db, ['src/user_service.test.ts', 'src/user_service.ts']))
      .toEqual({ edgesWritten: 1 })
    assertExactAdvance(before, readEpochs(db), 'index')
    expect(count(db)).toBe(1)
  })

  it('scores code-stem candidates conservatively when only LIKE matches', async () => {
    const db = await seed([
      ['src/user_service.test.ts', true],
      'src/user_profile.ts',
      'src/username.ts',
      'src/user_x.ts',
      '',
    ])
    // 'user_profile' reaches the test file through the %user% stem-part
    // pattern but fails both scoring arms; 'username' dedupes its split
    // patterns down to one and matches nothing; 'user_x' skips its short
    // part; the stem-less path builds no patterns at all.
    expect(rebuildTestEdgesForFiles(db, ['src/user_profile.ts', 'src/username.ts', 'src/user_x.ts', '']))
      .toEqual({ edgesWritten: 0 })
    expect(count(db)).toBe(0)
  })

  it('deletes both endpoint halves for removed paths and rebuilds nothing for them', async () => {
    const db = await seed([
      ['src/user_service.test.ts', true],
      'src/user_service.ts',
    ])
    writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/keeper.ts', ['body'])],
      graph: {
        byFile: new Map([
          ['src/keeper.ts', fileGraphDelta({
            testEdges: [testEdgeRow('edge:ghost', 'src/gone.test.ts', 'src/user_service.ts', 'stale', 0.5)],
          })],
        ]),
      },
    })
    expect(count(db)).toBe(1)

    // 'src/gone.test.ts' has no files row: its endpoint edges disappear and
    // nothing may resurrect them.
    expect(rebuildTestEdgesForFiles(db, ['src/user_service.test.ts', 'src/gone.test.ts']))
      .toEqual({ edgesWritten: 1 })
    expect(edges(db).map(row => row.edge_id))
      .toEqual(['test:src/user_service.test.ts:src/user_service.ts'])
  })

  it('commits nothing for an empty path list and leaves the epoch unmoved', async () => {
    const db = await seed([['src/user_service.test.ts', true]])
    const before = readEpochs(db)
    expect(rebuildTestEdgesForFiles(db, [])).toEqual({ edgesWritten: 0 })
    expect(readEpochs(db)).toEqual(before)
  })
})

describe('rebuildTestEdgesFull', () => {
  const opened: Array<import('node:sqlite').DatabaseSync> = []
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close()
  })

  // Fixtures covering the shared matching semantics: multi-dot test stems,
  // LIKE metacharacters in fragments (% and _), regex metacharacters (+),
  // ASCII-only case folding (USER_SERVICE / ABC), stem-less paths, and the
  // degenerate empty stem.
  const FULL_FIXTURE: ReadonlyArray<[path: string, isTest: boolean]> = [
    ['', true],
    ['src/user_service.test.ts', true],
    ['src/100%_test.ts', true],
    ['src/ABC.test.ts', true],
    ['src/a+b.test.ts', true],
    ['src/user.test.ts', true],
    ['src/user_service.ts', false],
    ['src/deep/nested/user_service_view.ts', false],
    ['src/user.ts', false],
    ['src/unrelated.ts', false],
    ['src/100%coverage.ts', false],
    ['src/USER_SERVICE.ts', false],
    ['src/abc.ts', false],
    ['src/a+b.ts', false],
    ['src/makefile', false],
    ['src/.eslintrc', false],
  ]

  const FULL_EDGES: ReadonlyArray<Record<string, unknown>> = [
    {
      edge_id: 'test:src/100%_test.ts:src/100%coverage.ts',
      test_file_path: 'src/100%_test.ts',
      code_file_path: 'src/100%coverage.ts',
      reason: 'path-overlap',
      confidence: 0.7,
    },
    {
      edge_id: 'test:src/a+b.test.ts:src/a+b.ts',
      test_file_path: 'src/a+b.test.ts',
      code_file_path: 'src/a+b.ts',
      reason: 'same-basename',
      confidence: 0.9,
    },
    {
      edge_id: 'test:src/user.test.ts:src/deep/nested/user_service_view.ts',
      test_file_path: 'src/user.test.ts',
      code_file_path: 'src/deep/nested/user_service_view.ts',
      reason: 'path-overlap',
      confidence: 0.7,
    },
    {
      edge_id: 'test:src/user.test.ts:src/user.ts',
      test_file_path: 'src/user.test.ts',
      code_file_path: 'src/user.ts',
      reason: 'same-basename',
      confidence: 0.9,
    },
    {
      edge_id: 'test:src/user.test.ts:src/user_service.ts',
      test_file_path: 'src/user.test.ts',
      code_file_path: 'src/user_service.ts',
      reason: 'path-overlap',
      confidence: 0.7,
    },
    {
      edge_id: 'test:src/user_service.test.ts:src/deep/nested/user_service_view.ts',
      test_file_path: 'src/user_service.test.ts',
      code_file_path: 'src/deep/nested/user_service_view.ts',
      reason: 'path-overlap',
      confidence: 0.7,
    },
    {
      edge_id: 'test:src/user_service.test.ts:src/user.ts',
      test_file_path: 'src/user_service.test.ts',
      code_file_path: 'src/user.ts',
      reason: 'path-overlap',
      confidence: 0.7,
    },
    {
      edge_id: 'test:src/user_service.test.ts:src/user_service.ts',
      test_file_path: 'src/user_service.test.ts',
      code_file_path: 'src/user_service.ts',
      reason: 'same-basename',
      confidence: 0.9,
    },
  ]

  async function seededFull(): Promise<import('node:sqlite').DatabaseSync> {
    const db = await openCodeIndexDatabase(':memory:')
    opened.push(db)
    writeFilesDelta(db, {
      removals: [],
      upserts: FULL_FIXTURE.map(([path, isTest]) => ({
        ...fileUpsert(path, [`body of ${path}`]),
        isTestFile: isTest,
      })),
    })
    return db
  }

  it('recomputes every pair in memory and replaces the table in one transaction', async () => {
    const db = await seededFull()
    const before = readEpochs(db)
    expect(rebuildTestEdgesFull(db)).toEqual({ edgesWritten: 8 })
    assertExactAdvance(before, readEpochs(db), 'index')
    expect(edges(db)).toEqual(FULL_EDGES)
  })

  it('wipes stale edges that no live path set can regenerate', async () => {
    const db = await seededFull()
    writeFilesDelta(db, {
      removals: [],
      upserts: [fileUpsert('src/keeper.ts', ['body'])],
      graph: {
        byFile: new Map([
          ['src/keeper.ts', fileGraphDelta({
            testEdges: [testEdgeRow('edge:stale', 'src/ghost.test.ts', 'src/user_service.ts', 'stale', 0.5)],
          })],
        ]),
      },
    })
    expect(rebuildTestEdgesFull(db)).toEqual({ edgesWritten: 8 })
    expect(edges(db)).toEqual(FULL_EDGES)
  })

  it('matches the per-path rebuild over every path exactly', async () => {
    const incremental = await seededFull()
    const full = await openCodeIndexDatabase(':memory:')
    opened.push(full)
    writeFilesDelta(full, {
      removals: [],
      upserts: FULL_FIXTURE.map(([path, isTest]) => ({
        ...fileUpsert(path, [`body of ${path}`]),
        isTestFile: isTest,
      })),
    })
    expect(rebuildTestEdgesForFiles(incremental, FULL_FIXTURE.map(([path]) => path)).edgesWritten).toBe(8)
    expect(rebuildTestEdgesFull(full).edgesWritten).toBe(8)
    expect(edges(incremental)).toEqual(edges(full))
  })
})
