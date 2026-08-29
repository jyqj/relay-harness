import { createUserMessage } from '@relay-harness/rlh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@relay-harness/cordis'
import Loader from '@relay-harness/cordis-plugin-loader'
import { SessionId, type SessionEvent } from '@relay-harness/rlh-session'
import { defineContentToolFixture } from '@relay-harness/rlh-tools'
import type { Agent } from '@relay-harness/rlh-agent'
import AgentLoop from '@relay-harness/rlh-agent-loop'
import { mountAgentLoopTestDependencies } from '@relay-harness/rlh-agent-loop-testkit'
import { LocalBashExecutor } from '@relay-harness/rlh-bash-local'
import LocalSubprocessRuntime from '@relay-harness/rlh-subprocess-local'
import { ShellExecutor } from '@relay-harness/rlh-shell'
import type { ShellExecRequest, ShellExecSpec, ShellProcess, ShellRunResult } from '@relay-harness/rlh-shell'
import * as HooksCodex from '@relay-harness/rlh-hooks-codex'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Full-loop Codex bridge tests with a mock model, the real loop and bash
 * executor, and shell hooks from a temporary config. Covers regex matching,
 * block-only decisions, and the five-event subset.
 */

const dirs: string[] = []
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) })

function configDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rlh-hooks-codex-'))
  dirs.push(dir)
  return dir
}
function script(dir: string, name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, body)
  chmodSync(path, 0o755)
  return path
}
function writeHooks(dir: string, hooks: unknown): void {
  writeFileSync(join(dir, 'hooks.json'), JSON.stringify({ hooks }))
}

interface HookHarnessOptions {
  beforeHooks?: (ctx: Context) => void
  deterministicOutputs?: Readonly<Record<string, string>>
}

/** Deterministic foreground runner for bridge state tests that do not exercise process behavior. */
class DeterministicHookExecutor extends ShellExecutor {
  constructor(ctx: Context, private readonly outputs: Readonly<Record<string, string>>) {
    super(ctx)
  }

  resolve(request: ShellExecRequest): ShellExecSpec {
    return {
      command: request.command,
      workdir: request.workdir ?? '/stub',
      timeoutMs: request.timeoutMs ?? 1_000,
      stdoutMaxBytes: request.stdoutMaxBytes ?? 64_000,
      ...request.signal ? { signal: request.signal } : {},
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  async run(spec: ShellExecSpec): Promise<ShellRunResult> {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      timeoutMs: spec.timeoutMs,
      stdout: { text: this.outputs[spec.command] ?? '', truncated: false },
      stderr: { text: '', truncated: false },
    }
  }

  start(): ShellProcess {
    throw new Error('DeterministicHookExecutor only supports foreground hook runs')
  }
}

async function harnessWithConfig(configPath: string, adapter: MockAdapter, options: HookHarnessOptions = {}): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  if (options.deterministicOutputs === undefined) {
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  } else {
    await ctx.plugin(DeterministicHookExecutor, options.deterministicOutputs)
  }
  options.beforeHooks?.(ctx)
  await ctx.plugin(HooksCodex, { configPath, model: 'test-model' })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

async function harness(dir: string, adapter: MockAdapter, beforeHooks?: (ctx: Context) => void): Promise<Context> {
  return harnessWithConfig(join(dir, 'hooks.json'), adapter, {
    ...beforeHooks !== undefined ? { beforeHooks } : {},
  })
}

function waitForIdle(_ctx: Context, agent: Agent): Promise<void> {
  return agent.whenIdle()
}
function events(agent: Agent): SessionEvent[] { return [...agent.session.events] }

/** Poll `predicate` until true or the deadline passes (detached hook effects can't be awaited directly). */
async function waitFor(predicate: () => boolean, timeout = 5000, interval = 10): Promise<void> {
  const deadline = Date.now() + timeout
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor: condition not met before deadline')
    await new Promise(r => setTimeout(r, interval))
  }
}

describe('hooks-codex bridge', () => {
  it('a PreToolUse hook (exit 2) denies a tool the regex matcher matches as a substring', async () => {
    const dir = configDir()
    const deny = script(dir, 'deny.sh', '#!/usr/bin/env bash\necho "codex blocked it" >&2\nexit 2\n')
    // Codex regex matcher: "Bash" is /Bash/ — matches the tool name "Bash".
    writeHooks(dir, { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: deny }] }] })

    const adapter = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'ls' }), textResponse('done')])
    const ctx = await harness(dir, adapter)
    let ran = false
    ctx.tools.register(defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { ran = true; return [{ type: 'text', text: 'no' }] } }))
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run ls' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(ran).toBe(false)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(true)
    expect(result?.type === 'tool/result' && result.data.message.content[0].content.some(b => b.type === 'text' && b.text.includes('codex blocked it'))).toBe(true)
    expect(events(agent).some(e => e.type === 'hook/invoked' && e.data.dialect === 'codex' && e.data.point === 'PreToolUse')).toBe(true)
  })

  it('a Stop hook (exit 2) forces the turn to continue with the reason as steering', async () => {
    const dir = configDir()
    // Stop ignores its malformed matcher field. This hook always blocks; the
    // bridge must permit exactly one continuation and then close the turn.
    const cont = script(dir, 'cont.sh', '#!/usr/bin/env bash\necho "keep going: address the goal" >&2\nexit 2\n')
    writeHooks(dir, { Stop: [{ matcher: '[', hooks: [{ type: 'command', command: cont }] }] })

    const adapter = new MockAdapter([textResponse('first answer'), textResponse('second answer after goal')])
    const warn = vi.fn()
    const ctx = await harness(dir, adapter, (ctx) => { ctx.logger.warn = warn as never })
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('keep going: address the goal')
    expect(events(agent).filter(event => event.type === 'hook/invoked' && event.data.point === 'Stop')).toHaveLength(2)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Stop hook remained blocking'))
  }, 15_000) // Two real hook subprocesses and agent steps need startup and teardown headroom under load.

  it('awaits SessionStart context before the first sampling request', async () => {
    const dir = configDir()
    const startup = script(dir, 'startup.sh', '#!/usr/bin/env bash\nsleep 0.2\necho "startup context ready"\n')
    writeHooks(dir, { SessionStart: [{ hooks: [{ type: 'command', command: startup }] }] })
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('session-start-gate'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go immediately' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('startup context ready')
    expect(events(agent).some(event => event.type === 'hook/invoked' && event.data.point === 'SessionStart')).toBe(true)
  })

  it('turn cancellation aborts and reaps a running UserPromptSubmit hook before idle', async () => {
    const dir = configDir()
    const pidFile = join(dir, 'pid')
    const marker = join(dir, 'started')
    const slow = script(dir, 'slow-prompt.sh', `#!/usr/bin/env bash\necho $$ > "${pidFile}"\ntouch "${marker}"\nsleep 30\n`)
    writeHooks(dir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: slow }] }] })

    const adapter = new MockAdapter([textResponse('must not run')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('cancel-prompt-hook'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'cancel the hook' }], source: { kind: 'user' } }))
    await waitFor(() => existsSync(marker))
    const pid = Number(readFileSync(pidFile, 'utf8').trim())

    const idle = agent.whenIdle()
    agent.cancel({ kind: 'user' })
    await idle

    expect(() => process.kill(pid, 0)).toThrow()
    expect(adapter.requests).toHaveLength(0)
    expect(events(agent).filter(event => event.type === 'turn/start' || event.type === 'hook/invoked'
      || event.type === 'hook/result' || event.type === 'turn/end').map(event => event.type))
      .toEqual(['turn/start', 'hook/invoked', 'hook/result', 'turn/end'])
  })

  it('only the five bridge-supported Codex events are honored — a SubagentStop entry is ignored', async () => {
    const dir = configDir()
    const s = script(dir, 'x.sh', '#!/usr/bin/env bash\nexit 2\n')
    writeHooks(dir, { SubagentStop: [{ hooks: [{ type: 'command', command: s }] }] })

    const adapter = new MockAdapter([textResponse('fine')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
  })

  it('a missing config registers no hooks and does not crash', async () => {
    const dir = configDir() // no hooks.json written
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harness(dir, adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
  })

  it('walks a missing relative config to the filesystem root without failing the turn', async () => {
    const dir = configDir()
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = await harnessWithConfig('missing-hooks.json', adapter)
    const agent = ctx.agentLoop.create(SessionId('missing-relative'), { provider: 'mock', model: 'mock' }, { cwd: dir })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(1)
  })

  it('contains and deduplicates discovery failures for a non-file config path', async () => {
    const dir = configDir()
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const warn = vi.fn()
    const ctx = await harnessWithConfig(dir, adapter, { beforeHooks: (ctx) => { ctx.logger.warn = warn as never } })
    const agent = ctx.agentLoop.create(SessionId('config-directory'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(warn.mock.calls.filter(call => String(call[0]).includes('could not discover hook config'))).toHaveLength(1)
    expect(adapter.requests).toHaveLength(2)
  })

  it('rejects empty and parent-traversing config paths at plugin load', () => {
    expect(() => { HooksCodex.apply(new Context(), { configPath: ' ' }) }).toThrow('configPath must be non-empty')
    expect(() => { HooksCodex.apply(new Context(), { configPath: '../hooks.json' }) }).toThrow('must not contain ".." segments')
  })

  it('caches one malformed config failure until the file version changes', async () => {
    const dir = configDir()
    const configPath = join(dir, 'hooks.json')
    writeFileSync(configPath, '{ malformed')
    const adapter = new MockAdapter([textResponse('one'), textResponse('two')])
    const warn = vi.fn()
    const ctx = await harnessWithConfig(configPath, adapter, { beforeHooks: (ctx) => { ctx.logger.warn = warn as never } })
    const agent = ctx.agentLoop.create(SessionId('malformed-cache'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(warn.mock.calls.filter(call => String(call[0]).includes('could not load hook config'))).toHaveLength(1)
    expect(adapter.requests).toHaveLength(2)
  })

  it('discovers one relative config per session without leaking between workspaces', async () => {
    const repoA = configDir()
    const repoB = configDir()
    for (const repo of [repoA, repoB]) {
      mkdirSync(join(repo, '.git'), { recursive: true })
      mkdirSync(join(repo, '.codex'), { recursive: true })
      mkdirSync(join(repo, 'pkg'), { recursive: true })
    }
    const hookA = 'hook-a'
    const hookB = 'hook-b'
    writeFileSync(join(repoA, '.codex/hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: hookA }] }] } }))
    writeFileSync(join(repoB, '.codex/hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: hookB }] }] } }))
    const adapter = new MockAdapter([textResponse('a done'), textResponse('b done')])
    const ctx = await harnessWithConfig('.codex/hooks.json', adapter, {
      deterministicOutputs: { [hookA]: 'context-from-a', [hookB]: 'context-from-b' },
    })

    const agentA = ctx.agentLoop.create(SessionId('repo-a'), { provider: 'mock', model: 'mock' }, { cwd: join(repoA, 'pkg') })
    agentA.followup(createUserMessage({ content: [{ type: 'text', text: 'run a' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agentA)
    const agentB = ctx.agentLoop.create(SessionId('repo-b'), { provider: 'mock', model: 'mock' }, { cwd: join(repoB, 'pkg') })
    agentB.followup(createUserMessage({ content: [{ type: 'text', text: 'run b' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agentB)

    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('context-from-a')
    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('context-from-b')
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('context-from-b')
    expect(JSON.stringify(adapter.requests[1]!.messages)).not.toContain('context-from-a')
  })

  it('stops relative discovery at the nearest Git root', async () => {
    const outer = configDir()
    const inner = join(outer, 'inner')
    mkdirSync(join(outer, '.codex'), { recursive: true })
    mkdirSync(join(inner, '.git'), { recursive: true })
    mkdirSync(join(inner, 'pkg'), { recursive: true })
    const ancestorHook = script(outer, 'ancestor.sh', '#!/usr/bin/env bash\necho "ancestor-context"\n')
    writeFileSync(join(outer, '.codex/hooks.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: ancestorHook }] }] } }))
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await harnessWithConfig('.codex/hooks.json', adapter)
    const agent = ctx.agentLoop.create(SessionId('inner'), { provider: 'mock', model: 'mock' }, { cwd: join(inner, 'pkg') })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(JSON.stringify(adapter.requests[0]!.messages)).not.toContain('ancestor-context')
  })

  it('reloads a session config when its file version changes', async () => {
    const repo = configDir()
    mkdirSync(join(repo, '.git'), { recursive: true })
    mkdirSync(join(repo, '.codex'), { recursive: true })
    const first = 'hook-version-one'
    const second = 'hook-version-two'
    const configPath = join(repo, '.codex/hooks.json')
    writeFileSync(configPath, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: first }] }] } }))
    const adapter = new MockAdapter([textResponse('first'), textResponse('second')])
    const ctx = await harnessWithConfig('.codex/hooks.json', adapter, {
      deterministicOutputs: {
        [first]: 'config-version-one',
        [second]: 'config-version-two-expanded',
      },
    })
    const agent = ctx.agentLoop.create(SessionId('reload'), { provider: 'mock', model: 'mock' }, { cwd: repo })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    writeFileSync(configPath, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ command: second }] }] } }))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    expect(JSON.stringify(adapter.requests[0]!.messages)).toContain('config-version-one')
    expect(JSON.stringify(adapter.requests[1]!.messages)).toContain('config-version-two-expanded')
  })

  it('an invalid regex matcher is reported and registers no hooks', async () => {
    const dir = configDir()
    writeHooks(dir, {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'exit 2' }] }],
      PreToolUse: [{ matcher: '[', hooks: [{ type: 'command', command: 'exit 2' }] }],
    })
    const adapter = new MockAdapter([textResponse('ok')])
    const warn = vi.fn()
    const ctx = await harness(dir, adapter, (ctx) => { ctx.logger.warn = warn as never })
    const agent = ctx.agentLoop.create(SessionId('invalid-codex-matcher'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1)
    expect(events(agent).some(event => event.type === 'hook/invoked')).toBe(false)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining(
      'invalid codex regex matcher "[" on event "PreToolUse"',
    ))
  })

  it('disposing the bridge fiber removes its listeners (HMR safety)', async () => {
    const dir = configDir()
    // A leaked listener would let this blocking hook veto the prompt and log an invocation; a
    // no-op hook would pass even when leaked.
    const deny = script(dir, 'deny.sh', '#!/usr/bin/env bash\nexit 2\n')
    writeHooks(dir, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: deny }] }] })
    const adapter = new MockAdapter([textResponse('ok')])
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
    const fiber = await ctx.plugin(HooksCodex, { configPath: join(dir, 'hooks.json'), model: 'm' })
    await fiber.dispose()
    ctx.llm.registerAdapter(['mock'], adapter)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    expect(adapter.requests).toHaveLength(1) // not blocked → the listener is gone
    expect(events(agent).some(e => e.type === 'hook/invoked')).toBe(false) // no hook ran
  })

  it('disposing the bridge aborts a still-running SessionStart hook and drains to quiescence', async () => {
    const dir = configDir()
    const pidFile = join(dir, 'pid')
    const marker = join(dir, 'started')
    // Record the PID and marker before sleeping past the suite timeout. Disposal must abort the
    // tracked process through `runPoint`, not await its natural exit.
    const slow = script(dir, 'slow.sh', `#!/usr/bin/env bash\necho $$ > "${pidFile}"\ntouch "${marker}"\nsleep 30\n`)
    writeHooks(dir, { SessionStart: [{ hooks: [{ type: 'command', command: slow }] }] })
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LocalSubprocessRuntime)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
    const fiber = await ctx.plugin(HooksCodex, { configPath: join(dir, 'hooks.json'), model: 'm' })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('done')]))
    const warn = vi.fn()
    ctx.logger.warn = warn as never
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'start hook' }], source: { kind: 'user' } }))
    await waitFor(() => existsSync(marker))
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    await fiber.dispose()
    // Disposal reaches quiescence only after the aborted run settles and the process is reaped, so
    // `kill(pid, 0)` must report ESRCH. Untracked fire-and-forget work would remain.
    expect(() => process.kill(pid, 0)).toThrow()
    await agent.whenIdle()
    // runHook resolves an aborted run as a non-blocking error, so draining must
    // not log a rejected continuation.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('SessionStart hook failed'))
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    expect('default' in HooksCodex).toBe(false)
    expect(HooksCodex.name).toBe('hooks-codex')
    expect(HooksCodex.inject).toEqual(['shell'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(HooksCodex) as Record<string, unknown>
    expect(unwrapped).toBe(HooksCodex)
    expect(unwrapped.name).toBe('hooks-codex')
    expect(unwrapped.inject).toEqual(['shell'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
