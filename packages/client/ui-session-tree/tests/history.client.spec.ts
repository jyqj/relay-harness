import { describe, expect, it, vi } from 'vitest'
import type { HistoryEntry, IApiClient, SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { readCompleteHistory } from '../src/client/history.ts'

const sid = 'session' as SessionId
const entry = (seq: number): HistoryEntry => ({
  event: { type: 'session/end-seed', seq, time: seq, data: {} },
})
const apiWith = (history: (payload: { beforeSeq?: number }) => Promise<unknown>): IApiClient => ({
  sessions: { history },
} as unknown as IApiClient)

describe('readCompleteHistory', () => {
  it('pages backwards and returns one ascending contiguous history', async () => {
    const history = vi.fn(async ({ beforeSeq }: { beforeSeq?: number }) => ({
      result: { ok: true, value: beforeSeq === undefined
        ? { events: [entry(2), entry(3)], hasMore: true }
        : { events: [entry(0), entry(1)], hasMore: false } },
    }))
    await expect(readCompleteHistory(apiWith(history), sid)).resolves
      .toEqual([entry(0), entry(1), entry(2), entry(3)])
    expect(history.mock.calls.map(([payload]) => payload.beforeSeq)).toEqual([undefined, 2])
  })

  it('returns an empty terminal page and forwards an already-aborted signal', async () => {
    const history = vi.fn(async () => ({ result: { ok: true, value: { events: [], hasMore: true } } }))
    await expect(readCompleteHistory(apiWith(history), sid)).resolves.toEqual([])
    const controller = new AbortController()
    controller.abort(new Error('closed'))
    await expect(readCompleteHistory(apiWith(history), sid, controller.signal)).rejects.toThrow('closed')
  })

  it('reports Host business errors and non-progressing pagination', async () => {
    await expect(readCompleteHistory(apiWith(async () => ({
      result: { ok: false, error: { code: 'internal', message: 'broken', details: {} } },
    })), sid)).rejects.toThrow('internal: broken')

    const history = vi.fn(async () => ({
      result: { ok: true, value: { events: [entry(2)], hasMore: true } },
    }))
    await expect(readCompleteHistory(apiWith(history), sid)).rejects.toThrow('did not advance')
  })
})
