/** Purpose eligibility, aggregate provider budgets, identity ordering, and request limits on the native preparation seam. */
import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { createUserMessage } from '@relay-harness/rlh-llm'
import { SessionId } from '@relay-harness/rlh-session'
import ContextEngine, { type ContributedStepContext, type ContextPrepareInput, type StepContextInput } from '../src/index.ts'

/** Mount a ContextEngine service on a fresh root context. */
async function mountEngine(config?: ConstructorParameters<typeof ContextEngine>[1]): Promise<{ ctx: Context; engine: ContextEngine }> {
  const ctx = new Context()
  await ctx.plugin(ContextEngine, config)
  return { ctx, engine: ctx.contextEngine as ContextEngine }
}

function input(overrides: Partial<ContextPrepareInput> = {}): ContextPrepareInput {
  return {
    purpose: 'agent_step',
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })],
    signal: new AbortController().signal,
    cwd: '/ws',
    caller: { sessionId: SessionId('native-retrieval'), agentId: 'native-retrieval', workspaceId: '/ws', turn: 1, step: 1 },
    ...overrides,
  }
}

function candidate(text: string): ContributedStepContext {
  return { message: createUserMessage({ source: { kind: 'plugin', plugin: 'native-retrieval-test' }, content: [{ type: 'text', text }] }) }
}

describe('ContextEngine native retrieval planning', () => {
  it('excludes providers that did not opt into the requested purpose', async () => {
    const { engine } = await mountEngine()
    engine.registerContributor({
      id: 'step-only',
      purposes: ['agent_step'],
      contribute: async () => { throw new Error('provider without tool_retrieval must not receive retrieval requests') },
    })
    engine.registerContributor({ id: 'retrieval', purposes: ['tool_retrieval'], contribute: async () => candidate('retrieved') })
    const prepared = await engine.prepareStep(input({ purpose: 'tool_retrieval', messages: [] }))
    const entry = prepared?.plan.contributors.find(item => item.contributorId === 'step-only')
    expect(entry).toMatchObject({ eligible: false, reason: 'purpose_not_supported' })
    expect(prepared?.contributions.map(item => item.contributorId)).toEqual(['retrieval'])
  })

  it('charges every candidate from one provider against that provider\'s aggregate budget', async () => {
    const { engine } = await mountEngine({ maxContributorChars: 10 })
    engine.registerContributor({
      id: 'many',
      contribute: async () => [candidate('123456'), candidate('abcdef')],
    })
    const prepared = await engine.prepareStep(input())
    expect(prepared?.contributions).toHaveLength(1)
    expect(prepared?.decisions.map(item => item.outcome)).toEqual(['selected', 'rejected'])
    expect(prepared?.decisions[1]?.reasons).toEqual(['contributor_char_budget'])
  })

  it('breaks equal-rank ties by contributor identity, not registration or completion order', async () => {
    const { engine } = await mountEngine({ maxChars: 40, maxTokens: 1000 })
    for (const id of ['z', 'a']) {
      engine.registerContributor({
        id,
        contribute: async () => ({
          ...candidate(id.repeat(30)),
          selection: { priority: 'provider', reasons: ['provider_candidate'], rank: 0 },
        }),
      })
    }
    const prepared = await engine.prepareStep(input())
    // Both candidates share priority and rank; the stable source id admits 'a' and budget-rejects 'z'.
    expect(prepared?.decisions.find(item => item.contributorId === 'a')?.outcome).toBe('selected')
    expect(prepared?.decisions.find(item => item.contributorId === 'z'))
      .toMatchObject({ outcome: 'rejected', reasons: ['total_char_budget'] })
  })

  it('lets request limits lower but never raise the deployment budgets', async () => {
    const { engine } = await mountEngine({ maxChars: 20, maxTokens: 100 })
    const seen: number[] = []
    engine.registerContributor({
      id: 'budget',
      contribute: async (request: StepContextInput) => {
        seen.push(request.budget.maxChars)
        return candidate('x'.repeat(9))
      },
    })
    const raised = await engine.prepareStep(input({ limits: { maxChars: 10_000, maxTokens: 10_000 } }))
    expect(raised?.plan.budget).toEqual({ maxChars: 20, maxTokens: 100 })
    const lowered = await engine.prepareStep(input({ limits: { maxChars: 10 } }))
    expect(lowered?.plan.budget).toMatchObject({ maxChars: 10 })
    // Each eligible provider sees its plan-local allowance: the deployment cap, then the lowered request limit.
    expect(seen).toEqual([20, 10])
    for (const maxChars of [0, -1, 1.5, Number.NaN, Infinity]) {
      await expect(engine.prepareStep(input({ limits: { maxChars } })))
        .rejects.toMatchObject({ code: 'CONTEXT_ENGINE_INVALID_CONFIG' })
    }
  })

  it('carries the request deadline into each provider budget and never extends it', async () => {
    const { engine } = await mountEngine()
    const budgets: StepContextInput['budget'][] = []
    engine.registerContributor({
      id: 'clocked',
      contribute: async (request: StepContextInput) => {
        budgets.push(request.budget)
        return candidate('in time')
      },
    })
    const deadlineAt = Date.now() + 250
    const prepared = await engine.prepareStep(input({ deadlineAt }))
    expect(prepared?.contributions).toHaveLength(1)
    const budget = budgets[0]
    expect(budget?.deadlineAt).toBeLessThanOrEqual(deadlineAt)
    expect(budget?.timeoutMs).toBeLessThanOrEqual(250)
    const expired = await engine.prepareStep(input({ deadlineAt: Date.now() - 1 }))
    expect(expired?.decisions.map(item => item.reasons)).toEqual([['deadline']])
  })
})
