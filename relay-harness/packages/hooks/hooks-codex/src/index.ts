/**
 * Bridge for unmodified Codex command hooks on harness interception points. It
 * supports five points (SessionStart, prompt/tool pre/post, Stop), regex-only
 * matchers, snake_case payloads without a trailing newline, no hook environment
 * or command substitution, and no pre-tool approval or rewrite path; only
 * blocking decisions are honored. Shared execution and parsing live in
 * `rlh-hook-protocol`; see the
 * [hook-bridges Agent Note](../../../../.agents/notes/implemented/feature/2026-06-30-hook-bridges.md).
 * @module @relay-harness/rlh-hooks-codex
 */

// Each dialect bridge keeps its complete dependency list visible at the entry
// point; a cross-package facade for imports alone would add indirection.
/* jscpd:ignore-start */
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import type { Agent, PreStepDecision } from '@relay-harness/rlh-agent'
import { createUserMessage } from '@relay-harness/rlh-llm'
import type { ContentBlock, MessageSource } from '@relay-harness/rlh-llm'
import type { UserMessage } from '@relay-harness/rlh-session'
import type {} from '@relay-harness/rlh-session-persistence'
import type { PostToolDecision, PreToolDecision, ToolExecution, ToolExecutionResult } from '@relay-harness/rlh-tools'
import {
  appendHookInvoked,
  appendHookResult,
  createDetachedRuns,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_STDERR_SUMMARY_MAX_CHARS,
  matchesMatcher,
  mergeHookOutputs,
  runHook,
  type HookOutput,
  type MatcherGroup,
  type MergedHookOutcome,
} from '@relay-harness/rlh-hook-protocol'
import { parseCodexConfig, type CodexHookConfig } from './config.ts'
/* jscpd:ignore-end */

export const name = 'hooks-codex'
export const inject = ['shell']

/** Plugin config: where the Codex hooks.json lives + the model name for payloads. */
export interface Config {
  /**
   * Path to a Codex `hooks.json`. An absolute path names one shared file. A
   * relative path is discovered per session from its cwd upward through the
   * nearest `.git` root; agent-less calls use the process cwd.
   */
  configPath: string
  /** The model name stamped on every payload (Codex includes `model` on each event). */
  model?: string
  /** Default per-hook timeout in ms when a hook sets none (Codex default: 600000). */
  defaultTimeoutMs?: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars?: number
}

export const Config: z<Config> = z.object({
  configPath: z.string().required(),
  model: z.string().default(''),
  defaultTimeoutMs: z.number().default(DEFAULT_HOOK_TIMEOUT_MS),
  stderrSummaryMaxChars: z.number().default(DEFAULT_STDERR_SUMMARY_MAX_CHARS),
})

let handlerCounter = 0
function nextHandlerId(point: string): string {
  return `codex:${point}:${++handlerCounter}`
}

const PLUGIN_SOURCE: MessageSource = { kind: 'plugin', plugin: 'hooks-codex' }

/** The summary cap bounds a persisted event field — a positive integer or the slice misbehaves silently. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`hooks-codex: ${name} must be a positive integer`)
  }
}

interface LocatedHookConfig {
  path: string
  version: string
}

/** Stat one config candidate and return a change token, or undefined when absent. */
function hookConfigAt(path: string): LocatedHookConfig | undefined {
  const info = statSync(path, { bigint: true, throwIfNoEntry: false })
  if (info === undefined) return undefined
  if (!info.isFile()) throw new Error(`hook config is not a regular file: ${path}`)
  return {
    path,
    version: [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':'),
  }
}

/** Discover one absolute or project-relative config without crossing a Git root. */
function locateHookConfig(configPath: string, cwd: string): LocatedHookConfig | undefined {
  if (isAbsolute(configPath)) return hookConfigAt(configPath)
  let current = resolve(cwd)
  for (;;) {
    const located = hookConfigAt(resolve(current, configPath))
    if (located !== undefined) return located
    const marker = statSync(join(current, '.git'), { throwIfNoEntry: false })
    if (marker !== undefined) return undefined
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

export function apply(ctx: Context, config: Config): void {
  // Validate before config parsing so a bad value cannot be hidden by its early return.
  const stderrSummaryMaxChars = config.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS
  assertPositiveInteger('stderrSummaryMaxChars', stderrSummaryMaxChars)
  const defaultTimeoutMs = config.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS
  const configPath = config.configPath.trim()
  if (configPath.length === 0) throw new Error('hooks-codex: configPath must be non-empty')
  if (!isAbsolute(configPath) && configPath.split(/[\\/]+/).includes('..')) {
    throw new Error('hooks-codex: relative configPath must not contain ".." segments')
  }
  const model = config.model ?? ''
  const configCache = new Map<string, { version: string; config: CodexHookConfig }>()
  const reportedFailures = new Map<string, string>()

  /** Resolve, version, and parse the config applicable to one agent. */
  function hookConfig(agent?: Agent): CodexHookConfig {
    const cwd = agent?.session.header.cwd ?? process.cwd()
    let located: LocatedHookConfig | undefined
    try {
      located = locateHookConfig(configPath, cwd)
    } catch (error: unknown) {
      const failure = String(error)
      const key = `${cwd}\0${configPath}`
      if (reportedFailures.get(key) !== failure) {
        reportedFailures.set(key, failure)
        ctx.logger.warn(`hooks-codex: could not discover hook config "${configPath}" for "${cwd}": ${failure} — no hooks registered`)
      }
      return {}
    }
    if (located === undefined) return {}
    const cached = configCache.get(located.path)
    if (cached?.version === located.version) return cached.config
    try {
      const raw: unknown = JSON.parse(readFileSync(located.path, 'utf8'))
      const result = parseCodexConfig(raw)
      configCache.set(located.path, { version: located.version, config: result.config })
      reportedFailures.delete(located.path)
      for (const s of result.skipped) {
        ctx.logger.warn(`hooks-codex: skipping ${s.reason} on ${s.event} from "${located.path}" (only sync command hooks run)`)
      }
      return result.config
    } catch (error: unknown) {
      const failure = String(error)
      reportedFailures.set(located.path, `${located.version}:${failure}`)
      ctx.logger.warn(`hooks-codex: could not load hook config "${located.path}": ${failure} — no hooks registered`)
      configCache.set(located.path, { version: located.version, config: {} })
      return {}
    }
  }

  // Every hook run is tracked so bridge disposal aborts its process and waits
  // for the complete listener continuation to settle.
  const detached = createDetachedRuns()
  ctx.effect(() => () => detached.drain(), 'hooks-codex: drain detached hook runs')
  const sessionStarts = new WeakMap<Agent, string>()
  const stopHookTurns = new WeakMap<Agent, number>()

  /**
   * Run and fold one configured Codex hook point.
   *
   * A supplied turn records the hook invocation/result pair inside that open turn.
   * Detached lifecycle points omit it.
   */
  async function runPoint(
    point: string,
    matchQuery: string,
    payload: unknown,
    opts: {
      agent?: Agent
      turn?: number
      readonly signal: AbortSignal
      plainStdoutAsContext?: boolean
    },
  ): Promise<MergedHookOutcome> {
    const groups: MatcherGroup[] = hookConfig(opts.agent)[point] ?? []
    const outputs: HookOutput[] = []
    // Run hooks in the agent's session workspace so relative paths address the
    // user's project rather than the server launch directory.
    const workdir = opts.agent?.session.header.cwd
    for (const group of groups) {
      // Codex always interprets matchers as regexes; it has no literal fast path.
      if (!matchesMatcher(group.matcher, matchQuery, 'codex')) continue
      for (const hook of group.hooks) {
        const handlerId = nextHandlerId(point)
        const session = opts.agent?.session
        if (session && opts.turn !== undefined) {
          appendHookInvoked(session, {
            turn: opts.turn, point, dialect: 'codex', handlerId,
            ...group.matcher !== undefined ? { matcher: group.matcher } : {},
          })
        }
        const { output, durationMs } = await runHook(ctx.shell, hook, {
          payload,
          defaultTimeoutMs,
          ...workdir !== undefined ? { cwd: workdir } : {},
          signal: opts.signal,
          trailingNewline: false, // Codex writes stdin without a trailing newline.
          // Discard a `hookSpecificOutput` block naming a different event.
          expectedEventName: point,
        }, () => performance.now())
        // Clean plain stdout becomes context only when no structured context
        // exists; nonzero output and raw JSON never leak as prose.
        if (opts.plainStdoutAsContext === true && output.exitCode === 0
          && output.additionalContext === undefined
          && output.stdout.length > 0 && !output.stdout.startsWith('{')) {
          output.additionalContext = output.stdout
        }
        outputs.push(output)
        // Execution and decision mapping remain in each bridge so dialect
        // differences stay explicit at their owning extension point.
        /* jscpd:ignore-start */
        if (output.systemMessage !== undefined) {
          ctx.logger.warn(`hooks-codex: ${point} hook emitted a systemMessage, which is not yet surfaced (ignored)`)
        }
        if (session && opts.turn !== undefined) {
          appendHookResult(session, { turn: opts.turn, point, handlerId, output, stderrSummaryMaxChars, durationMs })
        }
      }
    }
    return mergeHookOutputs(outputs)
  }

  /** Run one point under both caller and bridge lifetimes, and track it for teardown. */
  function trackedRunPoint(
    point: string,
    matchQuery: string,
    payload: unknown,
    opts: {
      agent?: Agent
      turn?: number
      readonly signal: AbortSignal
      plainStdoutAsContext?: boolean
    },
  ): Promise<MergedHookOutcome> {
    const run = runPoint(point, matchQuery, payload, {
      ...opts,
      signal: AbortSignal.any([opts.signal, detached.signal]),
    })
    detached.track(run)
    return run
  }

  // TODO(hook-continue-false): `merged.stop` is logged but needs a run-level halt mechanism.

  function contextFrom(merged: MergedHookOutcome): UserMessage | undefined {
    if (merged.additionalContext.length === 0) return undefined
    const content: ContentBlock[] = merged.additionalContext.map(text => ({ type: 'text', text }))
    return createUserMessage({ content, source: PLUGIN_SOURCE })
  }

  /** Prepend one context without flattening source fields or other downstream metadata. */
  function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
    return [ours, ...theirs ?? []]
  }

  // The emit records source only. The first nonempty pre-step awaits the hook,
  // so startup context cannot miss the first sampling request.
  ctx.on('agent/session-start', ({ agent, source }) => {
    sessionStarts.set(agent, source)
  })

  // UserPromptSubmit → PreStepDecision. Codex supports reject, not rewrite or ask.
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    if (messages.length === 0) return next()
    let startupContext: UserMessage | undefined
    const startupSource = sessionStarts.get(agent)
    if (startupSource !== undefined) {
      sessionStarts.delete(agent)
      const startup = await trackedRunPoint(
        'SessionStart',
        startupSource,
        { ...base(ctx, agent, 'SessionStart', model), source: startupSource },
        { agent, turn, plainStdoutAsContext: true, signal },
      )
      startupContext = contextFrom(startup)
    }
    const payload = {
      ...base(ctx, agent, 'UserPromptSubmit', model),
      turn_id: String(turn),
      prompt: blocksToText(messages.flatMap(message => message.content)),
    }
    const merged = await trackedRunPoint('UserPromptSubmit', '', payload, {
      agent, turn, plainStdoutAsContext: true, signal,
    })
    /* jscpd:ignore-start */
    if (merged.decision === 'deny') {
      if (startupContext !== undefined) agent.inject(startupContext)
      return { kind: 'reject' }
    }
    // Context alone is not a veto: DELEGATE so a later pre-step listener can
    // still reject/rewrite, then fold our context onto its decision.
    const downstream = await next()
    const ours = contextFrom(merged)
    if (downstream.kind !== 'enter') {
      if (startupContext !== undefined) agent.inject(startupContext)
      return downstream
    }
    const contexts = [startupContext, ours].filter((message): message is UserMessage => message !== undefined)
    if (contexts.length === 0) return downstream
    return {
      kind: 'enter',
      messages: [...downstream.messages, ...contexts],
    }
  })

  // PreToolUse → PreToolDecision. Codex blocks only (no allow/ask honored).
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const turn = lastTurn(exec.agent)
    const merged = await trackedRunPoint('PreToolUse', exec.name, preToolPayload(ctx, exec, model), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    /* jscpd:ignore-end */
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
    return next()
  })

  // PostToolUse → PostToolDecision (block with feedback, or attach context).
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const turn = lastTurn(exec.agent)
    /* jscpd:ignore-start */
    const merged = await trackedRunPoint('PostToolUse', exec.name, postToolPayload(ctx, exec, result, model), { ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal })
    const context = contextFrom(merged)
    if (merged.decision === 'deny') {
      return { kind: 'block', feedback: [{ type: 'text', text: merged.reason ?? 'blocked by PostToolUse hook' }], ...context ? { additionalContexts: [context] } : {} }
    }
    // Context alone is not a veto: DELEGATE, then fold our context onto the
    // downstream decision (a downstream block carries it too).
    const downstream = await next()
    if (!context) return downstream
    if (downstream.kind === 'block') {
      return { ...downstream, additionalContexts: prependContext(context, downstream.additionalContexts) }
    }
    return {
      ...downstream,
      additionalContexts: prependContext(context, downstream.additionalContexts),
    }
  })

  // A blocking Stop hook may steer once per turn. Later stop checks receive
  // stop_hook_active=true and cannot force an unbounded continuation loop.
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const stopHookActive = stopHookTurns.get(agent) === turn
    const merged = await trackedRunPoint('Stop', '', { ...turnBase(ctx, agent, 'Stop', model), stop_hook_active: stopHookActive, last_assistant_message: null }, { agent, turn, signal })
    /* jscpd:ignore-end */
    if (merged.decision === 'deny') {
      if (stopHookActive) {
        ctx.logger.warn(`hooks-codex: Stop hook remained blocking after its continuation in turn ${turn}; closing the turn`)
        return
      }
      // A blocking Stop hook forces continuation; a block with no reason (exit 2,
      // empty stderr) still forces it — fall back to a generic steering line
      // rather than letting the turn stop.
      const text = merged.reason ?? 'continue: blocked by Stop hook'
      stopHookTurns.set(agent, turn)
      agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: PLUGIN_SOURCE }))
    }
  })
}

// --- Codex DIALECT payloads: snake_case, model on every event, turn_id on
// turn-scoped events. ---

// These small payload helpers intentionally remain next to the dialect shape;
// sharing them would pull bridge-only agent/LLM dependencies into hook-protocol.
/* jscpd:ignore-start */
function lastTurn(agent: Agent | undefined): number {
  if (!agent) return 0
  const last = [...agent.session.events].findLast(e => e.type === 'turn/start')
  /* v8 ignore next -- agent-present turnBase callers are tool/stop extension points inside an open turn. */
  return last?.type === 'turn/start' ? last.data.turn : 0
}

function blocksToText(content: ContentBlock[]): string {
  return content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('')
}
/* jscpd:ignore-end */

/** Base fields on every Codex payload (no turn_id). */
function base(ctx: Context, agent: Agent | undefined, event: string, model: string): Record<string, unknown> {
  return {
    session_id: agent?.session.header.id ?? '',
    transcript_path: agent === undefined
      ? null
      : ctx.get('sessionPersistence')?.locate(agent.session.header)?.path ?? null,
    cwd: agent?.session.header.cwd ?? process.cwd(),
    hook_event_name: event,
    model,
    permission_mode: 'default',
  }
}

/** Base + turn_id, for the turn-scoped events (PreToolUse/PostToolUse/UserPromptSubmit/Stop). */
function turnBase(ctx: Context, agent: Agent | undefined, event: string, model: string): Record<string, unknown> {
  return { ...base(ctx, agent, event, model), turn_id: String(lastTurn(agent)) }
}

/** Extract a `command` string from a tool call's parsed arguments, else ''. */
function commandOf(args: unknown): string {
  if (typeof args === 'object' && args !== null && 'command' in args) {
    const command: unknown = args.command
    if (typeof command === 'string') return command
  }
  return ''
}

function preToolPayload(ctx: Context, exec: ToolExecution, model: string): Record<string, unknown> {
  // `tool_name` is the REAL tool name (matching the `exec.name` matcher subject);
  // a hardcoded constant would disagree with what the matcher tests and make a
  // config's tool matcher never fire. `tool_input` keeps Codex's `{ command }`
  // shape (its shell payload), derived from the call's `command` arg when present.
  return { ...turnBase(ctx, exec.agent, 'PreToolUse', model), tool_name: exec.name, tool_input: { command: commandOf(exec.arguments) }, tool_use_id: exec.callId }
}

function postToolPayload(ctx: Context, exec: ToolExecution, result: ToolExecutionResult, model: string): Record<string, unknown> {
  return { ...turnBase(ctx, exec.agent, 'PostToolUse', model), tool_name: exec.name, tool_input: { command: commandOf(exec.arguments) }, tool_use_id: exec.callId, tool_response: blocksToText(result.content) }
}
