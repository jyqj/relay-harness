/** Prompt Enhancement dispatch, preservation, context delegation, and provider lifecycle. */

import { Context } from '@relay-harness/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@relay-harness/rlh-agent'
import { createUserMessage } from '@relay-harness/rlh-llm'
import SessionStore, { SessionId } from '@relay-harness/rlh-session'
import PromptEnhancementService, {
  PROMPT_ENHANCEMENT_CONTEXT_PURPOSE,
  PromptEnhancementError,
  type Config,
  type PromptEnhancementContextProvider,
  type PromptEnhancementProvider,
} from '../src/index.ts'

async function bench(config: Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(PromptEnhancementService, config)
  const session = ctx.sessions.create(SessionId('enhance-session'), { meta: { cwd: '/workspace' } })
  const agent = {
    id: session.id,
    session,
    options: { provider: 'route', model: 'model' },
    ctx,
  } as unknown as Agent
  return { ctx, agent, service: ctx.promptEnhancement }
}

function contextProvider(overrides: Partial<PromptEnhancementContextProvider> = {}): PromptEnhancementContextProvider {
  return {
    id: 'shared-context',
    prepare: request => Promise.resolve({
      messages: [createUserMessage({
        source: { kind: 'plugin', plugin: 'context-engine-adapter' },
        content: [{ type: 'text', text: `context for ${request.draft}` }],
      })],
      trace: { requestId: 'ctx-1', selected: 1 },
    }),
    ...overrides,
  }
}

function provider(overrides: Partial<PromptEnhancementProvider> = {}): PromptEnhancementProvider {
  return {
    id: 'structured-provider',
    enhance: () => Promise.resolve({
      enhancedDraft: 'Clarified task with verification',
      assumptions: ['Tests are available'],
      openQuestions: ['Which target platform?'],
      model: { provider: 'route', model: 'model' },
    }),
    ...overrides,
  }
}

describe('PromptEnhancementService', () => {
  it('delegates the fixed purpose to one context provider and returns a detached structured proposal', async () => {
    const { agent, service } = await bench()
    const prepare = vi.fn(contextProvider().prepare)
    const enhance = vi.fn(provider().enhance)
    service.registerContextProvider(contextProvider({ prepare }))
    service.registerProvider(provider({ enhance }))
    const signal = new AbortController().signal

    const outcome = await service.enhance(agent, 'original task', signal)

    const preparedInput = prepare.mock.calls[0]![0]
    expect(preparedInput.purpose).toBe(PROMPT_ENHANCEMENT_CONTEXT_PURPOSE)
    expect(preparedInput.agent).toBe(agent)
    expect(preparedInput.draft).toBe('original task')
    expect(preparedInput.signal).toBeInstanceOf(AbortSignal)
    const enhancementInput = enhance.mock.calls[0]![0]
    expect(enhancementInput.agent).toBe(agent)
    expect(enhancementInput.draft).toBe('original task')
    expect(enhancementInput.context.trace).toEqual({ requestId: 'ctx-1', selected: 1 })
    expect(enhancementInput.signal).toBeInstanceOf(AbortSignal)
    expect(outcome).toEqual({
      kind: 'enhanced',
      result: {
        originalDraft: 'original task',
        enhancedDraft: 'Clarified task with verification',
        assumptions: ['Tests are available'],
        openQuestions: ['Which target platform?'],
        model: { provider: 'route', model: 'model' },
        contextTrace: { requestId: 'ctx-1', selected: 1 },
      },
    })
    expect(Object.isFrozen(outcome)).toBe(true)
    expect(Object.isFrozen(outcome.kind === 'enhanced' ? outcome.result.contextTrace : undefined)).toBe(true)
  })

  it('fails loud when either capability provider is absent and retains the exact draft', async () => {
    const { agent, service } = await bench()
    const absentProvider = await service.enhance(agent, '  exact draft  ', new AbortController().signal)
    expect(absentProvider.kind).toBe('preserved')
    if (absentProvider.kind !== 'preserved') throw new Error('expected preserved outcome')
    expect(absentProvider).toMatchObject({ reason: 'failed', originalDraft: '  exact draft  ' })
    expect(absentProvider.failure?.code).toBe('PROMPT_ENHANCEMENT_PROVIDER_UNAVAILABLE')
    service.registerProvider(provider())
    const absentContext = await service.enhance(agent, 'draft', new AbortController().signal)
    expect(absentContext.kind).toBe('preserved')
    if (absentContext.kind !== 'preserved') throw new Error('expected preserved outcome')
    expect(absentContext).toMatchObject({ reason: 'failed', originalDraft: 'draft' })
    expect(absentContext.failure?.code).toBe('PROMPT_ENHANCEMENT_CONTEXT_PROVIDER_UNAVAILABLE')
  })

  it('preserves empty drafts and provider failures without invoking a draft mutation path', async () => {
    const { agent, service } = await bench()
    const enhance = vi.fn(() => Promise.reject(new PromptEnhancementError('model unavailable', 'NO_ROUTE')))
    service.registerContextProvider(contextProvider())
    service.registerProvider(provider({ enhance }))

    const empty = await service.enhance(agent, ' \n ', new AbortController().signal)
    expect(empty.kind).toBe('preserved')
    if (empty.kind !== 'preserved') throw new Error('expected preserved outcome')
    expect(empty).toMatchObject({ reason: 'failed', originalDraft: ' \n ' })
    expect(empty.failure?.code).toBe('PROMPT_ENHANCEMENT_DRAFT_EMPTY')
    expect(enhance).not.toHaveBeenCalled()
    await expect(service.enhance(agent, 'keep this', new AbortController().signal)).resolves.toEqual({
      kind: 'preserved',
      reason: 'failed',
      originalDraft: 'keep this',
      failure: { code: 'NO_ROUTE', message: 'model unavailable' },
    })
  })

  it('admits cancellation before composition and bounds the exact draft before either provider runs', async () => {
    const { agent, service } = await bench({ maxDraftBytes: 4 })
    const prepare = vi.fn(contextProvider().prepare)
    const enhance = vi.fn(provider().enhance)
    service.registerContextProvider(contextProvider({ prepare }))
    service.registerProvider(provider({ enhance }))
    const cancelled = new AbortController()
    cancelled.abort(new Error('cancelled before Remote dispatch'))

    await expect(service.enhance(agent, 'valid', cancelled.signal)).resolves.toEqual({
      kind: 'preserved', reason: 'cancelled', originalDraft: 'valid',
    })
    const oversized = await service.enhance(agent, 'ééé', new AbortController().signal)
    expect(oversized).toMatchObject({
      kind: 'preserved', reason: 'failed', originalDraft: 'ééé',
      failure: { code: 'PROMPT_ENHANCEMENT_DRAFT_TOO_LARGE' },
    })
    expect(prepare).not.toHaveBeenCalled()
    expect(enhance).not.toHaveBeenCalled()
  })

  it('contains arbitrary provider errors and invalid or oversized provider results', async () => {
    const leaked = await bench()
    leaked.service.registerContextProvider(contextProvider())
    leaked.service.registerProvider(provider({
      enhance: () => Promise.reject(new Error('api_key=secret-value')),
    }))
    await expect(leaked.service.enhance(leaked.agent, 'draft', new AbortController().signal)).resolves.toEqual({
      kind: 'preserved',
      reason: 'failed',
      originalDraft: 'draft',
      failure: { code: 'PROMPT_ENHANCEMENT_FAILED', message: 'Prompt Enhancement failed' },
    })

    const invalid = await bench()
    invalid.service.registerContextProvider(contextProvider())
    invalid.service.registerProvider(provider({
      enhance: () => Promise.resolve({
        enhancedDraft: '', assumptions: [], openQuestions: [],
        model: { provider: 'p', model: 'm' },
      }),
    }))
    await expect(invalid.service.enhance(invalid.agent, 'draft', new AbortController().signal))
      .resolves.toMatchObject({
        kind: 'preserved',
        reason: 'failed',
        originalDraft: 'draft',
        failure: { code: 'PROMPT_ENHANCEMENT_RESULT_INVALID' },
      })

    const oversized = await bench({ maxResultBytes: 20 })
    oversized.service.registerContextProvider(contextProvider())
    oversized.service.registerProvider(provider())
    await expect(oversized.service.enhance(oversized.agent, 'draft', new AbortController().signal))
      .resolves.toMatchObject({
        kind: 'preserved',
        reason: 'failed',
        originalDraft: 'draft',
        failure: { code: 'PROMPT_ENHANCEMENT_RESULT_TOO_LARGE' },
      })

    const oversizedTrace = await bench({ maxResultBytes: 200 })
    const traceEnhance = vi.fn(provider().enhance)
    oversizedTrace.service.registerContextProvider(contextProvider({
      prepare: () => Promise.resolve({ messages: [], trace: { value: 'x'.repeat(500) } }),
    }))
    oversizedTrace.service.registerProvider(provider({ enhance: traceEnhance }))
    await expect(oversizedTrace.service.enhance(
      oversizedTrace.agent,
      'draft',
      new AbortController().signal,
    )).resolves.toMatchObject({
      kind: 'preserved',
      reason: 'failed',
      originalDraft: 'draft',
      failure: { code: 'PROMPT_ENHANCEMENT_RESULT_TOO_LARGE' },
    })
    expect(traceEnhance).not.toHaveBeenCalled()
  })

  it('returns cancellation with the original draft and drains an ignoring provider on disposal', async () => {
    const { agent, service } = await bench()
    service.registerContextProvider(contextProvider())
    let settle!: () => void
    const providerDone = new Promise<void>((resolve) => { settle = resolve })
    const disposeProvider = service.registerProvider(provider({
      enhance: async () => {
        await providerDone
        return {
          enhancedDraft: 'late', assumptions: [], openQuestions: [],
          model: { provider: 'route', model: 'model' },
        }
      },
    }))
    const operation = service.enhance(agent, 'do not lose me', new AbortController().signal)
    await Promise.resolve()
    let disposed = false
    const disposal = disposeProvider().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    settle()
    await disposal
    await expect(operation).resolves.toEqual({
      kind: 'preserved', reason: 'cancelled', originalDraft: 'do not lose me',
    })
  })

  it('rejects duplicate registrations and frees each role after disposal', async () => {
    const { service } = await bench()
    const disposeContext = service.registerContextProvider(contextProvider())
    const disposeProvider = service.registerProvider(provider())
    expect(() => service.registerContextProvider(contextProvider({ id: 'other-context' }))).toThrow(/already registered/)
    expect(() => service.registerProvider(provider({ id: 'other-provider' }))).toThrow(/already registered/)
    await disposeContext()
    await disposeProvider()
    expect(() => service.registerContextProvider(contextProvider({ id: 'replacement-context' }))).not.toThrow()
    expect(() => service.registerProvider(provider({ id: 'replacement-provider' }))).not.toThrow()
  })

  it('rejects blank registration identities and drains an ignoring context provider on disposal', async () => {
    const { agent, service } = await bench()
    expect(() => service.registerProvider(provider({ id: '  ' }))).toThrow(/non-empty/)
    expect(() => service.registerContextProvider(contextProvider({ id: '' }))).toThrow(/non-empty/)
    service.registerProvider(provider())
    let settle!: () => void
    const prepared = new Promise<void>((resolve) => { settle = resolve })
    const disposeContext = service.registerContextProvider(contextProvider({
      prepare: async () => {
        await prepared
        return { messages: [] }
      },
    }))
    const operation = service.enhance(agent, 'draft', new AbortController().signal)
    await Promise.resolve()
    let disposed = false
    const disposal = disposeContext().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    settle()
    await disposal
    await expect(operation).resolves.toEqual({
      kind: 'preserved', reason: 'cancelled', originalDraft: 'draft',
    })
  })
})
