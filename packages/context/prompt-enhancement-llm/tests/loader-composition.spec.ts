/** Real Loader composition of the Host Prompt Enhancement path. */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@relay-harness/cordis'
import Include from '@relay-harness/cordis-plugin-include'
import Loader from '@relay-harness/cordis-plugin-loader'
import { afterEach, describe, expect, it } from 'vitest'
import type { Agent } from '@relay-harness/rlh-agent'
import ContextEngine from '@relay-harness/rlh-context-engine'
import LlmRuntime, { LlmAdapter } from '@relay-harness/rlh-llm'
import type { GenerateOptions, StreamChunk } from '@relay-harness/rlh-llm'
import PromptEnhancementService from '@relay-harness/rlh-prompt-enhancement'
import * as ContextAdapter from '@relay-harness/rlh-prompt-enhancement-context-engine'
import SessionStore, { SessionId } from '@relay-harness/rlh-session'
import * as ProviderPlugin from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

class LoaderAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield {
      type: 'text-delta',
      index: 0,
      text: JSON.stringify({ enhancedDraft: 'Do the task and run focused tests.', assumptions: [], openQuestions: [] }),
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function loadComposition(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'rlh-prompt-enhancement-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@relay-harness/rlh-llm'",
    "- name: '@relay-harness/rlh-session'",
    "- name: '@relay-harness/rlh-context-engine'",
    "- name: '@relay-harness/rlh-prompt-enhancement'",
    "- name: '@relay-harness/rlh-prompt-enhancement-context-engine'",
    "- name: '@relay-harness/rlh-prompt-enhancement-llm'",
    '  config:',
    "    provider: 'enhance-route'",
    "    model: 'enhance-model'",
    '    maxInputBytes: 131072',
    '    maxOutputTokens: 512',
    '    timeoutMs: 1000',
    '    maxDraftChars: 32000',
    '    maxListItems: 20',
    '    maxItemChars: 2000',
    '',
  ].join('\n'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@relay-harness/rlh-llm', LlmRuntime],
    ['@relay-harness/rlh-session', SessionStore],
    ['@relay-harness/rlh-context-engine', ContextEngine],
    ['@relay-harness/rlh-prompt-enhancement', PromptEnhancementService],
    ['@relay-harness/rlh-prompt-enhancement-context-engine', ContextAdapter],
    ['@relay-harness/rlh-prompt-enhancement-llm', ProviderPlugin],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

describe('Prompt Enhancement Loader composition', () => {
  it('loads the complete Host path and dispatches a no-tools auxiliary call', async () => {
    const ctx = await loadComposition()
    expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    const adapter = new LoaderAdapter()
    ctx.llm.registerAdapter(['enhance-route'], adapter)
    const session = ctx.sessions.create(SessionId('loader-prompt-enhancement'), { meta: { cwd: '/tmp' } })
    const agent = {
      id: session.id,
      session,
      options: { provider: 'main', model: 'main-model' },
      ctx,
    } as unknown as Agent

    await expect(ctx.promptEnhancement.enhance(agent, 'do the task', new AbortController().signal))
      .resolves.toMatchObject({
        kind: 'enhanced',
        result: {
          originalDraft: 'do the task',
          enhancedDraft: 'Do the task and run focused tests.',
          contextTrace: { purpose: 'prompt_enhancement', contributions: [] },
        },
      })
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject({ purpose: 'prompt-enhancement' })
    expect(adapter.requests[0]).not.toHaveProperty('tools')
  })
})
