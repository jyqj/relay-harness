import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@relay-harness/cordis'
import FileIssueWorkflow, { parseIssueWorkflow } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const valid = `---
tracker:
  provider: memory
  active_states: [Todo, In Progress]
  terminal_states: [Done]
  required_labels: [agent]
polling:
  interval_ms: 25
agent:
  max_concurrent_runs: 2
  max_concurrent_runs_by_state:
    Todo: 1
  max_turns: 3
  max_retry_backoff_ms: 500
orchestration:
  continuation_retry_ms: 10
  failure_retry_base_ms: 20
  stall_timeout_ms: 1000
---
Work issue {{ issue.identifier }}: {{ issue.title }}.
`

describe('parseIssueWorkflow', () => {
  it('parses typed policy and defaults continuation guidance', () => {
    expect(parseIssueWorkflow(valid)).toMatchObject({
      trackerProvider: 'memory',
      activeStates: ['Todo', 'In Progress'],
      requiredLabels: ['agent'],
      pollIntervalMs: 25,
      maxConcurrentRuns: 2,
      maxConcurrentRunsByState: { todo: 1 },
      maxTurns: 3,
      promptTemplate: 'Work issue {{ issue.identifier }}: {{ issue.title }}.',
    })
  })

  it('rejects blank bodies, duplicate states, and invalid limits', () => {
    expect(() => parseIssueWorkflow('---\ntracker:\n  provider: memory\n---\n')).toThrow(/body/)
    expect(() => parseIssueWorkflow(valid.replace('[Todo, In Progress]', '[Todo, todo]'))).toThrow(/duplicates/)
    expect(() => parseIssueWorkflow(valid.replace('max_turns: 3', 'max_turns: 0'))).toThrow(/positive/)
  })

  it('materializes every default and accepts an explicit continuation prompt', () => {
    const minimal = '---\ntracker:\n  provider: memory\n---\nDo {{ issue.identifier }}.'
    expect(parseIssueWorkflow(minimal)).toMatchObject({
      activeStates: ['Todo', 'In Progress'], terminalStates: ['Done', 'Closed', 'Cancelled'],
      requiredLabels: [], pollIntervalMs: 30_000, maxConcurrentRuns: 10,
      maxConcurrentRunsByState: {}, maxTurns: 20, continuationRetryMs: 1000,
      maxContinuationAttempts: 5,
      failureRetryBaseMs: 10_000, maxRetryBackoffMs: 300_000, stallTimeoutMs: 300_000,
    })
    expect(parseIssueWorkflow(valid.replace(
      'stall_timeout_ms: 1000',
      'stall_timeout_ms: 0\n  continuation_prompt: Continue exactly.',
    )).continuationTemplate).toBe('Continue exactly.')
    expect(parseIssueWorkflow(valid.replace(
      'continuation_retry_ms: 10',
      'continuation_retry_ms: 10\n  max_continuation_attempts: 0',
    )).maxContinuationAttempts).toBe(0)
  })

  it.each([
    ['prompt without front matter', 'Just a prompt.', /tracker.provider/],
    ['front matter list', '---\n- list\n---\nbody', /front matter/],
    ['state list type', valid.replace('active_states: [Todo, In Progress]', 'active_states: Todo'), /must be an array/],
    ['state entry blank', valid.replace('[Todo, In Progress]', '[Todo, " "]'), /non-blank/],
    ['state limits type', valid.replace('max_concurrent_runs_by_state:\n    Todo: 1', 'max_concurrent_runs_by_state: []'), /must be an object/],
    ['positive integer type', valid.replace('max_turns: 3', 'max_turns: nope'), /positive/],
    ['negative stall', valid.replace('stall_timeout_ms: 1000', 'stall_timeout_ms: -1'), /non-negative/],
    ['stall integer type', valid.replace('stall_timeout_ms: 1000', 'stall_timeout_ms: nope'), /non-negative/],
    ['negative continuation bound', valid.replace('continuation_retry_ms: 10', 'continuation_retry_ms: 10\n  max_continuation_attempts: -1'), /non-negative/],
  ])('rejects %s', (_label, text, error) => {
    expect(() => parseIssueWorkflow(text)).toThrow(error)
  })
})

describe('FileIssueWorkflow', () => {
  it('commits valid revisions and keeps the last good snapshot after a bad reload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-issue-workflow-'))
    roots.push(root)
    const path = join(root, 'WORKFLOW.md')
    await writeFile(path, valid)
    const ctx = new Context()
    const fiber = ctx.plugin(FileIssueWorkflow, { path })
    await fiber
    const first = ctx.issueWorkflow.current()
    await expect(ctx.issueWorkflow.reload()).resolves.toBe(false)
    const updates = vi.fn()
    ctx.on('issue-workflow/updated', updates)

    await writeFile(path, valid.replace('interval_ms: 25', 'interval_ms: 30'))
    await expect(ctx.issueWorkflow.reload()).resolves.toBe(true)
    expect(ctx.issueWorkflow.current().policy.pollIntervalMs).toBe(30)
    expect(updates).toHaveBeenCalledOnce()

    const good = ctx.issueWorkflow.current()
    await writeFile(path, '---\ntracker: []\n---\nbad')
    await expect(ctx.issueWorkflow.reload()).resolves.toBe(false)
    expect(ctx.issueWorkflow.current()).toBe(good)
    expect(ctx.issueWorkflow.current().revision).not.toBe(first.revision)
    await fiber.dispose()
  })

  it('rejects relative paths and reads before provider initialization', () => {
    const ctx = new Context()
    expect(() => new FileIssueWorkflow(ctx, { path: 'WORKFLOW.md' })).toThrow(/absolute/)
    const provider = new FileIssueWorkflow(new Context(), { path: '/missing-workflow.md' })
    expect(() => provider.current()).toThrow(/not initialized/)
  })
})
