import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { createUserMessage } from '@relay-harness/rlh-llm'
import { SessionId } from '@relay-harness/rlh-session'
import ContextEngine, {
  ContextEngineError,
  EvidenceId,
  SourceId,
  type ContributedStepContext,
  type CoverageRecord,
  type Evidence,
  type StepContextContributor,
  type StepContextInput,
} from '@relay-harness/rlh-context-engine'

/** Mount a ContextEngine service on a fresh root context. */
async function mountEngine(): Promise<{ ctx: Context; engine: ContextEngine }> {
  const ctx = new Context()
  await ctx.plugin(ContextEngine)
  return { ctx, engine: ctx.contextEngine as ContextEngine }
}

function input(): StepContextInput {
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
  it('returns undefined with no contributors and when all contributors decline', async () => {
    const { engine } = await mountEngine()
    expect(await engine.prepareStep(input())).toBeUndefined()
    engine.registerContributor(makeContributor('a', undefined))
    engine.registerContributor(makeContributor('b', undefined))
    expect(await engine.prepareStep(input())).toBeUndefined()
  })

  it('passes one input through to every contributor and keeps registration order', async () => {
    const { engine } = await mountEngine()
    const a = makeContributor('a', contributed('from a'))
    const b = makeContributor('b', contributed('from b'))
    engine.registerContributor(a)
    engine.registerContributor(b)
    const step = input()
    const prepared = await engine.prepareStep(step)
    expect(prepared?.messages.map(message => (message.content[0] as { text: string }).text)).toEqual(['from a', 'from b'])
    expect(a.seen[0]).toBe(step)
    expect(b.seen[0]).toBe(step)
    expect(a.seen[0]?.messages).toBe(step.messages)
    expect(a.seen[0]?.signal).toBe(step.signal)
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
