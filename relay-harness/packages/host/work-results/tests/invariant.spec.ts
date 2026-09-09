import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import Invariants from '@relay-harness/rlh-invariants'
import Sessions, { Session, SessionId } from '@relay-harness/rlh-session'
import * as companion from '../src/invariant.ts'
import { readAcceptedRevision, workAcceptanceProjection } from '../src/projection.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Sessions)
  await ctx.plugin(Invariants, { enabled: true })
  return ctx
}

function complete(session: Session) {
  session.append('turn/start', { turn: 1 })
  return session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }).seq
}

describe('Work receipt relationships', () => {
  it('checks existing logs and newly published seeds without treating duplicate receipts as new work', async () => {
    const ctx = await harness()
    const live = ctx.sessions.create(SessionId('existing'))
    const cut = complete(live)
    live.append('work/accepted', { actor: 'host-client', reviewedThroughSeq: cut })
    await ctx.plugin(companion)
    expect(() => {
      live.append('work/accepted', { actor: 'host-client', reviewedThroughSeq: cut })
    }).not.toThrow()
    const source = Session.create(SessionId('seed'))
    source.append('turn/start', { turn: 1 })
    const last = source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    source.append('work/accepted', { actor: 'host-client', reviewedThroughSeq: last.seq })
    expect(() => { ctx.sessions.create(source.id, { seed: source.events }) }).not.toThrow()
  })

  it.each(['empty', 'mismatched'] as const)('rejects an %s receipt prefix on a live Session', async (kind) => {
    const ctx = await harness()
    await ctx.plugin(companion)
    const session = ctx.sessions.create(SessionId(kind))
    if (kind === 'mismatched') complete(session)
    expect(() => {
      session.append('work/accepted', { actor: 'host-client', reviewedThroughSeq: 0 })
    }).toThrow(/receipt does not name its prior revision/)
  })

  it('refuses a corrupt preexisting receipt when its companion is loaded', async () => {
    const ctx = await harness()
    const session = ctx.sessions.create(SessionId('bad-existing'))
    complete(session)
    session.append('work/accepted', { actor: 'host-client', reviewedThroughSeq: 0 })
    await expect(ctx.plugin(companion)).rejects.toMatchObject({
      code: 'INVARIANT', packageName: '@relay-harness/rlh-host-work-results',
    })
  })

  it('rolls back publication of a seed whose receipt precedes any reviewable prefix', async () => {
    const ctx = await harness()
    await ctx.plugin(companion)
    const source = Session.create(SessionId('bad-seed'))
    source.append('work/accepted', { actor: 'host-client', reviewedThroughSeq: 0 })
    expect(() => { ctx.sessions.create(source.id, { seed: source.events }) }).toThrow(/prior revision/)
    expect(ctx.sessions.get(source.id)).toBeUndefined()
  })

  it('rejects negative receipt cuts and a cached cut at or beyond the receipt sequence', () => {
    expect(() => readAcceptedRevision({ actor: 'host-client', reviewedThroughSeq: -1 })).toThrow()
    const source = Session.create(SessionId('projection-cut'))
    source.append('turn/start', { turn: 1 })
    const receipt = source.append('work/accepted', { actor: 'host-client', reviewedThroughSeq: 2 })
    expect(() => workAcceptanceProjection.apply({ reviewRevision: 2, acceptedRevision: null, reviewable: true }, receipt))
      .toThrow(/does not match its prior review revision/)
  })
})
