/**
 * REAL-composition boot of the shipped `cordis.patch.yml`: the seven patch
 * entries (tracker, tracker-linear, workflow, workspace, runner, orchestrator,
 * UI host half) load together through the real Loader over a base profile of
 * real source-plane services. Only the external boundaries are stubbed: the
 * Linear network is never contacted (a memory tracker owns scheduling reads
 * and tracker-linear merely registers), and the default model route is fixed.
 */

import { readFile } from 'node:fs/promises'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include, { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import * as yaml from 'js-yaml'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentDefaultModel from '@deepseek-ai/dsh-agent-default-model'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TrackerRegistry, { type TrackerProvider } from '@deepseek-ai/dsh-tracker'
import * as TrackerLinear from '@deepseek-ai/dsh-tracker-linear'
import FileIssueWorkflow from '@deepseek-ai/dsh-issue-workflow-file'
import LocalIssueWorkspaceProvisioner from '@deepseek-ai/dsh-issue-workspace-local'
import AgentIssueRunner from '@deepseek-ai/dsh-issue-runner-agent'
import DurableIssueOrchestrator from '@deepseek-ai/dsh-issue-orchestrator'
// The UI package's Node half is a no-op `apply()` under the Client aggregate
// (the host aggregate excludes packages/client/*/src), so an identical inline
// no-op stands in here; the real client half is covered by the package's
// client-face tests.
const UiIssueOrchestration = { apply(): void {} }

/** In-memory scheduling provider standing in for the Linear network. */
const memoryTracker: TrackerProvider = {
  name: 'memory',
  fetchIssuesByStates: () => Promise.resolve([]),
  fetchIssuesByIds: () => Promise.resolve([]),
  bindTools: () => ({
    provider: 'memory',
    tools: [],
    secretEnvironmentNames: [],
    execute: async () => ({ success: false, value: null }),
  }),
}

const memoryTrackerPlugin = {
  name: 'memory-tracker',
  inject: ['trackers'],
  apply: (ctx: Context): void => {
    ctx.effect(() => ctx.trackers.register(memoryTracker), 'memory-tracker: registration')
  },
}

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  vi.unstubAllEnvs()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const workflow = `---
tracker:
  provider: memory
  active_states: [Todo]
  terminal_states: [Done]
  required_labels: [agent]
polling:
  interval_ms: 50
agent:
  max_concurrent_runs: 1
  max_turns: 2
orchestration:
  continuation_retry_ms: 10
  max_continuation_attempts: 5
---
Work {{ issue.identifier }}.
`

async function bootPatch(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-issue-automation-'))
  const workflowPath = join(root, 'WORKFLOW.md')
  await writeFile(workflowPath, workflow)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-storage'",
    "- name: '@deepseek-ai/dsh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'storage'))}`,
    "- name: '@deepseek-ai/dsh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-agent-default-model'",
    '  config:',
    '    provider: stub-provider',
    '    model: stub-model',
    "- name: '@deepseek-ai/dsh-subprocess-local'",
    '- name: memory-tracker-stub',
    '',
  ].join('\n'))
  vi.stubEnv('DSH_ISSUE_WORKFLOW', workflowPath)
  vi.stubEnv('DSH_LINEAR_PROJECT_SLUG', 'composition-fixture')
  vi.stubEnv('LINEAR_API_KEY', 'composition-stub-key')
  vi.stubEnv('DSH_ISSUE_WORKSPACE_ROOT', join(root, 'workspaces'))

  const patchText = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const patches = yaml.load(patchText, { schema: entryListSchema }) as unknown[]

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-storage', Storage],
    ['@deepseek-ai/dsh-storage-json', StorageJson],
    ['@deepseek-ai/dsh-storage-domain', StorageDomain],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-default-model', AgentDefaultModel],
    ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessRuntime],
    ['memory-tracker-stub', memoryTrackerPlugin],
    ['@deepseek-ai/dsh-tracker', TrackerRegistry],
    ['@deepseek-ai/dsh-tracker-linear', TrackerLinear],
    ['@deepseek-ai/dsh-issue-workflow-file', FileIssueWorkflow],
    ['@deepseek-ai/dsh-issue-workspace-local', LocalIssueWorkspaceProvisioner],
    ['@deepseek-ai/dsh-issue-runner-agent', AgentIssueRunner],
    ['@deepseek-ai/dsh-issue-orchestrator', DurableIssueOrchestrator],
    ['@deepseek-ai/dsh-client-ui-issue-orchestration', UiIssueOrchestration],
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
    config: { path: pathToFileURL(configPath).href, patches: patches as never },
  })
  await context.loader.await()
  return context
}

describe('issue automation bundle composition', () => {
  // Real-Loader composition resolves workspace packages through tsx at test
  // time; first resolution after the host/client program split is slow enough
  // to trip the default 5s budget on cold caches.
  it('boots the shipped patch with all seven entries over real base services', { timeout: 60_000 }, async () => {
    const ctx = await bootPatch()

    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(ctx.trackers.list()).toEqual(['memory', 'linear'])
    expect(ctx.issueWorkflow.current().policy).toMatchObject({
      trackerProvider: 'memory',
      maxContinuationAttempts: 5,
      promptTemplate: 'Work {{ issue.identifier }}.',
    })
    // The Linear provider registered with host-held configuration and no network use.
    expect(ctx.trackers.bindTools('linear')).toMatchObject({
      provider: 'linear',
      secretEnvironmentNames: ['LINEAR_API_KEY'],
    })

    const changes: number[] = []
    ctx.on('issue-orchestration/changed', (revision) => { changes.push(revision) })
    // At least one complete scheduler tick ran against the memory provider and left the table empty.
    await vi.waitFor(() => {
      expect(changes.length).toBeGreaterThanOrEqual(2)
      const snapshot = ctx.issueOrchestration.snapshot()
      expect(snapshot.checking).toBe(false)
      expect(snapshot.workflowRevision).toBe(ctx.issueWorkflow.current().revision)
      expect([...snapshot.running, ...snapshot.retrying, ...snapshot.blocked]).toEqual([])
    }, 10_000)
  })
})
