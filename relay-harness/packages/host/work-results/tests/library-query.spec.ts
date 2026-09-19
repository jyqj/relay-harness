import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { CallId, createToolResultMessage } from '@relay-harness/rlh-llm'
import SessionStore, { Session, SessionId } from '@relay-harness/rlh-session'
import SessionProjectionRegistry from '@relay-harness/rlh-session-projection'
import { deliverablesProjection } from '../src/projection.ts'
import { LibraryQueries } from '../src/library-query.ts'
import type { WorkLibraryPage } from '../src/types.ts'

let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined })

const CONFIG = {
  scanSessionsPerPage: 10, maxResultsPerPage: 50, defaultResultsPerPage: 10,
  maxLibraryQueries: 8, libraryQueryTtlMs: 60000, maxLibrarySessions: 10000,
}

async function harness(extraPersisted: readonly SessionId[] = [], overrides: Partial<typeof CONFIG> = {}) {
  ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(Object.assign((inner: Context) => {
    inner.sessionProjections.register(deliverablesProjection)
    inner.provide('sessionQuery', {
      listSessions: async () => [...inner.sessions.list()].map(session => ({ header: structuredClone(session.header), live: true, persisted: false }))
        .concat(extraPersisted.map(id => ({ header: { version: 0, id, createdAt: 1 }, live: false, persisted: true }))),
      readSession: async (id: SessionId) => { throw new Error(`no cold history for ${id}`) },
    } as never)
  }, { inject: ['sessions', 'sessionProjections'] }))
  return { ctx, library: new LibraryQueries(ctx, { ...CONFIG, ...overrides }) }
}

function result(session: Session, paths?: readonly string[], isError = false): void {
  const callId = CallId(`call-${session.seq}`)
  const call = session.append('tool/call', { turn: 1, step: 1, callId, name: 'write', arguments: '{}' })
  session.append('tool/result', {
    turn: 1, step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: 'done' }], isError }),
    ...paths === undefined ? {} : { producedFiles: paths },
  }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
}

async function firstPage(library: LibraryQueries): Promise<WorkLibraryPage> {
  return library.read({ query: '.txt' }, new AbortController().signal)
}

function continueRead(library: LibraryQueries, page: WorkLibraryPage): Promise<WorkLibraryPage> {
  return library.read({ query: '.txt', sessionOffset: page.scannedSessions, pathOffset: 0, corpusRevision: page.coverage!.snapshotId }, new AbortController().signal)
}

describe('retained Library observations invalidate only on contributing changes', () => {
  it('keeps a valid page across failed and duplicate outputs of an observed session', async () => {
    const { library } = await harness()
    const session = ctx!.sessions.create(SessionId('noisy'))
    result(session, ['done.txt'])
    const page = await firstPage(library)
    expect(page.entries.map(entry => entry.path)).toEqual(['done.txt'])
    result(session, ['ignored.txt'], true)
    result(session, ['done.txt'])
    const continued = await continueRead(library, page)
    expect(continued.entries).toEqual([])
    expect(continued.coverage?.snapshotId).toBe(page.coverage!.snapshotId)
  })

  it('invalidates when an observed session gains a new captured output', async () => {
    const { library } = await harness()
    const session = ctx!.sessions.create(SessionId('growing'))
    result(session, ['old.txt'])
    const page = await firstPage(library)
    result(session, ['new.txt'])
    await expect(continueRead(library, page)).rejects.toThrow('workResults Library changed; restart the search')
  })

  it('invalidates on a new session and on a first result from a session outside the observed corpus', async () => {
    const missing = SessionId('unobserved')
    const { library } = await harness([missing])
    const session = ctx!.sessions.create(SessionId('listed'))
    result(session, ['mine.txt'])
    const page = await firstPage(library)
    expect(page.coverage?.omittedSessions).toBe(0)
    ctx!.sessions.create(missing)
    await expect(continueRead(library, page)).rejects.toThrow('workResults Library changed; restart the search')
  })

  it('invalidates on a first result from a session omitted from the retained corpus', async () => {
    const { ctx, library } = await harness([], { maxLibrarySessions: 1 })
    const first = ctx.sessions.create(SessionId('omitted-a'))
    const second = ctx.sessions.create(SessionId('omitted-b'))
    result(first, ['a.txt'])
    result(second, ['b.txt'])
    const page = await firstPage(library)
    expect(page.coverage?.omittedSessions).toBe(1)
    const observed = page.observedSessionIds![0]
    const other = observed === first.id ? second : first
    result(other, ['late.txt'])
    await expect(continueRead(library, page)).rejects.toThrow('workResults Library changed; restart the search')
  })

  it('retains unavailable sources as reported gaps with deduplicated statistics', async () => {
    const missing = SessionId('cold-unavailable')
    const { library } = await harness([missing])
    const session = ctx!.sessions.create(SessionId('warm'))
    result(session, ['warm.txt'])
    const page = await firstPage(library)
    expect(page.unavailableSessions).toBe(1)
    expect(page.entries.map(entry => entry.path)).toEqual(['warm.txt'])
    expect(page.coverage).toMatchObject({ scope: 'observed-corpus', omittedSessions: 0 })
  })
})
