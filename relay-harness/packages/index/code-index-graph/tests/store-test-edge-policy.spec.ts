import { afterEach, describe, expect, it } from 'vitest'
import { assertExactAdvance, openCodeIndexDatabase, readEpochs } from '@relay-harness/rlh-code-index-sqlite'
import { fileUpsertFixture, seededStore, tableCount } from './store-helpers.ts'
import { applyTestEdgeRebuild, decideTestEdgeRebuild } from '../src/store/test-edge-policy.ts'
import { writeFilesDelta } from '@relay-harness/rlh-code-index-sqlite'

describe('decideTestEdgeRebuild', () => {
  it('skips pure content updates regardless of the path list', () => {
    expect(decideTestEdgeRebuild({ hadRemovalsOrRenames: false, changedPaths: undefined })).toBe('skip')
    expect(decideTestEdgeRebuild({ hadRemovalsOrRenames: false, changedPaths: [] })).toBe('skip')
    expect(decideTestEdgeRebuild({ hadRemovalsOrRenames: false, changedPaths: ['src/a.ts'] })).toBe('skip')
  })

  it('rebuilds the whole table when the path set changed without enumerable paths', () => {
    expect(decideTestEdgeRebuild({ hadRemovalsOrRenames: true, changedPaths: undefined })).toBe('full')
  })

  it('skips a changed flag with an empty enumerable set, otherwise rebuilds per path', () => {
    expect(decideTestEdgeRebuild({ hadRemovalsOrRenames: true, changedPaths: [] })).toBe('skip')
    expect(decideTestEdgeRebuild({ hadRemovalsOrRenames: true, changedPaths: ['src/a.ts'] })).toBe('files')
  })
})

describe('applyTestEdgeRebuild', () => {
  const opened: Array<import('node:sqlite').DatabaseSync> = []
  afterEach(() => {
    while (opened.length > 0) opened.pop()?.close()
  })

  async function seeded(): Promise<import('node:sqlite').DatabaseSync> {
    const db = await openCodeIndexDatabase(':memory:')
    opened.push(db)
    writeFilesDelta(db, {
      removals: [],
      upserts: [
        fileUpsertFixture('src/user_service.test.ts', true),
        fileUpsertFixture('src/user_service.ts'),
      ],
    })
    return db
  }

  it('skip touches nothing and never moves the epoch', async () => {
    const db = await seeded()
    const before = readEpochs(db)
    expect(applyTestEdgeRebuild(db, 'skip', ['src/user_service.ts'])).toEqual({ edgesWritten: 0 })
    expect(tableCount(db, 'test_edges')).toBe(0)
    expect(readEpochs(db)).toEqual(before)
  })

  it('files rebuilds only the given paths inside one epoch-bumped transaction', async () => {
    const db = await seeded()
    const before = readEpochs(db)
    expect(applyTestEdgeRebuild(db, 'files', ['src/user_service.test.ts'])).toEqual({ edgesWritten: 1 })
    assertExactAdvance(before, readEpochs(db), 'index')
    expect(db.prepare('SELECT code_file_path FROM test_edges').get())
      .toEqual({ code_file_path: 'src/user_service.ts' })
  })

  it('files without an enumerable path set fails loud instead of rebuilding nothing', async () => {
    const db = await seeded()
    expect(() => applyTestEdgeRebuild(db, 'files', undefined)).toThrow(/changedPaths/)
  })

  it('full recomputes the whole table from the stored path set', async () => {
    const db = await seeded()
    const before = readEpochs(db)
    expect(applyTestEdgeRebuild(db, 'full', undefined)).toEqual({ edgesWritten: 1 })
    assertExactAdvance(before, readEpochs(db), 'index')
    expect(tableCount(db, 'test_edges')).toBe(1)
  })

  it('seeds through the store writer so the decision runs against real rows', async () => {
    const db = await seededStore([
      ['src/a.test.ts', true],
      'src/a.ts',
    ])
    opened.push(db)
    expect(applyTestEdgeRebuild(db, 'files', ['src/a.test.ts']).edgesWritten).toBe(1)
  })
})
