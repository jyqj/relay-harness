import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import InvariantRegistry, { InvariantError } from '@relay-harness/rlh-invariants'
import * as IssueWorkflowInvariant from '../src/invariant.ts'
import type { IssueWorkflowSnapshot } from '../src/index.ts'

const snapshot = (revision: string): IssueWorkflowSnapshot => ({
  path: '/issues/workflow.yaml',
  revision,
  loadedAt: 1,
  policy: {} as never,
})

describe('issue-workflow invariant companion', () => {
  it('accepts an update that advances to the authoritative current revision', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    ctx.provide('issueWorkflow', { current: () => snapshot('next') } as never)
    await ctx.plugin(IssueWorkflowInvariant)

    expect(() => { ctx.emit('issue-workflow/updated', snapshot('next'), snapshot('old')) }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('rejects an update that repeats the previous revision', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    ctx.provide('issueWorkflow', { current: () => snapshot('same') } as never)
    await ctx.plugin(IssueWorkflowInvariant)

    let failure: unknown
    try {
      ctx.emit('issue-workflow/updated', snapshot('same'), snapshot('same'))
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(InvariantError)
    expect((failure as InvariantError).packageName).toBe('@relay-harness/rlh-issue-workflow')
    expect((failure as InvariantError).message).toMatch(/repeated the previous revision/)
    await ctx.fiber.dispose()
  })

  it('rejects an update whose revision diverges from the provider current revision', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    ctx.provide('issueWorkflow', { current: () => snapshot('stale') } as never)
    await ctx.plugin(IssueWorkflowInvariant)

    expect(() => { ctx.emit('issue-workflow/updated', snapshot('next'), snapshot('old')) })
      .toThrow(/does not match the authoritative current revision/)
    await ctx.fiber.dispose()
  })

  it('stops checking updates once the companion fiber disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    ctx.provide('issueWorkflow', { current: () => snapshot('stale') } as never)
    const companion = await ctx.plugin(IssueWorkflowInvariant)

    expect(() => { ctx.emit('issue-workflow/updated', snapshot('same'), snapshot('same')) }).toThrow(InvariantError)
    await companion.dispose()
    expect(() => { ctx.emit('issue-workflow/updated', snapshot('same'), snapshot('same')) }).not.toThrow()
    await ctx.fiber.dispose()
  })
})
