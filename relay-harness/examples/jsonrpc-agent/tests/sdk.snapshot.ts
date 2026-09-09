/**
 * Keyless snapshot coverage for the TypeScript SDK path: each scenario spawns
 * the REAL `rlh-jsonrpc-agent` runtime (per `RLH_EXAMPLE_MODE`) through the
 * REAL `@relay-harness/rlh-sdk-client`, drives one turn over stdio JSON-RPC,
 * and pins the SDK `RunResult`, the complete notification stream, and the
 * persisted session logs. Replay serves recorded model
 * responses via `llm-replay` (`cordis.snapshot.yml`); `RLH_SNAPSHOT=record`
 * re-records against the live API; `RLH_SNAPSHOT=refresh` replays committed
 * fixtures and rewrites expected outputs.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  normalizeSessionLog,
  normalizeStdout,
  refreshFixtureReplacements,
  scrubRequestHeaders,
  stabilizeFixtureMessageIds,
  stabilizeRefreshLog,
  tokenizeSessionFixtureCwd,
  type HarvestedLog,
  type NormalizeContext,
} from '@relay-harness/rlh-acp-snapshot'
import { resolveExampleLaunch } from '@relay-harness/rlh-loader-smoke'
import { RelayHarness, type HarnessNotification, type RunResult } from '@relay-harness/rlh-sdk-client'

const testsDir = dirOf(import.meta.url)
const snapshotsDir = join(testsDir, 'snapshots')
const liveConfig = join(testsDir, '..', 'cordis.yml')
const replayConfig = join(testsDir, '..', 'cordis.snapshot.yml')
const minimalLiveConfig = join(testsDir, '..', 'minimal.cordis.yml')
const minimalReplayConfig = join(testsDir, '..', 'minimal.snapshot.cordis.yml')
const runtimeBin = fileURLToPath(new URL('../../../packages/examples/jsonrpc-demo/src/bin.ts', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))

const MINIMAL_SYSTEM_PROMPT = 'You are the environment-selected minimal software engineer.'
const MINIMAL_BASH_DESCRIPTION = `Run commands in a bash shell
* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.
* You don't have access to the internet via this tool.
* You do have access to a mirror of common linux and python packages via apt and pip.
* State is persistent across command calls and discussions with the user.
* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.
* Please avoid commands that may produce a very large amount of output.
* Please run long lived commands in the background, e.g. 'sleep 10 &' or start a server in the background.`

const mode = process.env.RLH_SNAPSHOT ?? 'replay'
const recording = mode === 'record'
const refreshing = mode === 'refresh'

function dirOf(url: string): string {
  return fileURLToPath(new URL('.', url))
}

interface SdkScenario {
  /** Scenario name; the snapshots/<name> fixture directory. */
  name: string
  /** The user prompt for the single SDK turn. */
  prompt: string
  /** Fixed SDK session id, so fixtures and replay binding stay stable. */
  sessionId: string
  /** How many child sessions the turn persists (subagent scenarios). */
  children: number
  /** Optional scenario-specific live and replay compositions. */
  configs?: { live: string; replay: string }
  /** Environment overrides passed to the runtime subprocess. */
  environment?: Readonly<Record<string, string>>
  /** Cwd-relative files whose final contents are part of the scenario contract. */
  expectedFiles?: Readonly<Record<string, string>>
  /** Assembled model-facing tool names and required argument keys. */
  expectedTools?: Readonly<Record<string, readonly string[]>>
  /** Exact assembled system prompt for the root request. */
  expectedSystem?: string
  /** Exact model-facing descriptions for selected tools. */
  expectedToolDescriptions?: Readonly<Record<string, string>>
  /** Expected runtime-context state in the real assembled request. */
  runtimeContext?: false | { includes: readonly string[]; excludes: readonly string[] }
}

const SCENARIOS: SdkScenario[] = [
  {
    name: 'text-turn',
    prompt: 'Reply with exactly: SDK snapshot OK',
    sessionId: 'sdk-snapshot-text',
    children: 0,
  },
  {
    name: 'bash-tool',
    prompt: 'Run this exact command with your bash tool, then reply with its stdout only: echo rlh-sdk-proof-7391',
    sessionId: 'sdk-snapshot-bash',
    children: 0,
  },
  {
    name: 'subagent-spawn-in-process',
    prompt: "Use the subagent tool exactly once with description 'echo probe' and prompt: Reply with exactly: child answer 42. Then reply with the subagent's final answer verbatim.",
    sessionId: 'sdk-snapshot-subagent',
    children: 1,
  },
  {
    name: 'persistent-tools',
    prompt: 'Prove that bash state persists. Then create {{cwd}}/note.txt with a tab-indented line, view it, replace that literal tab-indented line, and make the persistent shell exit with code 9.',
    sessionId: 'persistent-tools-snapshot',
    children: 0,
    configs: { live: minimalLiveConfig, replay: minimalReplayConfig },
    environment: { RLH_SYSTEM_PROMPT: MINIMAL_SYSTEM_PROMPT },
    expectedFiles: { 'note.txt': 'target:\n\tnew\n' },
    expectedTools: { bash: ['command'], str_replace_editor: ['command', 'path'] },
    expectedSystem: MINIMAL_SYSTEM_PROMPT,
    expectedToolDescriptions: { bash: MINIMAL_BASH_DESCRIPTION },
    runtimeContext: false,
  },
]

interface PersistedLog {
  readonly path: string
  readonly content: string
  readonly header: Record<string, unknown>
}

interface MissingFile {
  readonly missing: true
}

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true })
  return entries.filter(entry => entry.endsWith('.jsonl')).map(entry => join(dir, entry)).sort()
}

async function persistedLogs(sessionsRoot: string): Promise<PersistedLog[]> {
  const files = await jsonlFiles(sessionsRoot)
  return Promise.all(files.map(async (path) => {
    const content = await readFile(path, 'utf8')
    const header = JSON.parse(content.slice(0, content.indexOf('\n'))) as Record<string, unknown>
    return { path, content, header }
  }))
}

interface LoggedRequestHeader {
  type?: string
  data?: { header?: { system?: unknown; tools?: LoggedTool[] } }
}

interface LoggedTool {
  readonly name: string
  readonly description?: unknown
  readonly parameters: { readonly required?: string[] }
}

function assembledTools(log: PersistedLog): LoggedTool[] {
  const event = log.content.trimEnd().split('\n')
    .map(line => JSON.parse(line) as LoggedRequestHeader)
    .find(candidate => candidate.type === 'request/header')
  const tools = event?.data?.header?.tools
  if (tools === undefined) throw new Error('session log has no request/header tools')
  return tools
}

function assembledToolRequirements(log: PersistedLog): Record<string, string[]> {
  return Object.fromEntries(assembledTools(log).map(tool => [tool.name, tool.parameters.required ?? []]))
}

function assembledToolDescriptions(log: PersistedLog): Record<string, string> {
  return Object.fromEntries(assembledTools(log).map((tool) => {
    if (typeof tool.description !== 'string') throw new Error(`tool ${tool.name} has no description`)
    return [tool.name, tool.description]
  }))
}

function assembledSystem(log: PersistedLog): string {
  const event = log.content.trimEnd().split('\n')
    .map(line => JSON.parse(line) as LoggedRequestHeader)
    .find(candidate => candidate.type === 'request/header')
  const system = event?.data?.header?.system
  if (typeof system !== 'string') throw new Error('session log has no request/header system')
  return system
}

function assembledRuntimeContexts(log: PersistedLog): string[] {
  return log.content.trimEnd().split('\n').flatMap((line) => {
    const event = JSON.parse(line) as {
      type?: string
      data?: { source?: { kind?: string; plugin?: string }; content?: Array<{ type?: string; text?: unknown }> }
    }
    if (event.type !== 'user/message'
      || event.data?.source?.kind !== 'plugin'
      || event.data.source.plugin !== '@relay-harness/rlh-system-prompt') return []
    return event.data.content?.flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : []) ?? []
  })
}

function contextOf(logs: readonly { content: string; header: Record<string, unknown> }[], cwd: string): NormalizeContext {
  return {
    sessionIds: logs.flatMap(log => typeof log.header.id === 'string' ? [log.header.id] : []),
    cwd,
  }
}

function contextOfContents(contents: readonly string[]): NormalizeContext {
  const headers = contents.map(content => JSON.parse(content.slice(0, content.indexOf('\n'))) as Record<string, unknown>)
  return {
    sessionIds: headers.flatMap(header => typeof header.id === 'string' ? [header.id] : []),
    cwd: typeof headers[0]?.cwd === 'string' ? headers[0].cwd : '\0no-cwd\0',
  }
}

async function hydrateReplayFixtures(scenario: Pick<SdkScenario, 'name' | 'children'>, cwd: string): Promise<string[]> {
  const root = join(cwd, '.replay-fixtures')
  await mkdir(root, { recursive: true })
  return Promise.all(fixtureFiles(scenario).map(async (source) => {
    const destination = join(root, basename(source))
    await writeFile(destination, (await readFile(source, 'utf8')).replaceAll('{{cwd}}', cwd))
    return destination
  }))
}

async function readExpectedFile(path: string): Promise<string | MissingFile> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') return { missing: true }
    throw error
  }
}

/**
 * Normalize the SDK-visible notification stream: embedded `session.event`
 * envelopes get the session-log treatment (times zeroed, headers tokenized),
 * then every record is scrubbed like a wire frame.
 */
function normalizeNotifications(notifications: readonly HarnessNotification[], ctx: NormalizeContext): string {
  const events = notifications
    .filter(n => n.method === 'session.event')
    .map(n => n.params.event as Record<string, unknown>)
  const normalizedEvents = events.length === 0
    ? []
    : scrubRequestHeaders(normalizeSessionLog(
      `${events.map(event => JSON.stringify(event)).join('\n')}\n`,
      ctx,
    )).trimEnd().split('\n').map(line => JSON.parse(line) as Record<string, unknown>)
  let eventIndex = 0
  const records = notifications.map((notification) => {
    if (notification.method !== 'session.event') return { method: notification.method, params: notification.params }
    const event = normalizedEvents[eventIndex++]
    return { method: notification.method, params: { ...notification.params, event } }
  })
  return normalizeStdout(`${records.map(record => JSON.stringify(record)).join('\n')}\n`, ctx)
}

/** Normalize the owned-run projection. */
function normalizeResult(result: RunResult, ctx: NormalizeContext): string {
  return normalizeStdout(`${JSON.stringify({
    sessionId: result.sessionId,
    finalResponse: result.finalResponse,
    finishReason: result.finishReason,
  })}\n`, ctx)
}

/** The scenario subset the runtime opener needs; close probes reuse it without a full {@link SdkScenario}. */
type ScenarioRuntimeSpec = Pick<SdkScenario, 'name' | 'children' | 'configs' | 'environment'> & {
  /** Optional replay override sidecar the runtime serves instead of the derived script. */
  replayOverride?: string
  /**
   * Optional override written into the runtime's cwd before boot (the opener
   * mints that cwd itself), for probes whose sidecar embeds cwd-local paths.
   * Its return value becomes `replayOverride`.
   */
  writeOverride?: (cwd: string) => Promise<string>
}

/** A booted scenario runtime plus the isolated workspace it owns. */
interface OpenRuntime {
  readonly harness: RelayHarness
  readonly cwd: string
  readonly sessionsRoot: string
}

/** Boot the scenario's real runtime subprocess through the SDK client without driving a turn. */
async function openRuntime(scenario: ScenarioRuntimeSpec): Promise<OpenRuntime> {
  const cwd = await mkdtemp(join(tmpdir(), `sdk-snapshot-${scenario.name}-`))
  const sessionsRoot = join(cwd, '.sessions')
  const writtenOverride = scenario.writeOverride === undefined ? undefined : await scenario.writeOverride(cwd)
  const replayFixtures = recording ? [] : await hydrateReplayFixtures(scenario, cwd)
  const launch = resolveExampleLaunch({
    srcBin: runtimeBin,
    configArgs: [],
    tsconfigPath: repoTsconfig,
  })
  const [parentFixture, ...childFixtures] = replayFixtures
  const env: Record<string, string> = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)) as Record<string, string>,
    ...Object.fromEntries(Object.entries(launch.env).filter(([, value]) => value !== undefined)) as Record<string, string>,
    RLH_CORDIS_CONFIG: recording
      ? scenario.configs?.live ?? liveConfig
      : scenario.configs?.replay ?? replayConfig,
    RLH_SESSION_ROOT: sessionsRoot,
    RLH_CWD: cwd,
    RLH_SNAPSHOT: mode,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
    ...parentFixture === undefined ? {} : {
      RLH_SNAPSHOT_FILE: parentFixture,
      ...childFixtures.length > 0 ? { RLH_SNAPSHOT_CHILD_FILES: childFixtures.join(delimiter) } : {},
    },
    ...(scenario.replayOverride ?? writtenOverride) === undefined
      ? {}
      : { RLH_SNAPSHOT_OVERRIDE: (scenario.replayOverride ?? writtenOverride) as string },
    ...scenario.environment,
  }

  const harness = new RelayHarness({
    launch: {
      command: launch.command,
      args: launch.args,
      cwd,
      env,
      requestTimeoutMs: 110_000,
    },
    cwd,
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  })
  return { harness, cwd, sessionsRoot }
}

/** One SDK turn against a fresh runtime subprocess in an isolated cwd. */
async function runScenario(scenario: SdkScenario): Promise<{
  result: RunResult
  notifications: HarnessNotification[]
  logs: PersistedLog[]
  observedFiles: Record<string, string | MissingFile>
  cwd: string
}> {
  const { harness, cwd, sessionsRoot } = await openRuntime(scenario)
  try {
    const notifications: HarnessNotification[] = []
    const result = await harness.run(scenario.prompt.replaceAll('{{cwd}}', cwd), {
      sessionId: scenario.sessionId,
      onNotification: (notification) => { notifications.push(notification) },
    })
    await harness.close()
    const logs = await persistedLogs(sessionsRoot)
    const observedFiles = Object.fromEntries(await Promise.all(
      Object.keys(scenario.expectedFiles ?? {}).map(async (path): Promise<[string, string | MissingFile]> => [
        path,
        await readExpectedFile(join(cwd, path)),
      ]),
    ))
    return { result, notifications, logs, observedFiles, cwd }
  } finally {
    await harness.close()
    await rm(cwd, { recursive: true, force: true })
  }
}

/** Order logs parent-first, children by creation time (fixture layout order). */
function orderLogs(logs: PersistedLog[], scenario: SdkScenario): PersistedLog[] {
  const parents = logs.filter(log => typeof log.header.parentSession !== 'string')
  const children = logs.filter(log => typeof log.header.parentSession === 'string')
    .sort((left, right) => Number(left.header.createdAt) - Number(right.header.createdAt))
  expect(parents).toHaveLength(1)
  expect(children).toHaveLength(scenario.children)
  return [...parents, ...children]
}

function fixtureFiles(scenario: Pick<SdkScenario, 'name' | 'children'>): string[] {
  const dir = join(snapshotsDir, scenario.name)
  return [
    join(dir, 'session.jsonl'),
    ...Array.from({ length: scenario.children }, (_, index) => join(dir, `session.${index + 1}.jsonl`)),
  ]
}

describe('TypeScript SDK snapshots over the jsonrpc runtime', () => {
  for (const scenario of SCENARIOS) {
    it(`replays ${scenario.name} through the SDK`, async () => {
      const scenarioDir = join(snapshotsDir, scenario.name)
      const notificationsExpectedPath = join(scenarioDir, 'notifications.expected.jsonl')
      const resultExpectedPath = join(scenarioDir, 'result.expected.json')

      const { result, notifications, logs, observedFiles, cwd } = await runScenario(scenario)
      const ordered = orderLogs(logs, scenario)
      const actualContext = contextOf(ordered, cwd)
      const files = fixtureFiles(scenario)

      if (recording) {
        // Fixtures carry tokenized request headers; llm-replay reads only
        // assistant output and tool traffic, so scrubbing keeps prompts and
        // schemas out of the corpus without affecting replay.
        await mkdir(scenarioDir, { recursive: true })
        const existing = await Promise.all(files.map(async file => existsSync(file) ? readFile(file, 'utf8') : ''))
        const fixtures = stabilizeFixtureMessageIds(
          ordered.map(log => scrubRequestHeaders(tokenizeSessionFixtureCwd(log.content))),
          existing,
        )
        await Promise.all(fixtures.map(async (fixture, index) => {
          const file = files[index]
          if (file === undefined) throw new Error(`no fixture path for persisted log ${index}`)
          await writeFile(file, fixture)
        }))
      }

      let expectedContents = await Promise.all(files.map(file => readFile(file, 'utf8')))

      if (refreshing) {
        const harvested = ordered.map((log): HarvestedLog => ({
          id: String(log.header.id),
          createdAt: Number(log.header.createdAt),
          ...typeof log.header.parentSession === 'string' ? { parentSession: log.header.parentSession } : {},
          content: log.content,
        }))
        const replacements = refreshFixtureReplacements(harvested, expectedContents)
        const refreshed = ordered.map((log, index) => {
          const existing = expectedContents[index]
          if (existing === undefined) throw new Error(`no fixture for persisted log ${index}`)
          return scrubRequestHeaders(tokenizeSessionFixtureCwd(
            stabilizeRefreshLog(log.content, existing, replacements, actualContext),
          ))
        })
        expectedContents = stabilizeFixtureMessageIds(refreshed, expectedContents)
        await Promise.all(expectedContents.map(async (stable, index) => {
          const file = files[index]
          if (file === undefined) throw new Error(`no fixture for persisted log ${index}`)
          await writeFile(file, stable)
        }))
      }

      for (const [index, expected] of expectedContents.entries()) {
        expect(scrubRequestHeaders(expected), `${scenario.name} session fixture ${index} carries request-header bulk`)
          .toBe(expected)
      }

      // Persisted transcripts match the committed fixtures.
      const expectedContext = contextOfContents(expectedContents)
      for (const [index, log] of ordered.entries()) {
        const expected = expectedContents[index]
        if (expected === undefined) throw new Error(`no fixture for persisted log ${index}`)
        expect(scrubRequestHeaders(normalizeSessionLog(log.content, actualContext)))
          .toBe(scrubRequestHeaders(normalizeSessionLog(expected, expectedContext)))
      }

      // The SDK-visible wire stream and turn result match their expected outputs.
      const normalizedNotifications = normalizeNotifications(notifications, actualContext)
      const normalizedResult = normalizeResult(result, actualContext)
      if (recording || refreshing) {
        await writeFile(notificationsExpectedPath, normalizedNotifications)
        await writeFile(resultExpectedPath, normalizedResult)
      }
      expect(normalizedNotifications).toBe(await readFile(notificationsExpectedPath, 'utf8'))
      expect(normalizedResult).toBe(await readFile(resultExpectedPath, 'utf8'))

      // Wire-shape invariants that must hold in every mode.
      expect(notifications.at(-1)).toMatchObject({
        method: 'session.status',
        params: { status: 'idle' },
      })
      expect(observedFiles).toEqual(scenario.expectedFiles ?? {})
      if (scenario.expectedTools !== undefined) {
        const parent = ordered[0]
        if (parent === undefined) throw new Error(`${scenario.name} has no parent session log`)
        expect(assembledToolRequirements(parent)).toEqual(scenario.expectedTools)
      }
      if (scenario.expectedSystem !== undefined) {
        const parent = ordered[0]
        if (parent === undefined) throw new Error(`${scenario.name} has no parent session log`)
        expect(assembledSystem(parent)).toBe(scenario.expectedSystem)
      }
      if (scenario.expectedToolDescriptions !== undefined) {
        const parent = ordered[0]
        if (parent === undefined) throw new Error(`${scenario.name} has no parent session log`)
        expect(assembledToolDescriptions(parent)).toMatchObject(scenario.expectedToolDescriptions)
      }
      if (scenario.runtimeContext !== undefined) {
        const parent = ordered[0]
        if (parent === undefined) throw new Error(`${scenario.name} has no parent session log`)
        const contexts = assembledRuntimeContexts(parent)
        if (scenario.runtimeContext === false) {
          expect(contexts).toEqual([])
        } else {
          expect(contexts).toHaveLength(1)
          const context = contexts[0] as string
          for (const clause of scenario.runtimeContext.includes) expect(context).toContain(clause)
          for (const clause of scenario.runtimeContext.excludes) expect(context).not.toContain(clause)
          const system = assembledSystem(parent)
          for (const clause of scenario.runtimeContext.includes) expect(system).not.toContain(clause)
        }
      }
      if (scenario.children > 0) {
        expect(notifications.some(n => n.method === 'subagent.started')).toBe(true)
        expect(notifications.some(n => n.method === 'subagent.finished')).toBe(true)
      }
    })
  }
})

/** The session-event envelope fields the close probes read. */
interface CloseProbeEvent {
  readonly type?: unknown
  readonly seq?: number
  readonly data?: {
    readonly turn?: number
    readonly reason?: { readonly kind?: unknown }
    readonly message?: { readonly id?: string; readonly content?: readonly { readonly type?: string; readonly text?: string }[] }
  }
}

/** Parse the final record of a persisted session log. */
function lastLogEvent(log: PersistedLog): CloseProbeEvent {
  const lines = log.content.trimEnd().split('\n')
  return JSON.parse(lines[lines.length - 1] as string) as CloseProbeEvent
}

/** Poll for the exact streamed closing event, independently of the write-behind batch's timing. */
async function waitForLogTurnEnd(sessionsRoot: string, sessionId: string, expected: CloseProbeEvent | undefined): Promise<PersistedLog> {
  if (expected?.type !== 'turn/end' || typeof expected.seq !== 'number'
    || typeof expected.data?.turn !== 'number' || typeof expected.data.reason?.kind !== 'string') {
    throw new Error('close probe observed no identified turn/end')
  }
  const { seq } = expected
  const { turn } = expected.data
  const { kind } = expected.data.reason
  const deadline = Date.now() + 10_000
  for (;;) {
    const logs = await persistedLogs(sessionsRoot)
    const log = logs[0]
    const last = log === undefined ? undefined : lastLogEvent(log)
    if (logs.length === 1 && log?.header.id === sessionId && last?.type === 'turn/end'
      && last.seq === seq && last.data?.turn === turn && last.data.reason?.kind === kind) return log
    if (Date.now() > deadline) {
      throw new Error(`session ${sessionId} never persisted turn/end ${turn} at seq ${seq} (${kind}): ${logs.length} log(s)`)
    }
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

interface CompletedTurnIdentity {
  readonly sessionId: string
  readonly turn: number
  readonly endSeq: number
  readonly assistantSeq: number
  readonly assistantId: string
  readonly text: string
}

/** Bind the durable barrier to this run's exact assistant message and closing turn, not a prior completed tail. */
function completedTurnOf(result: RunResult, text: string): CompletedTurnIdentity {
  expect(result.finalResponse).toBe(text)
  expect(result.finishReason).toBe('completed')
  const assistant = result.events.findLast(event => event.type === 'assistant/message')
  const end = result.events.findLast(event => event.type === 'turn/end')
  if (assistant === undefined || end === undefined) throw new Error('completed SDK run has no assistant message or turn end')
  expect(assistant.data.turn).toBe(end.data.turn)
  expect(assistant.seq).toBeLessThan(end.seq)
  return {
    sessionId: result.sessionId, turn: end.data.turn, endSeq: end.seq,
    assistantSeq: assistant.seq, assistantId: assistant.data.message.id, text,
  }
}

function closeProbeEvents(log: PersistedLog): CloseProbeEvent[] {
  // Only newline-terminated records have committed enough bytes to inspect.
  return log.content.split('\n').slice(1, -1).map(line => JSON.parse(line) as CloseProbeEvent)
}

function persistedAssistantText(event: CloseProbeEvent): string {
  return event.data?.message?.content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('') ?? ''
}

function hasCompletedTurn(log: PersistedLog, expected: CompletedTurnIdentity): boolean {
  if (log.header.id !== expected.sessionId || !log.content.endsWith('\n')) return false
  const events = closeProbeEvents(log)
  const last = events.at(-1)
  if (last?.type !== 'turn/end' || last.seq !== expected.endSeq || last.data?.turn !== expected.turn
    || last.data.reason?.kind !== 'completed') return false
  return events.some(event => event.type === 'assistant/message' && event.seq === expected.assistantSeq
    && event.data?.turn === expected.turn && event.data.message?.id === expected.assistantId
    && persistedAssistantText(event) === expected.text)
}

/** Wait for the exact run's records; idle and agent disposal are not substitutes for observing its write-behind commit. */
async function waitForCompletedTurn(sessionsRoot: string, expected: CompletedTurnIdentity): Promise<PersistedLog> {
  const deadline = Date.now() + 10_000
  for (;;) {
    const logs = await persistedLogs(sessionsRoot)
    const log = logs[0]
    if (logs.length === 1 && log !== undefined && hasCompletedTurn(log, expected)) return log
    if (Date.now() > deadline) throw new Error(`SDK turn was not persisted: ${JSON.stringify(expected)}; ${logs.length} log(s)`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}

/** Collect the probe session's `session.event` payloads from a subscription until `stop`. */
const isProbeSessionEvent = (notification: HarnessNotification, sessionId: string): boolean =>
  notification.method === 'session.event' && notification.params.sessionId === sessionId

describe('SDK durable completion barrier', () => {
  it('does not accept an old completed turn while the exact second turn is still awaiting persistence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sdk-durable-barrier-'))
    const path = join(root, 'session.jsonl')
    const header = { type: 'session', version: 0, id: 'barrier-probe', createdAt: 0 }
    const firstEvents = [
      { type: 'turn/start', seq: 0, data: { turn: 1 } },
      { type: 'assistant/message', seq: 1, data: { turn: 1, message: { id: 'assistant-first', content: [{ type: 'text', text: 'first response' }] } } },
      { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ]
    const secondEvents = [
      { type: 'turn/start', seq: 3, data: { turn: 2 } },
      { type: 'assistant/message', seq: 4, data: { turn: 2, message: { id: 'assistant-second', content: [{ type: 'text', text: 'second response' }] } } },
      { type: 'turn/end', seq: 5, data: { turn: 2, reason: { kind: 'completed' } } },
    ]
    const initial = [header, ...firstEvents].map(event => JSON.stringify(event)).join('\n') + '\n'
    const final = initial + secondEvents.map(event => JSON.stringify(event)).join('\n') + '\n'
    await writeFile(path, initial)
    const expected: CompletedTurnIdentity = { sessionId: 'barrier-probe', turn: 2, endSeq: 5, assistantSeq: 4, assistantId: 'assistant-second', text: 'second response' }
    const old = (await persistedLogs(root))[0]!
    expect(lastLogEvent(old)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    expect(hasCompletedTurn(old, expected)).toBe(false)
    let completed = false
    const pending = waitForCompletedTurn(root, expected).then((log) => { completed = true; return log })
    try {
      await new Promise(resolve => setTimeout(resolve, 75))
      expect(completed).toBe(false)
      await writeFile(path, final)
      expect(hasCompletedTurn(await pending, expected)).toBe(true)
      expect(hasCompletedTurn({ ...old, content: final, header: { ...header, id: 'wrong-session' } }, expected)).toBe(false)
      expect(hasCompletedTurn({ ...old, content: final }, { ...expected, assistantId: 'wrong-message' })).toBe(false)
    } finally {
      await writeFile(path, final)
      await pending
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe.skipIf(recording)('TypeScript SDK close paths over the jsonrpc runtime', () => {
  it('replays close-auto-session: the auto-minted session closes when its run settles', async () => {
    const { harness, cwd, sessionsRoot } = await openRuntime({ name: 'close-auto-session', children: 0 })
    try {
      const result = await harness.run('Reply with exactly: SDK snapshot OK')
      const completed = completedTurnOf(result, 'SDK snapshot OK')
      // Automatic close relinquishes the runtime id; independently observe this exact turn's durable commit.
      await expect(harness.client.closeSession(result.sessionId)).rejects.toThrow('unknown session')
      const log = await waitForCompletedTurn(sessionsRoot, completed)
      expect(log.header.id).toBe(result.sessionId)
      expect(closeProbeEvents(log).filter(event => event.type === 'turn/end')).toHaveLength(1)
    } finally {
      await harness.close()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('replays close-named-session: an explicit close releases the named id and keeps its log', async () => {
    const { harness, cwd, sessionsRoot } = await openRuntime({ name: 'close-named-session', children: 0 })
    try {
      const sessionId = 'sdk-snapshot-close-named'
      const result = await harness.run('Reply with exactly: SDK snapshot OK', { sessionId })
      expect(result.sessionId).toBe(sessionId)
      const completed = completedTurnOf(result, 'SDK snapshot OK')
      await harness.client.closeSession(sessionId)
      await expect(harness.client.closeSession(sessionId)).rejects.toThrow('unknown session')
      const log = await waitForCompletedTurn(sessionsRoot, completed)
      expect(log.header.id).toBe(sessionId)
      expect(closeProbeEvents(log).filter(event => event.type === 'turn/end')).toHaveLength(1)
    } finally {
      await harness.close()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('replays close-reprompt: a prompt for a closed id completes durably', async () => {
    const { harness, cwd, sessionsRoot } = await openRuntime({
      name: 'close-reprompt',
      children: 0,
      replayOverride: join(snapshotsDir, 'close-reprompt', 'replay.override.json'),
    })
    try {
      const sessionId = 'sdk-snapshot-close-reprompt'
      // First turn on the named id, then close it: the id is released.
      const first = await harness.run('Reply with exactly: SDK snapshot OK', { sessionId })
      expect(first.sessionId).toBe(sessionId)
      const firstTurn = completedTurnOf(first, 'SDK snapshot OK')
      await harness.client.closeSession(sessionId)
      await expect(harness.client.closeSession(sessionId)).rejects.toThrow('unknown session')
      const firstLog = await waitForCompletedTurn(sessionsRoot, firstTurn)
      // Close releases the Agent, not its persistence identity: the next prompt resumes this exact log.
      const result = await harness.run('Reply with exactly: SDK re-prompt OK', { sessionId })
      expect(result.sessionId).toBe(sessionId)
      const secondTurn = completedTurnOf(result, 'SDK re-prompt OK')
      expect(secondTurn.turn).toBe(firstTurn.turn + 1)
      expect(secondTurn.endSeq).toBeGreaterThan(firstTurn.endSeq)
      expect(secondTurn.assistantId).not.toBe(firstTurn.assistantId)
      const log = await waitForCompletedTurn(sessionsRoot, secondTurn)
      expect(log.path).toBe(firstLog.path)
      expect(log.content.startsWith(firstLog.content)).toBe(true)
      expect(closeProbeEvents(log).filter(event => event.type === 'assistant/message').map(persistedAssistantText))
        .toEqual(['SDK snapshot OK', 'SDK re-prompt OK'])
      expect(closeProbeEvents(log).filter(event => event.type === 'turn/end').map(event => event.data?.turn))
        .toEqual([firstTurn.turn, secondTurn.turn])
    } finally {
      await harness.close()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('replays close-mid-turn: closing mid-turn ends the turn aborted at terminal idle', async () => {
    const { harness, cwd, sessionsRoot } = await openRuntime({
      name: 'close-mid-turn',
      children: 0,
      replayOverride: join(snapshotsDir, 'close-mid-turn', 'replay.override.json'),
    })
    try {
      const sessionId = 'sdk-snapshot-close-mid-turn'
      await harness.start()
      const events: CloseProbeEvent[] = []
      const subscription = harness.client.subscribeSessionTree(sessionId)
      try {
        await harness.client.prompt(sessionId, [{ type: 'text', text: 'Reply with exactly: SDK snapshot OK' }])
        // Deterministic mid-flight gate: the override script streams exactly one
        // chunk, then stalls until the close cancels the model call.
        while (!events.some(event => event.type === 'assistant/chunk')) {
          const notification = await subscription.next()
          if (isProbeSessionEvent(notification, sessionId)) events.push(notification.params.event as CloseProbeEvent)
        }
        await harness.client.closeSession(sessionId)
        while (true) {
          const notification = await subscription.next()
          if (isProbeSessionEvent(notification, sessionId)) events.push(notification.params.event as CloseProbeEvent)
          if (notification.method === 'session.status'
            && notification.params.sessionId === sessionId
            && notification.params.status === 'idle') break
        }
      } finally {
        subscription.close()
      }
      const turnEnd = events.filter(event => event.type === 'turn/end').at(-1)
      expect(turnEnd).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
      const log = await waitForLogTurnEnd(sessionsRoot, sessionId, turnEnd)
      expect(lastLogEvent(log)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'aborted' } },
      })
    } finally {
      await harness.close()
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('replays close-pending: closing before the first streamed chunk still ends the turn aborted', async () => {
    const { harness, cwd, sessionsRoot } = await openRuntime({
      name: 'close-pending',
      children: 0,
      writeOverride: async (runtimeCwd) => {
        // The override hangs BEFORE any streamed chunk, so the model request is
        // still pending when the close lands; the ready file marks the moment
        // the hang began, making the close window deterministic.
        const ready = join(runtimeCwd, '.close-pending-hang-ready')
        const overridePath = join(runtimeCwd, 'close-pending.override.json')
        await writeFile(overridePath, JSON.stringify([{ kind: 'hang', beforeStart: true, readyFile: ready }]))
        return overridePath
      },
    })
    try {
      const sessionId = 'sdk-snapshot-close-pending'
      await harness.start()
      const events: CloseProbeEvent[] = []
      const subscription = harness.client.subscribeSessionTree(sessionId)
      try {
        await harness.client.prompt(sessionId, [{ type: 'text', text: 'Reply with exactly: SDK snapshot OK' }])
        const readyFile = join(cwd, '.close-pending-hang-ready')
        const deadline = Date.now() + 30_000
        while (!existsSync(readyFile)) {
          if (Date.now() > deadline) throw new Error('close-pending probe never reached the hanging model call')
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        await harness.client.closeSession(sessionId)
        while (true) {
          const notification = await subscription.next()
          if (isProbeSessionEvent(notification, sessionId)) events.push(notification.params.event as CloseProbeEvent)
          if (notification.method === 'session.status'
            && notification.params.sessionId === sessionId
            && notification.params.status === 'idle') break
        }
      } finally {
        subscription.close()
      }
      const turnEnd = events.filter(event => event.type === 'turn/end').at(-1)
      expect(turnEnd).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'aborted' } } })
      const log = await waitForLogTurnEnd(sessionsRoot, sessionId, turnEnd)
      expect(lastLogEvent(log)).toMatchObject({
        type: 'turn/end',
        data: { reason: { kind: 'aborted' } },
      })
    } finally {
      await harness.close()
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
