/** Pure eligibility shared by review reads and maintenance-protected confirmation. */
import type { WorkConfirmationBlocker } from './types.ts'

/** Facts supplied by the Host's live Agent and owned registries. */
export interface ConfirmationFacts {
  root: boolean
  reviewable: boolean
  idle: boolean
  queuedInput: boolean
  approvals: number
  questions: number
  runningJobs: boolean
}

/** Explain every current refusal without inferring test or artifact success.
 * @param facts - Host facts sampled at the decision point.
 * @returns Stable ordered reasons; an empty array means eligible at this observation only.
 */
export function confirmationBlockers(facts: ConfirmationFacts): WorkConfirmationBlocker[] {
  const reasons: WorkConfirmationBlocker[] = []
  if (!facts.root) reasons.push('not-root')
  if (!facts.reviewable) reasons.push('turn-open')
  if (!facts.idle) reasons.push('running')
  if (facts.queuedInput) reasons.push('queued-input')
  if (facts.approvals > 0) reasons.push('approval')
  if (facts.questions > 0) reasons.push('question')
  if (facts.runningJobs) reasons.push('background-job')
  return reasons
}
