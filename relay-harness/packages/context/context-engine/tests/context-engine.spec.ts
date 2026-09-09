import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { createUserMessage } from '@relay-harness/rlh-llm'
import { SessionId } from '@relay-harness/rlh-session'
import ContextEngine, {
  ContextEngineError,
  ContextProviderError,
  EvidenceId,
  SourceId,
  type ContributedStepContext,
  type ContextPrepareInput,
  type CoverageRecord,
  type Evidence,
  type StepContextContributor,
  type StepContextInput,
} from '@relay-harness/rlh-context-engine'

/** Mount a ContextEngine service on a fresh root context. */
async function mountEngine(config?: ConstructorParameters<typeof ContextEngine>[1]): Promise<{ ctx: Context; engine: ContextEngine }> {
  const ctx = new Context()
  await ctx.plugin(ContextEngine, config)
  return { ctx, engine: ctx.contextEngine as ContextEngine }
}

function input(): ContextPrepareInput {
  return {
    purpose: 'agent_step',
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })],
    signal: new AbortController().signal,
    cwd: '/ws',
    caller: { sessionId: SessionId('context-test'), agentId: 'context-test', workspaceId: '/ws', turn: 1, step: 1 },
  }
}

function contributed(text: string, evidence?: readonly Evidence[]): ContributedStepContext {
  return {
    message: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
    ...evidence === undefined ? {} : { evidence },
  }
}

const coverage: CoverageRecord = {
  searched: ['src/**'],
  notSearched: ['vendor/**'],
  rationale: 'workspace source scope',
  completeness: 'bounded',
}

const evidence: Evidence = {
  evidenceId: EvidenceId('ev-1'),
  resource: { sourceId: SourceId('workspace-files'), key: 'src/a.ts', revision: '1:2:3:4:5' },
  truncated: false,
  freshness: 'current',
  verification: 'unverified',
}

/** A scripted contributor that records the inputs it receives. */
function makeContributor(
  id: string,
  result: ContributedStepContext | undefined,
): StepContextContributor & { seen: StepContextInput[] } {
  const seen: StepContextInput[] = []
  return {
    id,
    seen,
    contribute(received) {
      seen.push(received)
      return Promise.resolve(result)
    },
  }
}

describe('ContextEngine registration', () => {
  it('rejects invalid planning budgets before publishing the service', () => {
    expect(() => new ContextEngine(new Context(), { maxChars: 0 })).toThrow(expect.objectContaining({
      code: 'CONTEXT_ENGINE_INVALID_CONFIG',
    }))
    expect(() => new ContextEngine(new Context(), { contributorTimeoutMs: Number.MAX_SAFE_INTEGER }))
      .toThrow(expect.objectContaining({ code: 'CONTEXT_ENGINE_INVALID_CONFIG' }))
  })

  it('rejects an empty or whitespace contributor id', async () => {
    const { engine } = await mountEngine()
    expect(() => engine.registerContributor(makeContributor('  ', undefined))).toThrow(ContextEngineError)
    expect(() => engine.registerContributor(makeContributor('', undefined))).toThrow(ContextEngineError)
  })

  it('rejects a duplicate contributor id and reports the stable code', async () => {
    const { engine } = await mountEngine()
    engine.registerContributor(makeContributor('a', undefined))
    try {
      engine.registerContributor(makeContributor('a', undefined))
      expect.unreachable('duplicate registration must throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ContextEngineError)
      expect((error as ContextEngineError).code).toBe('CONTEXT_ENGINE_CONFLICT')
    }
  })

  it('removes exactly its own contributor on dispose and frees the id', async () => {
    const { engine } = await mountEngine()
    const disposeA = engine.registerContributor(makeContributor('a', contributed('from a')))
    engine.registerContributor(makeContributor('b', contributed('from b')))
    disposeA()
    const prepared = await engine.prepareStep(input())
    expect(prepared?.messages.map(message => (message.content[0] as { text: string }).text)).toEqual(['from b'])
    engine.registerContributor(makeContributor('a', contributed('from a again')))
    // Cordis disposers are normally once-only, but the public seam promises
    // generation ownership too: a stale duplicate cleanup cannot remove the
    // successor that reused the same id.
    disposeA()
    const afterStaleDispose = await engine.prepareStep(input())
    expect(afterStaleDispose?.messages.map(message => (message.content[0] as { text: string }).text))
      .toEqual(['from b', 'from a again'])
  })
})

describe('ContextEngine prepareStep', () => {
  it('plans only contributors eligible for the requested purpose', async () => {
    const { engine } = await mountEngine()
    let agentCalls = 0
    let enhancementCalls = 0
    engine.registerContributor({
      id: 'agent-only',
      purposes: ['agent_step'],
      contribute() { agentCalls += 1; return Promise.resolve(contributed('agent')) },
    })
    engine.registerContributor({
      id: 'enhancement-only',
      purposes: ['prompt_enhancement'],
      contribute() { enhancementCalls += 1; return Promise.resolve(contributed('enhancement')) },
    })

    const prepared = await engine.prepareStep({ ...input(), purpose: 'prompt_enhancement' })

    expect(agentCalls).toBe(0)
    expect(enhancementCalls).toBe(1)
    expect(prepared?.messages.map(message => (message.content[0] as { text: string }).text))
      .toEqual(['enhancement'])
    expect(prepared?.plan.contributors).toEqual([
      { contributorId: 'agent-only', eligible: false, reason: 'purpose_not_supported' },
      expect.objectContaining({
        contributorId: 'enhancement-only', eligible: true, reason: 'purpose_supported',
      }),
    ])
  })

  it('packs explicit-reference context before ordinary provider context under the total budget', async () => {
    const { engine } = await mountEngine({ maxChars: 8, maxTokens: 100 })
    engine.registerContributor(makeContributor('ordinary', {
      ...contributed('normal'),
      selection: { priority: 'provider', reasons: ['semantic_match'] },
    }))
    engine.registerContributor(makeContributor('explicit', {
      ...contributed('explicit'),
      selection: { priority: 'explicit-reference', reasons: ['direct_user_reference'] },
    }))

    const prepared = await engine.prepareStep(input())

    expect(prepared?.messages.map(message => (message.content[0] as { text: string }).text))
      .toEqual(['explicit'])
    expect(prepared?.decisions).toEqual([
      expect.objectContaining({ contributorId: 'explicit', outcome: 'selected' }),
      expect.objectContaining({ contributorId: 'ordinary', outcome: 'rejected', reasons: ['total_char_budget'] }),
    ])
  })

  it('times out one provider, aborts its local signal, and still runs later providers', async () => {
    const { engine } = await mountEngine({ contributorTimeoutMs: 5 })
    let slowSignal: AbortSignal | undefined
    let laterCalls = 0
    engine.registerContributor({
      id: 'slow',
      contribute(received) {
        slowSignal = received.signal
        return new Promise((resolve) => {
          setTimeout(() => { resolve(contributed('late')) }, 40)
        })
      },
    })
    engine.registerContributor({
      id: 'later',
      contribute() { laterCalls += 1; return Promise.resolve(contributed('later')) },
    })

    const prepared = await engine.prepareStep(input())

    expect(slowSignal?.aborted).toBe(true)
    expect(laterCalls).toBe(1)
    expect(prepared?.messages.map(message => (message.content[0] as { text: string }).text))
      .toEqual(['later'])
    expect(prepared?.decisions).toContainEqual({
      contributorId: 'slow', outcome: 'rejected', reasons: ['timeout'],
    })
  })

  it('normalizes a signal-aware provider rejection caused by its deadline as timeout', async () => {
    const { engine } = await mountEngine({ contributorTimeoutMs: 5 })
    engine.registerContributor({
      id: 'cooperative-slow',
      contribute(received) {
        return new Promise((_resolve, reject) => {
          received.signal.addEventListener('abort', () => {
            reject(received.signal.reason instanceof Error
              ? received.signal.reason
              : new Error('provider signal aborted'))
          }, { once: true })
        })
      },
    })

    await expect(engine.prepareStep(input())).resolves.toMatchObject({
      messages: [],
      decisions: [{ contributorId: 'cooperative-slow', outcome: 'rejected', reasons: ['timeout'] }],
    })
  })

  it('does not publish a late result from a disposed registration generation', async () => {
    const { engine } = await mountEngine()
    let release!: (value: ContributedStepContext) => void
    const dispose = engine.registerContributor({
      id: 'replaceable',
      contribute: () => new Promise((resolve) => { release = resolve }),
    })
    const preparing = engine.prepareStep(input())
    await Promise.resolve()
    dispose()
    engine.registerContributor(makeContributor('replaceable', contributed('successor')))
    release(contributed('stale'))

    const prepared = await preparing

    expect(prepared?.messages).toEqual([])
    expect(prepared?.decisions).toEqual([
      { contributorId: 'replaceable', outcome: 'rejected', reasons: ['disposed'] },
    ])
    expect((await engine.prepareStep(input()))?.messages.map(
      message => (message.content[0] as { text: string }).text,
    )).toEqual(['successor'])
  })

  it('passes a contributor-local allowance and rejects a provider that exceeds it', async () => {
    const { engine } = await mountEngine({
      maxChars: 100,
      maxTokens: 100,
      maxContributorChars: 4,
      maxContributorTokens: 100,
      contributorTimeoutMs: 25,
    })
    let seenBudget: StepContextInput['budget'] | undefined
    engine.registerContributor({
      id: 'oversize',
      contribute(received) {
        seenBudget = received.budget
        return Promise.resolve(contributed('12345'))
      },
    })

    const prepared = await engine.prepareStep(input())

    expect(seenBudget).toMatchObject({ maxChars: 4, maxTokens: 100 })
    expect(seenBudget?.timeoutMs).toBeGreaterThan(0)
    expect(seenBudget?.timeoutMs).toBeLessThanOrEqual(25)
    expect(seenBudget?.deadlineAt).toBeGreaterThan(0)
    expect(prepared?.messages).toEqual([])
    expect(prepared?.decisions).toContainEqual(expect.objectContaining({
      contributorId: 'oversize', outcome: 'rejected', reasons: ['contributor_char_budget'],
    }))
  })

  it('deduplicates provider candidates after priority ranking', async () => {
    const { engine } = await mountEngine()
    engine.registerContributor(makeContributor('discovery', {
      ...contributed('ordinary rendering', [evidence]),
      selection: { priority: 'provider', reasons: ['semantic_match'], dedupeKey: 'resource:a' },
    }))
    engine.registerContributor(makeContributor('reference', {
      ...contributed('explicit rendering', [evidence]),
      selection: { priority: 'explicit-reference', reasons: ['direct_user_reference'], dedupeKey: 'resource:a' },
    }))

    const prepared = await engine.prepareStep(input())

    expect(prepared?.messages.map(message => (message.content[0] as { text: string }).text))
      .toEqual(['explicit rendering'])
    expect(prepared?.decisions).toEqual([
      expect.objectContaining({ contributorId: 'reference', outcome: 'selected' }),
      expect.objectContaining({ contributorId: 'discovery', outcome: 'rejected', reasons: ['duplicate'] }),
    ])
  })

  it('enforces the complete token budget independently of the character budget', async () => {
    const { engine } = await mountEngine({ maxChars: 100, maxTokens: 5, maxContributorTokens: 100 })
    engine.registerContributor(makeContributor('first', contributed('1')))
    engine.registerContributor(makeContributor('second', contributed('2')))

    const prepared = await engine.prepareStep(input())

    expect(prepared?.messages).toHaveLength(1)
    expect(prepared?.decisions).toContainEqual(expect.objectContaining({
      contributorId: 'second', outcome: 'rejected', reasons: ['total_token_budget'],
    }))
  })

  it('returns undefined with no contributors and when all contributors decline', async () => {
    const { engine } = await mountEngine()
    expect(await engine.prepareStep(input())).toBeUndefined()
    engine.registerContributor(makeContributor('a', undefined))
    engine.registerContributor(makeContributor('b', undefined))
    expect(await engine.prepareStep(input())).toBeUndefined()
  })

  it('passes the request through with provider-local controls and keeps registration order', async () => {
    const { engine } = await mountEngine()
    const a = makeContributor('a', contributed('from a'))
    const b = makeContributor('b', contributed('from b'))
    engine.registerContributor(a)
    engine.registerContributor(b)
    const step = input()
    const prepared = await engine.prepareStep(step)
    expect(prepared?.messages.map(message => (message.content[0] as { text: string }).text)).toEqual(['from a', 'from b'])
    expect(a.seen[0]?.messages).toBe(step.messages)
    expect(a.seen[0]?.caller).toBe(step.caller)
    expect(a.seen[0]?.signal).not.toBe(step.signal)
    expect(a.seen[0]?.budget).toMatchObject({ maxChars: 64_000, maxTokens: 16_000 })
    expect(a.seen[0]?.budget.timeoutMs).toBeGreaterThan(0)
    expect(a.seen[0]?.budget.timeoutMs).toBeLessThanOrEqual(5_000)
    expect(b.seen[0]?.budget).toMatchObject({ maxChars: 64_000, maxTokens: 16_000 })
    expect(b.seen[0]?.budget.timeoutMs).toBeGreaterThan(0)
    expect(b.seen[0]?.budget.timeoutMs).toBeLessThanOrEqual(5_000)
  })

  it('stops before later contributors and publishes nothing after cancellation', async () => {
    const { engine } = await mountEngine()
    const controller = new AbortController()
    let laterCalls = 0
    engine.registerContributor({
      id: 'canceller',
      async contribute() {
        controller.abort(new Error('cancelled during context retrieval'))
        return contributed('must not publish')
      },
    })
    engine.registerContributor({
      id: 'later',
      contribute() { laterCalls += 1; return Promise.resolve(contributed('later')) },
    })
    await expect(engine.prepareStep({ ...input(), signal: controller.signal }))
      .rejects.toThrow('cancelled during context retrieval')
    expect(laterCalls).toBe(0)
  })

  it('preserves contributor attribution and concatenates evidence and coverage', async () => {
    const { engine } = await mountEngine()
    const fromA = { ...contributed('from a', [evidence]), coverage }
    engine.registerContributor(makeContributor('a', fromA))
    engine.registerContributor(makeContributor('b', undefined))
    const prepared = await engine.prepareStep(input())
    expect(prepared?.evidence).toEqual([evidence])
    expect(prepared?.coverage).toEqual([coverage])
    expect(prepared?.contributions).toEqual([{
      contributorId: 'a',
      message: fromA.message,
      evidence: [evidence],
      coverage,
    }])
  })

  it('detaches and freezes provider-owned contribution data at the engine boundary', async () => {
    const { engine } = await mountEngine()
    const domain = { rank: 1 }
    const owned: ContributedStepContext = contributed('stable', [{
      ...evidence,
      domain,
    }])
    engine.registerContributor(makeContributor('owned', owned))

    const prepared = await engine.prepareStep(input())
    domain.rank = 99

    expect(prepared?.evidence[0]?.domain).toEqual({ rank: 1 })
    expect(Object.isFrozen(prepared)).toBe(true)
    expect(Object.isFrozen(prepared?.contributions)).toBe(true)
    expect(Object.isFrozen(prepared?.evidence[0]?.domain)).toBe(true)
  })

  it('rejects non-JSON contribution data and duplicate evidence ids before publication', async () => {
    const invalid = await mountEngine()
    invalid.engine.registerContributor(makeContributor('invalid', contributed('bad', [{
      ...evidence,
      domain: new Date() as never,
    }])))
    await expect(invalid.engine.prepareStep(input())).rejects.toMatchObject({
      code: 'CONTEXT_ENGINE_INVALID_CONTRIBUTION',
    })

    const duplicate = await mountEngine()
    duplicate.engine.registerContributor(makeContributor('a', contributed('a', [evidence])))
    duplicate.engine.registerContributor(makeContributor('b', contributed('b', [evidence])))
    await expect(duplicate.engine.prepareStep(input())).rejects.toMatchObject({
      code: 'CONTEXT_ENGINE_INVALID_CONTRIBUTION',
    })
  })
})

describe('bounded preparation execution', () => {
  it('caps concurrent reads and packs in registration order despite reverse completion', async () => {
    const { engine } = await mountEngine({ maxConcurrentContributors: 2 })
    const releases: (() => void)[] = []
    let active = 0
    let peak = 0
    for (const id of ['first', 'second', 'third']) engine.registerContributor({
      id,
      async contribute() {
        active += 1
        peak = Math.max(peak, active)
        await new Promise<void>((resolve) => { releases.push(resolve) })
        active -= 1
        return contributed(id)
      },
    })
    const pending = engine.prepareStep(input())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(releases).toHaveLength(2)
    releases[1]!()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(releases).toHaveLength(3)
    releases[2]!()
    releases[0]!()
    const prepared = await pending
    expect(peak).toBe(2)
    expect(prepared?.contributions.map(value => value.contributorId)).toEqual(['first', 'second', 'third'])
  })

  it('expires the whole preparation including queued reads and ignores late rejection', async () => {
    const { engine } = await mountEngine({ maxConcurrentContributors: 1, prepareTimeoutMs: 10, contributorTimeoutMs: 1000 })
    let rejectLate!: (error: Error) => void
    let signal!: AbortSignal
    let queuedCalls = 0
    engine.registerContributor({ id: 'slow', contribute(received) {
      signal = received.signal
      return new Promise((_resolve, reject) => { rejectLate = reject })
    } })
    engine.registerContributor({ id: 'queued', async contribute() { queuedCalls += 1; return contributed('queued') } })
    const prepared = await engine.prepareStep(input())
    expect(queuedCalls).toBe(0)
    expect(signal.aborted).toBe(true)
    expect(prepared?.decisions).toEqual(['slow', 'queued'].map(contributorId => ({ contributorId, outcome: 'rejected', reasons: ['deadline'] })))
    rejectLate(new Error('late secret'))
    await Promise.resolve()
    expect(prepared?.messages).toEqual([])
  })

  it('disposal immediately aborts an uncooperative generation and releases the slot', async () => {
    const { engine } = await mountEngine({ maxConcurrentContributors: 1 })
    let signal!: AbortSignal
    const dispose = engine.registerContributor({ id: 'old', contribute(received) {
      signal = received.signal
      return new Promise(() => {})
    } })
    engine.registerContributor(makeContributor('next', contributed('next')))
    const pending = engine.prepareStep(input())
    await Promise.resolve()
    dispose()
    const prepared = await pending
    expect(signal.aborted).toBe(true)
    expect(prepared?.contributions.map(value => value.contributorId)).toEqual(['next'])
    expect(prepared?.decisions[0]?.reasons).toEqual(['disposed'])
  })

  it('engine unload rejects pending preparation and never starts queued providers', async () => {
    const { ctx, engine } = await mountEngine({ maxConcurrentContributors: 1 })
    let calls = 0
    engine.registerContributor({ id: 'slow', contribute: () => new Promise(() => {}) })
    engine.registerContributor({ id: 'queued', async contribute() { calls += 1; return undefined } })
    const pending = engine.prepareStep(input())
    const rejected = expect(pending).rejects.toThrow('context engine disposed')
    await Promise.resolve()
    await ctx.fiber.dispose()
    await rejected
    expect(calls).toBe(0)
  })

  it('records unknown provider failures with a stable code and no raw error text', async () => {
    const { engine } = await mountEngine()
    engine.registerContributor({ id: 'broken', async contribute() { throw new Error('private user query') } })
    const prepared = await engine.prepareStep(input())
    expect(prepared?.decisions).toEqual([{ contributorId: 'broken', outcome: 'rejected', reasons: ['error', 'provider_failed'] }])
    expect(JSON.stringify(prepared)).not.toContain('private user query')
  })
})


describe('preparation cancellation and explicit rejection', () => {
  it('parent cancellation aborts active reads without starting queued providers', async () => {
    const { engine } = await mountEngine({ maxConcurrentContributors: 1 })
    const controller = new AbortController()
    let local!: AbortSignal
    let calls = 0
    engine.registerContributor({ id: 'active', contribute(received) {
      local = received.signal
      return new Promise(() => {})
    } })
    engine.registerContributor({ id: 'queued', async contribute() { calls += 1; return undefined } })
    const preparing = engine.prepareStep({ ...input(), signal: controller.signal })
    await Promise.resolve()
    controller.abort(new Error('parent cancelled'))
    await expect(preparing).rejects.toThrow('parent cancelled')
    expect(local.aborted).toBe(true)
    expect(calls).toBe(0)
  })

  it('retains an explicit decline as trace rather than losing it or calling it timeout', async () => {
    const { engine } = await mountEngine()
    engine.registerContributor({ id: 'bounded', async contribute() {
      throw new ContextProviderError('declined', 'budget_exhausted')
    } })
    expect((await engine.prepareStep(input()))?.decisions).toEqual([
      { contributorId: 'bounded', outcome: 'rejected', reasons: ['declined', 'budget_exhausted'] },
    ])
  })

  it('never starts a registration removed while waiting for a provider slot', async () => {
    const { engine } = await mountEngine({ maxConcurrentContributors: 1 })
    let release!: () => void
    let calls = 0
    engine.registerContributor({ id: 'first', async contribute() {
      await new Promise<void>((resolve) => { release = resolve })
      return contributed('first')
    } })
    const dispose = engine.registerContributor({ id: 'queued', async contribute() { calls += 1; return undefined } })
    const preparing = engine.prepareStep(input())
    await Promise.resolve()
    dispose()
    release()
    const prepared = await preparing
    expect(calls).toBe(0)
    expect(prepared?.decisions).toContainEqual({ contributorId: 'queued', outcome: 'rejected', reasons: ['disposed'] })
  })

  it('detaches a completed provider result before another provider mutates its retained value', async () => {
    const { engine } = await mountEngine({ maxConcurrentContributors: 1 })
    const retained = { ...contributed('first'), evidence: [] as Evidence[] }
    engine.registerContributor(makeContributor('first', retained))
    engine.registerContributor({ id: 'second', async contribute() { retained.evidence.push(evidence); return undefined } })
    expect((await engine.prepareStep(input()))?.evidence).toEqual([])
  })
})

it('rejects a completed candidate whose registration is disposed while another provider is pending', async () => {
  const { engine } = await mountEngine({ maxConcurrentContributors: 2 })
  const dispose = engine.registerContributor(makeContributor('completed', contributed('stale')))
  let release!: () => void
  engine.registerContributor({ id: 'pending', async contribute() {
    await new Promise<void>((resolve) => { release = resolve })
    return contributed('current')
  } })
  const preparing = engine.prepareStep(input())
  await new Promise(resolve => setTimeout(resolve, 0))
  dispose()
  release()
  const prepared = await preparing
  expect(prepared?.contributions.map(value => value.contributorId)).toEqual(['pending'])
  expect(prepared?.decisions).toContainEqual({ contributorId: 'completed', outcome: 'rejected', reasons: ['disposed'] })
})
