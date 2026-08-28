import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { createUserMessage } from '@relay-harness/rlh-llm'
import ContextEngine, {
  ContextEngineError,
  EvidenceId,
  SourceId,
  type ContributedStepContext,
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
    messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] })],
    signal: new AbortController().signal,
    cwd: '/ws',
  }
}

function contributed(text: string, evidence?: readonly Evidence[]): ContributedStepContext {
  return {
    message: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }),
    ...evidence === undefined ? {} : { evidence },
  }
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

  it('concatenates evidence from contributing contributors only', async () => {
    const { engine } = await mountEngine()
    engine.registerContributor(makeContributor('a', contributed('from a', [evidence])))
    engine.registerContributor(makeContributor('b', undefined))
    const prepared = await engine.prepareStep(input())
    expect(prepared?.evidence).toEqual([evidence])
  })
})
