import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import InvariantRegistry, { InvariantError } from '@relay-harness/rlh-invariants'
import { IssueOrchestrationError } from '../src/index.ts'
import * as IssueOrchestrationInvariant from '../src/invariant.ts'

describe('issue-orchestration invariant companion', () => {
  it('accepts a change notification naming the committed snapshot revision', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    ctx.provide('issueOrchestration', { snapshot: () => ({ revision: 7 }) } as never)
    await ctx.plugin(IssueOrchestrationInvariant)

    expect(() => { ctx.emit('issue-orchestration/changed', 7) }).not.toThrow()
    await ctx.fiber.dispose()
  })

  it('rejects a change notification whose revision is not authoritative', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    ctx.provide('issueOrchestration', { snapshot: () => ({ revision: 7 }) } as never)
    await ctx.plugin(IssueOrchestrationInvariant)

    let failure: unknown
    try {
      ctx.emit('issue-orchestration/changed', 8)
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(InvariantError)
    expect((failure as InvariantError).packageName).toBe('@relay-harness/rlh-issue-orchestration')
    expect((failure as InvariantError).message).toMatch(/revision 8 is not authoritative/)
    await ctx.fiber.dispose()
  })

  it('rejects a notification when no orchestration service holds the authority', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(IssueOrchestrationInvariant)

    expect(() => { ctx.emit('issue-orchestration/changed', 1) }).toThrow(/is not authoritative/)
    await ctx.fiber.dispose()
  })

  it('stops checking notifications once the companion fiber disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(InvariantRegistry)
    ctx.provide('issueOrchestration', { snapshot: () => ({ revision: 7 }) } as never)
    const companion = await ctx.plugin(IssueOrchestrationInvariant)

    expect(() => { ctx.emit('issue-orchestration/changed', 8) }).toThrow(InvariantError)
    await companion.dispose()
    expect(() => { ctx.emit('issue-orchestration/changed', 8) }).not.toThrow()
    await ctx.fiber.dispose()
  })
})

describe('IssueOrchestrationError', () => {
  it.each([
    'ISSUE_NOT_FOUND',
    'ISSUE_RUNNING',
  ] as const)('carries the stable rejection code %s', (code) => {
    const error = new IssueOrchestrationError('command rejected', code)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('IssueOrchestrationError')
    expect(error.code).toBe(code)
    expect(error.message).toBe('command rejected')
  })
})
