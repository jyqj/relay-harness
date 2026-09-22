import { describe, expect, it } from 'vitest'
import { confirmationBlockers, type ConfirmationFacts } from '../src/confirmation-policy.ts'

const quiet: ConfirmationFacts = {
  root: true, reviewable: true, idle: true, queuedInput: false, approvals: 0, questions: 0, runningJobs: false,
}
describe('Host confirmation eligibility', () => {
  it('permits only a quiet root record without asserting tests or file content', () => {
    expect(confirmationBlockers(quiet)).toEqual([])
  })
  it.each([
    [{ root: false }, 'not-root'], [{ reviewable: false }, 'turn-open'], [{ idle: false }, 'running'],
    [{ queuedInput: true }, 'queued-input'], [{ approvals: 1 }, 'approval'], [{ questions: 1 }, 'question'], [{ runningJobs: true }, 'background-job'],
  ] as const)('explains %j as %s', (change, reason) => {
    expect(confirmationBlockers({ ...quiet, ...change })).toEqual([reason])
  })
  it('reports simultaneous constraints in deterministic order', () => {
    expect(confirmationBlockers({
      root: false, reviewable: false, idle: false, queuedInput: true, approvals: 2, questions: 3, runningJobs: true,
    }))
      .toEqual(['not-root', 'turn-open', 'running', 'queued-input', 'approval', 'question', 'background-job'])
  })
})
