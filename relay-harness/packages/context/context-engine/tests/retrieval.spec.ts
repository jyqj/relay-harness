/** Explicit retrieval and evidence-granular packing use the existing provider lifecycle. */
import { Context } from '@relay-harness/cordis'
import { createUserMessage } from '@relay-harness/rlh-llm'
import { SessionId } from '@relay-harness/rlh-session'
import { describe, expect, it, vi } from 'vitest'
import ContextEngine, { EvidenceId, SourceId, type ContributedStepContext, type ContextRetrievalInput } from '../src/index.ts'

const query = 'find the implementation'
const input = (): ContextRetrievalInput => ({
  query, cwd: '/workspace', signal: new AbortController().signal,
  caller: { sessionId: SessionId('owned'), agentId: 'owned', workspaceId: '/workspace' },
})
function candidate(text: string, key = text): ContributedStepContext {
  return {
    message: createUserMessage({ source: { kind: 'plugin', plugin: 'retrieval-test' }, content: [{ type: 'text', text }] }),
    evidence: [{ evidenceId: EvidenceId(key), resource: { sourceId: SourceId('test'), key, revision: 'r1' },
      truncated: false, freshness: 'current', verification: 'unverified' }],
    coverage: { searched: [key], notSearched: [], completeness: 'bounded' },
  }
}
async function runtime(config?: ConstructorParameters<typeof ContextEngine>[1]) {
  const ctx = new Context()
  await ctx.plugin(ContextEngine, config)
  return { ctx, engine: ctx.contextEngine }
}

describe('explicit context retrieval', () => {
  it('returns an inspectable empty report rather than claiming a search occurred', async () => {
    const { engine } = await runtime()
    expect(engine.describeContributors()).toEqual([])
    const report = await engine.retrieve(input())
    expect(report).toMatchObject({ messages: [], evidence: [], decisions: [], plan: { purpose: 'tool_retrieval', contributors: [] } })
  })

  it('requires a provider to opt into model-authored queries without fabricating human input', async () => {
    const { engine } = await runtime()
    const legacy = vi.fn(async () => candidate('legacy'))
    const called = vi.fn(async () => candidate('available'))
    engine.registerContributor({ id: 'legacy', contribute: legacy })
    engine.registerContributor({ id: 'selected', purposes: ['tool_retrieval'], contribute: called })
    const report = await engine.retrieve(input())
    expect(legacy).not.toHaveBeenCalled()
    expect(called).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'tool_retrieval', query, messages: [], cwd: '/workspace', caller: input().caller }))
    expect(report.plan.contributors[0]).toMatchObject({ eligible: false, reason: 'purpose_not_supported' })
    expect(engine.describeContributors()).toEqual([
      { id: 'legacy', purposes: ['agent_step', 'prompt_enhancement'] },
      { id: 'selected', purposes: ['tool_retrieval'] },
    ])
    expect(Object.isFrozen(engine.describeContributors())).toBe(true)
  })

  it('limits requested sources and clamps a tighter request budget', async () => {
    const { engine } = await runtime({ maxChars: 100, maxTokens: 50 })
    const omitted = vi.fn(async () => candidate('omitted'))
    engine.registerContributor({ id: 'omitted', purposes: ['tool_retrieval'], contribute: omitted })
    engine.registerContributor({ id: 'selected', purposes: ['tool_retrieval'], contribute: async () => candidate('chosen') })
    const result = await engine.retrieve({ ...input(), contributors: ['selected'], budget: { maxChars: 10, maxTokens: 10 } })
    expect(omitted).not.toHaveBeenCalled()
    expect(result.plan.budget).toEqual({ maxChars: 10, maxTokens: 10 })
    expect(result.plan.contributors[0]).toMatchObject({ eligible: false, reason: 'not_requested' })
    const wide = await engine.retrieve({ ...input(), budget: { maxChars: 1000, maxTokens: 1000 } })
    expect(wide.plan.budget).toEqual({ maxChars: 100, maxTokens: 50 })
    await expect(engine.retrieve({ ...input(), query: ' ' })).rejects.toMatchObject({ code: 'CONTEXT_ENGINE_INVALID_REQUEST' })
    await expect(engine.retrieve({ ...input(), contributors: ['unknown'] })).rejects.toMatchObject({ code: 'CONTEXT_ENGINE_UNKNOWN_SOURCE' })
    await expect(engine.retrieve({ ...input(), budget: { maxChars: 0, maxTokens: 10 } })).rejects.toMatchObject({ code: 'CONTEXT_ENGINE_INVALID_CONFIG' })
  })

  it('packs ranked observations independently and keeps inspected coverage for omitted evidence', async () => {
    const { engine } = await runtime({ maxChars: 10, maxTokens: 100 })
    engine.registerContributor({ id: 'z', purposes: ['tool_retrieval'], contribute: async () => [candidate('zzzz', 'z0'), candidate('zzzz', 'z1')] })
    engine.registerContributor({ id: 'a', purposes: ['tool_retrieval'], contribute: async () => [candidate('aaaa', 'a0'), candidate('aaaa', 'a1')] })
    const report = await engine.retrieve(input())
    // The first observation from each source outranks either source's second candidate.
    expect(report.evidence.map(item => item.evidenceId).sort()).toEqual(['a0', 'z0'])
    expect(report.decisions.filter(item => item.outcome === 'selected').map(item => item.contributorId)).toEqual(['a', 'z'])
    expect(report.coverage.flatMap(item => item.searched)).toEqual(['z0', 'z1', 'a0', 'a1'])
  })

  it('bounds the sum of all selected candidates from a provider, not each candidate separately', async () => {
    const { engine } = await runtime({ maxChars: 100, maxTokens: 100, maxContributorChars: 5, maxContributorTokens: 100 })
    engine.registerContributor({ id: 'one', purposes: ['tool_retrieval'], contribute: async () => [candidate('1234', '1'), candidate('5678', '2')] })
    const report = await engine.retrieve(input())
    expect(report.contributions).toHaveLength(1)
    expect(report.decisions[1]?.reasons).toEqual(['contributor_char_budget'])
  })

  it('keeps identical text with distinct provenance unless a canonical deduplication key is supplied', async () => {
    const { engine } = await runtime()
    for (const id of ['a', 'b']) engine.registerContributor({ id, purposes: ['tool_retrieval'], contribute: async () => candidate('same', id) })
    expect((await engine.retrieve(input())).contributions).toHaveLength(2)
  })

  it('handles empty batches, rejects ambiguous message identities, and contains malformed ranks', async () => {
    const { engine } = await runtime()
    const remove = engine.registerContributor({ id: 'batch', purposes: ['tool_retrieval'], contribute: async () => [] })
    expect((await engine.retrieve(input())).decisions).toEqual([{ contributorId: 'batch', outcome: 'rejected', reasons: ['declined'] }])
    remove()
    const repeated = candidate('same')
    const undo = engine.registerContributor({ id: 'batch', purposes: ['tool_retrieval'], contribute: async () => [repeated, repeated] })
    await expect(engine.retrieve(input())).rejects.toMatchObject({ code: 'CONTEXT_ENGINE_INVALID_CONTRIBUTION' })
    undo()
    engine.registerContributor({ id: 'batch', purposes: ['tool_retrieval'], contribute: async () => ({ ...candidate('bad'), selection: { priority: 'provider', reasons: [], rank: -1 } }) })
    await expect(engine.retrieve(input())).rejects.toMatchObject({ code: 'CONTEXT_ENGINE_INVALID_CONTRIBUTION' })
  })
})
