import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import Loader from '@relay-harness/cordis-plugin-loader'
import Include from '@relay-harness/cordis-plugin-include'
import AgentRegistry from '@relay-harness/rlh-agent'
import AgentLoop from '@relay-harness/rlh-agent-loop'
import LlmRuntime, { createUserMessage } from '@relay-harness/rlh-llm'
import SessionStore, { SessionId } from '@relay-harness/rlh-session'
import SystemPrompt from '@relay-harness/rlh-system-prompt'
import ToolRuntime from '@relay-harness/rlh-tools'
import * as RolloutBudget from '../src/index.ts'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'rlh-rollout-budget-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@relay-harness/rlh-llm', LlmRuntime],
    ['@relay-harness/rlh-session', SessionStore],
    ['@relay-harness/rlh-system-prompt', SystemPrompt],
    ['@relay-harness/rlh-tools', ToolRuntime],
    ['@relay-harness/rlh-agent', AgentRegistry],
    ['@relay-harness/rlh-agent-loop', AgentLoop],
    ['@relay-harness/rlh-rollout-budget-controller', RolloutBudget],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  it('loads the opt-in guard and commits its model-visible threshold reminder', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml([
      "- name: '@relay-harness/rlh-llm'",
      "- name: '@relay-harness/rlh-session'",
      "- name: '@relay-harness/rlh-system-prompt'",
      "- name: '@relay-harness/rlh-tools'",
      "- name: '@relay-harness/rlh-agent'",
      "- name: '@relay-harness/rlh-agent-loop'",
      '  config:',
      '    agents: []',
      "- name: '@relay-harness/rlh-rollout-budget-controller'",
      '  config:',
      '    limitTokens: 100',
      '    reminderAtRemainingTokens: [50]',
    ])
    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])

    const adapter = new MockAdapter([
      textResponse('x'.repeat(40)),
      textResponse('done'),
    ])
    loaded.llm.registerAdapter(['mock'], adapter)
    const agent = loaded.agentLoop.create(SessionId('loader-rollout-budget'), {
      provider: 'mock',
      model: 'mock',
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'finish' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(2)
    const reminder = agent.session.events.find(event => event.type === 'user/message'
      && event.data.source.kind === 'plugin'
      && event.data.source.plugin === 'rollout-budget-controller')
    expect(reminder?.type).toBe('user/message')
    if (reminder?.type !== 'user/message') throw new Error('expected the rollout reminder event')
    expect(reminder.data.source).toEqual({
      kind: 'plugin',
      plugin: 'rollout-budget-controller',
      form: 'notice',
      summary: 'rollout budget reminder 1',
    })
  })
})
