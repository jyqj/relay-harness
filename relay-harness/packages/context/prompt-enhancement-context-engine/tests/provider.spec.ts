/** Context Engine preparation delegation, trace projection, and missing-scope failure. */

import { Context } from '@relay-harness/cordis'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@relay-harness/rlh-agent'
import { createUserMessage } from '@relay-harness/rlh-llm'
import type { ContextPrepareInput } from '@relay-harness/rlh-context-engine'
import type { PromptEnhancementContextProvider } from '@relay-harness/rlh-prompt-enhancement'
import * as plugin from '../src/index.ts'

function providerFrom(contextEngine: unknown) {
  let registered: PromptEnhancementContextProvider | undefined
  const ctx = new Context()
  ctx.provide('promptEnhancement', {
    registerContextProvider(provider: PromptEnhancementContextProvider) {
      registered = provider
      return ctx.effect(() => () => {}, 'test context provider')
    },
  })
  ctx.provide('contextEngine', contextEngine)
  return { ctx, registered: () => registered }
}

describe('prompt-enhancement-context-engine', () => {
  it('runs the Agent-scoped engine once and projects its existing Evidence into an opaque trace', async () => {
    const message = createUserMessage({
      source: { kind: 'plugin', plugin: 'code-context' },
      content: [{ type: 'text', text: 'verified snippet' }],
    })
    const prepareStep = vi.fn((_input: ContextPrepareInput) => Promise.resolve({
      plan: {
        purpose: 'prompt_enhancement' as const,
        budget: { maxChars: 100, maxTokens: 100 },
        contributors: [],
      },
      decisions: [],
      messages: [message],
      evidence: [],
      coverage: [],
      contributions: [{
        contributorId: 'code-context',
        message,
        evidence: [{
          evidenceId: 'ev-1',
          resource: { sourceId: 'code', key: 'src/a.ts', revision: 'sha256:x' },
          digest: 'sha256:y',
          truncated: false,
          freshness: 'current',
          verification: 'verified',
          domain: { parserTier: 'tree-sitter' },
        }],
        coverage: { searched: ['src/**'], notSearched: ['vendor/**'], completeness: 'bounded' },
      }],
    }))
    const b = providerFrom({ prepareStep })
    const fiber = b.ctx.plugin(plugin)
    await fiber.await()
    const agentCtx = b.ctx.extend()
    const agent = {
      id: 'agent-1',
      ctx: agentCtx,
      session: { id: 'session-1', header: { cwd: '/workspace', origin: 'subagent' }, events: [] },
    } as unknown as Agent
    const signal = new AbortController().signal

    const result = await b.registered()!.prepare({
      purpose: 'prompt_enhancement', agent, draft: 'fix the parser', signal,
    })

    expect(prepareStep).toHaveBeenCalledWith(expect.objectContaining({
      purpose: 'prompt_enhancement', cwd: '/workspace', signal,
      caller: {
        sessionId: 'session-1', agentId: 'agent-1', workspaceId: '/workspace', origin: 'subagent',
      },
    }))
    const input = prepareStep.mock.calls[0]![0]
    expect(input.messages[0]?.source).toEqual({ kind: 'user' })
    expect(input.messages[0]?.content[0]).toEqual({ type: 'text', text: 'fix the parser' })
    expect(result.messages).toEqual([message])
    expect(result.trace).toEqual({
      purpose: 'prompt_enhancement',
      plan: {
        purpose: 'prompt_enhancement',
        budget: { maxChars: 100, maxTokens: 100 },
        contributors: [],
      },
      decisions: [],
      contributions: [{
        contributorId: 'code-context',
        messageId: message.id,
        evidence: [{
          evidenceId: 'ev-1',
          resource: { sourceId: 'code', key: 'src/a.ts', revision: 'sha256:x' },
          digest: 'sha256:y',
          truncated: false,
          freshness: 'current',
          verification: 'verified',
          domain: { parserTier: 'tree-sitter' },
        }],
        coverage: { searched: ['src/**'], notSearched: ['vendor/**'], completeness: 'bounded' },
      }],
    })
  })

  it('fails loud when the target Agent scope has no Context Engine', async () => {
    const b = providerFrom({ prepareStep: vi.fn() })
    await b.ctx.plugin(plugin)
    const agent = {
      id: 'agent-1', ctx: new Context(), session: { id: 'session-1', header: {}, events: [] },
    } as unknown as Agent
    await expect(b.registered()!.prepare({
      purpose: 'prompt_enhancement', agent, draft: 'draft', signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'PROMPT_ENHANCEMENT_CONTEXT_ENGINE_UNAVAILABLE' })
  })

  it('rejects a structurally supplied non-JSON trace before crossing the Remote boundary', async () => {
    const message = createUserMessage({
      source: { kind: 'plugin', plugin: 'bad-context' },
      content: [{ type: 'text', text: 'bad' }],
    })
    const prepareStep = vi.fn(() => Promise.resolve({
      plan: {
        purpose: 'prompt_enhancement' as const,
        budget: { maxChars: 100, maxTokens: 100 },
        contributors: [],
      },
      decisions: [],
      messages: [message],
      evidence: [],
      coverage: [],
      contributions: [{
        contributorId: 'bad-context',
        message,
        evidence: [{
          evidenceId: 'bad',
          resource: { sourceId: 'bad', key: 'bad' },
          truncated: false,
          freshness: 'unknown',
          verification: 'unverified',
          domain: new Map([['not', 'json']]),
        }],
      }],
    }))
    const b = providerFrom({ prepareStep })
    await b.ctx.plugin(plugin)
    const agent = {
      id: 'agent-1', ctx: b.ctx, session: { id: 'session-1', header: {}, events: [] },
    } as unknown as Agent

    await expect(b.registered()!.prepare({
      purpose: 'prompt_enhancement', agent, draft: 'draft', signal: new AbortController().signal,
    })).rejects.toMatchObject({ code: 'PROMPT_ENHANCEMENT_CONTEXT_TRACE_INVALID' })
  })
})
