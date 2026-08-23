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
import * as CircuitBreaker from '../src/index.ts'
import { ScriptAdapter } from './support.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

describe('real Loader composition', () => {
  it('loads YAML and sheds the third failing-provider request before transport', { timeout: 60_000 }, async () => {
    root = await mkdtemp(join(tmpdir(), 'rlh-circuit-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@relay-harness/rlh-llm'",
      "- name: '@relay-harness/rlh-session'",
      "- name: '@relay-harness/rlh-system-prompt'",
      "- name: '@relay-harness/rlh-tools'",
      "- name: '@relay-harness/rlh-agent'",
      "- name: '@relay-harness/rlh-agent-loop'",
      '  config:',
      '    agents: []',
      "- name: '@relay-harness/rlh-llm-circuit-breaker'",
      '  config:',
      '    minSamples: 2',
      '    errorRateThreshold: 1',
      '',
    ].join('\n'))

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
      ['@relay-harness/rlh-llm-circuit-breaker', CircuitBreaker],
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

    const adapter = new ScriptAdapter(['server', 'server'])
    context.llm.registerAdapter(['p'], adapter)
    const agent = context.agentLoop.create(SessionId('loader-circuit'), { provider: 'p', model: 'm' })
    for (let index = 0; index < 3; index += 1) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
      await agent.whenIdle()
    }
    expect(adapter.calls).toBe(2)
    expect(agent.session.events.findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'error', error: { code: 'CIRCUIT_OPEN' } } } })
  })
})
