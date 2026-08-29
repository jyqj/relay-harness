/**
 * Package-owned invariant companion for `@relay-harness/rlh-context-engine`.
 * @module @relay-harness/rlh-context-engine/invariant
 */

import type { Context } from '@relay-harness/cordis'
import type { InvariantFailure, InvariantInstaller } from '@relay-harness/rlh-invariants'
import type { Session, SessionEvent } from '@relay-harness/rlh-session'

const PACKAGE_NAME = '@relay-harness/rlh-context-engine'

/** Cordis companion plugin name. */
export const name = 'context-engine-invariant'
/** Services required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * Validate one context-preparation trace against its owning step and previously logged messages.
 */
function validateEvent(session: Session, event: SessionEvent, fail: InvariantFailure): void {
  if (event.type !== 'context/prepared') return
  const prefix = session.events.filter(candidate => candidate.seq < event.seq)
  const eventsBySeq = new Map(prefix.map(candidate => [candidate.seq, candidate]))
  const boundary = prefix.findLast(candidate =>
    candidate.type === 'step/start' || candidate.type === 'step/end')
  if (boundary?.type !== 'step/start'
    || boundary.data.turn !== event.data.turn
    || boundary.data.step !== event.data.step) {
    fail(`context/prepared names turn ${event.data.turn}/step ${event.data.step} without that open step`)
  }
  const stepStartSeq = boundary.seq
  const stepPrefix = prefix.filter(candidate => candidate.seq > stepStartSeq)
  if (stepPrefix.some(candidate => candidate.type === 'context/prepared')) {
    fail(`context/prepared repeats the preparation trace for turn ${event.data.turn}/step ${event.data.step}`)
  }
  if (stepPrefix.some(candidate =>
    candidate.type === 'request/header'
    || candidate.type === 'request/context'
    || candidate.type === 'assistant/chunk'
    || candidate.type === 'assistant/message'
    || candidate.type === 'tool/call'
    || candidate.type === 'tool/result')) {
    fail('context/prepared must precede request dispatch and model/tool output in its owning step')
  }
  if (event.data.contributions.length === 0
    && !event.data.decisions.some(decision => decision.outcome === 'rejected')) {
    fail('context/prepared must carry an attributed contribution or a rejected retrieval decision')
  }
  if (event.data.plan.purpose !== 'agent_step') {
    fail(`context/prepared carries non-Agent purpose "${event.data.plan.purpose}"`)
  }
  const eligiblePlanIds = new Set<string>()
  const planIds = new Set<string>()
  for (const entry of event.data.plan.contributors) {
    if (entry.contributorId.trim() === '' || planIds.has(entry.contributorId)) {
      fail(`context/prepared carries duplicate or empty plan contributor "${entry.contributorId}"`)
    }
    planIds.add(entry.contributorId)
    if (entry.eligible) eligiblePlanIds.add(entry.contributorId)
  }
  const decisionsByContributor = new Map<string, typeof event.data.decisions[number]>()
  for (const decision of event.data.decisions) {
    if (!eligiblePlanIds.has(decision.contributorId)) {
      fail(`context/prepared decision names unplanned or ineligible contributor "${decision.contributorId}"`)
    }
    if (decisionsByContributor.has(decision.contributorId)) {
      fail(`context/prepared repeats decision for contributor "${decision.contributorId}"`)
    }
    if (decision.outcome === 'selected' && decision.messageId === undefined) {
      fail(`context/prepared selected decision for "${decision.contributorId}" has no message id`)
    }
    decisionsByContributor.set(decision.contributorId, decision)
  }
  const contributorIds = new Set<string>()
  const evidenceIds = new Set<string>()
  const referencedSeqs = new Set<number>()
  for (const contribution of event.data.contributions) {
    if (contribution.contributorId.trim() === '') {
      fail('context/prepared carries an empty contributor id')
    }
    if (String(contribution.messageId).trim() === '') {
      fail(`context/prepared contribution "${contribution.contributorId}" carries an empty message id`)
    }
    if (contributorIds.has(contribution.contributorId)) {
      fail(`context/prepared repeats contributor id "${contribution.contributorId}"`)
    }
    contributorIds.add(contribution.contributorId)
    const decision = decisionsByContributor.get(contribution.contributorId)
    if (decision?.outcome !== 'selected' || decision.messageId !== contribution.messageId) {
      fail(`context/prepared contribution "${contribution.contributorId}" has no selected decision for message ${String(contribution.messageId)}`)
    }
    for (const evidence of contribution.evidence) {
      if (evidenceIds.has(evidence.evidenceId)) {
        fail(`context/prepared repeats evidence id "${evidence.evidenceId}"`)
      }
      evidenceIds.add(evidence.evidenceId)
    }
    for (const seq of contribution.messageEventSeqs) {
      if (referencedSeqs.has(seq)) {
        fail(`context/prepared references user/message seq ${seq} more than once`)
      }
      referencedSeqs.add(seq)
      if (seq <= stepStartSeq) {
        fail(`context/prepared references user/message seq ${seq} from outside its owning step`)
      }
      const message = eventsBySeq.get(seq)
      if (message?.seq !== seq || message.type !== 'user/message') {
        fail(`context/prepared references seq ${seq}, which is not an earlier user/message`)
      }
      if (message.data.id !== contribution.messageId) {
        fail(`context/prepared contribution "${contribution.contributorId}" names message ${String(contribution.messageId)} but seq ${seq} carries ${String(message.data.id)}`)
      }
    }
  }
  for (const decision of event.data.decisions) {
    if (decision.outcome === 'selected' && !contributorIds.has(decision.contributorId)) {
      fail(`context/prepared selected decision for "${decision.contributorId}" has no contribution`)
    }
  }
}

/** Install validation for loaded and newly appended context-preparation traces. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const seed = (session: Session): void => {
    for (const event of session.events) validateEvent(session, event, fail)
  }
  for (const session of ctx.sessions.list()) seed(session)
  ctx.on('session/created', (session) => { seed(session) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    validateEvent(session, event, fail)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
