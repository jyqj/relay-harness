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
import { Context } from '@relay-harness/cordis'
import Loader from '@relay-harness/cordis-plugin-loader'
import Include, { entryListSchema } from '@relay-harness/cordis-plugin-include'
import * as yaml from 'js-yaml'
import AgentRegistry from '@relay-harness/rlh-agent'
import AgentDefaultModel from '@relay-harness/rlh-agent-default-model'
import LlmRuntime from '@relay-harness/rlh-llm'
import SessionStore from '@relay-harness/rlh-session'
import Storage from '@relay-harness/rlh-storage'
import * as StorageDomain from '@relay-harness/rlh-storage-domain'
import * as StorageJson from '@relay-harness/rlh-storage-json'
import LocalSubprocessRuntime from '@relay-harness/rlh-subprocess-local'
import SystemPrompt from '@relay-harness/rlh-system-prompt'
import ToolRuntime from '@relay-harness/rlh-tools'
import TrackerRegistry, { type TrackerProvider } from '@relay-harness/rlh-tracker'
import * as TrackerLinear from '@relay-harness/rlh-tracker-linear'
import FileIssueWorkflow from '@relay-harness/rlh-issue-workflow-file'
import LocalIssueWorkspaceProvisioner from '@relay-harness/rlh-issue-workspace-local'
import AgentIssueRunner from '@relay-harness/rlh-issue-runner-agent'
import DurableIssueOrchestrator from '@relay-harness/rlh-issue-orchestrator'
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
  root = await mkdtemp(join(tmpdir(), 'rlh-issue-automation-'))
  const workflowPath = join(root, 'WORKFLOW.md')
  await writeFile(workflowPath, workflow)
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@relay-harness/rlh-storage'",
    "- name: '@relay-harness/rlh-storage-json'",
    '  config:',
    `    root: ${JSON.stringify(join(root, 'storage'))}`,
    "- name: '@relay-harness/rlh-storage-domain'",
    '  config:',
    '    backend: json',
    "- name: '@relay-harness/rlh-llm'",
    "- name: '@relay-harness/rlh-session'",
    "- name: '@relay-harness/rlh-system-prompt'",
    "- name: '@relay-harness/rlh-tools'",
    "- name: '@relay-harness/rlh-agent'",
    "- name: '@relay-harness/rlh-agent-default-model'",
    '  config:',
    '    provider: stub-provider',
    '    model: stub-model',
    "- name: '@relay-harness/rlh-subprocess-local'",
    '- name: memory-tracker-stub',
    '',
  ].join('\n'))
  vi.stubEnv('RLH_ISSUE_WORKFLOW', workflowPath)
  vi.stubEnv('RLH_LINEAR_PROJECT_SLUG', 'composition-fixture')
  vi.stubEnv('LINEAR_API_KEY', 'composition-stub-key')
  vi.stubEnv('RLH_ISSUE_WORKSPACE_ROOT', join(root, 'workspaces'))

  const patchText = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const patches = yaml.load(patchText, { schema: entryListSchema }) as unknown[]

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@relay-harness/rlh-storage', Storage],
    ['@relay-harness/rlh-storage-json', StorageJson],
    ['@relay-harness/rlh-storage-domain', StorageDomain],
    ['@relay-harness/rlh-llm', LlmRuntime],
    ['@relay-harness/rlh-session', SessionStore],
    ['@relay-harness/rlh-system-prompt', SystemPrompt],
    ['@relay-harness/rlh-tools', ToolRuntime],
    ['@relay-harness/rlh-agent', AgentRegistry],
    ['@relay-harness/rlh-agent-default-model', AgentDefaultModel],
    ['@relay-harness/rlh-subprocess-local', LocalSubprocessRuntime],
    ['memory-tracker-stub', memoryTrackerPlugin],
    ['@relay-harness/rlh-tracker', TrackerRegistry],
    ['@relay-harness/rlh-tracker-linear', TrackerLinear],
    ['@relay-harness/rlh-issue-workflow-file', FileIssueWorkflow],
    ['@relay-harness/rlh-issue-workspace-local', LocalIssueWorkspaceProvisioner],
    ['@relay-harness/rlh-issue-runner-agent', AgentIssueRunner],
    ['@relay-harness/rlh-issue-orchestrator', DurableIssueOrchestrator],
    ['@relay-harness/rlh-client-ui-issue-orchestration', UiIssueOrchestration],
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
