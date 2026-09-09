/** Receipt ownership is a relation to the exact preceding Session log revision. */
import type { Context } from '@relay-harness/cordis'
import type { InvariantFailure, InvariantInstaller } from '@relay-harness/rlh-invariants'
import type { Session, SessionEvent } from '@relay-harness/rlh-session'
import { readAcceptedRevision } from './projection.ts'

/** Cordis companion name. */
export const name = 'host-work-results-invariant'
/** Registry required before installing this package's assertions. */
export const inject = ['invariants']

/** Check only the rare acceptance edge against its authoritative preceding events. */
function check(session: Session, event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'work/accepted') return
  const prior = session.events.findLast(item => item.seq < event.seq && item.type !== 'work/accepted')?.seq ?? -1
  try {
    // The decoder already requires a non-negative cut; equality also excludes an empty prefix.
    if (readAcceptedRevision(event.data) !== prior) throw new Error('receipt does not name its prior revision')
  } catch (error) {
    fail(`work acceptance at seq ${event.seq}: ${String(error)}`)
  }
}

const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) for (const event of session.events) check(session, event, fail)
  ctx.on('session/created', (session) => { for (const event of session.events) check(session, event, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, name, args) => {
    if (name !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    check(session, event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the package's relationship checks with the invariant owner.
 * @param ctx - companion context.
 * @returns the owned registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register('@relay-harness/rlh-host-work-results', install))
