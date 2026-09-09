/** Keyless real-Loader transcript of completed replay and unknown-outcome refusal. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@relay-harness/cordis'
import Loader from '@relay-harness/cordis-plugin-loader'
import Include from '@relay-harness/cordis-plugin-include'
import AgentRegistry from '@relay-harness/rlh-agent'
import AgentLoop from '@relay-harness/rlh-agent-loop'
import LlmRuntime from '@relay-harness/rlh-llm'
import SessionStore, { SessionId } from '@relay-harness/rlh-session'
import SystemPrompt from '@relay-harness/rlh-system-prompt'
import ToolRuntime from '@relay-harness/rlh-tools'
import SubagentRuntime from '@relay-harness/rlh-subagent'
import * as spawn from '@relay-harness/rlh-subagent-spawn-in-process'
import WorkflowEngine from '@relay-harness/rlh-workflow-worker-thread'
import { workflowRequestHash } from '../../../packages/workflow/workflow-worker-thread/src/journal.ts'
import { MockAdapter, textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'

const fixture = fileURLToPath(new URL('./fixtures/workflow-journal/cordis.yml', import.meta.url))
const contexts: Context[] = []
let root: string | undefined

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

/** Only the external model is scripted; every configured plugin is the real implementation. */
async function load(): Promise<{ ctx: Context; adapter: MockAdapter }> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(fixture).href
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@relay-harness/rlh-llm', LlmRuntime],
    ['@relay-harness/rlh-session', SessionStore],
    ['@relay-harness/rlh-system-prompt', SystemPrompt],
    ['@relay-harness/rlh-tools', ToolRuntime],
    ['@relay-harness/rlh-agent', AgentRegistry],
    ['@relay-harness/rlh-agent-loop', AgentLoop],
    ['@relay-harness/rlh-subagent', SubagentRuntime],
    ['@relay-harness/rlh-subagent-spawn-in-process', spawn],
    ['@relay-harness/rlh-workflow-worker-thread', WorkflowEngine],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(name: string) {
      if (!modules.has(name)) throw new Error(`unexpected fixture plugin ${name}`)
      return modules.get(name)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(fixture).href } })
  await ctx.loader.await()
  const adapter = new MockAdapter([textResponse('DELIVERED')])
  ctx.llm.registerAdapter(['mock'], adapter)
  return { ctx, adapter }
}

it('replays committed calls but refuses to repeat a call with a torn terminal journal row', async () => {
  root = await mkdtemp(join(tmpdir(), 'rlh-workflow-recovery-snapshot-'))
  vi.stubEnv('RLH_WORKFLOW_FIXTURE_JOURNAL', root)
  const source = { script: "return await agent('Produce the result')", meta: { name: 'recovery-fixture', description: 'durable workflow recovery' } }
  const first = await load()
  const parent = first.ctx.agentLoop.create(SessionId('first-parent'), { provider: 'mock', model: 'mock' })
  const run = first.ctx.workflowEngine.start({ ...source, parent })
  const initial = await run.result
  await run.dispose()
  const journalPath = join(root, workflowRequestHash('run-id', run.id), 'journal.jsonl')
  const journal = await readFile(journalPath, 'utf8')
  expect(journal.trimEnd().split('\n').map(line => (JSON.parse(line) as { type: string }).type))
    .toEqual(['header', 'intent', 'call'])

  const next = await load()
  const resumedParent = next.ctx.agentLoop.create(SessionId('next-parent'), { provider: 'mock', model: 'mock' })
  const resumed = next.ctx.workflowEngine.start({ ...source, parent: resumedParent, resumeRunId: run.id })
  const replayed = await resumed.result
  await resumed.dispose()

  // Simulate a crash during the terminal write after the child already ran.
  const rows = journal.trimEnd().split('\n')
  await writeFile(journalPath, `${rows.slice(0, 2).join('\n')}\n{"type":"call"`)
  const interrupted = next.ctx.workflowEngine.start({ ...source, parent: resumedParent, resumeRunId: run.id })
  const unknown = await interrupted.result
  await interrupted.dispose()
  expect({
    initial: { value: initial.value, stopReason: initial.stopReason },
    replayed: { value: replayed.value, stopReason: replayed.stopReason },
    unknown: { stopReason: unknown.stopReason, errorMessage: unknown.error?.split('\n')[0] },
    modelRequests: [first.adapter.requests.length, next.adapter.requests.length],
  }).toMatchInlineSnapshot(`
    {
      "initial": {
        "stopReason": "completed",
        "value": "DELIVERED",
      },
      "modelRequests": [
        1,
        0,
      ],
      "replayed": {
        "stopReason": "completed",
        "value": "DELIVERED",
      },
      "unknown": {
        "errorMessage": "WorkflowError: agent() could not start a child: Error: WorkflowJournalError: workflow call 1 has an unknown outcome; reconcile its side effects before starting a new run",
        "stopReason": "error",
      },
    }
  `)
})
