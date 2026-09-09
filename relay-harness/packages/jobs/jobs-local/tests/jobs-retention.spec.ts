import { describe, expect, it } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { Session, SessionId } from '@relay-harness/rlh-session'
import AgentRegistry, { Inbox } from '@relay-harness/rlh-agent'
import type { Agent } from '@relay-harness/rlh-agent'
import type { JobHooks, JobOutcome, JobStart } from '@relay-harness/rlh-jobs'
import LocalJobRegistry, { type Config as JobsConfig } from '@relay-harness/rlh-jobs-local'

const agentScopeDisposers = new WeakMap<Agent, () => Promise<void>>()

function stubAgent(ctx: Context, rawId: string): Agent {
  const id = SessionId(rawId)
  const scopeFiber = ctx.plugin(() => {})
  const agent = {
    id,
    options: {},
    session: Session.create(id),
    inbox: new Inbox(Session.create(id), { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle' as const,
    ctx: scopeFiber.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: <T>(job: (signal: AbortSignal) => Promise<T>) => job(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  agentScopeDisposers.set(agent, async () => { await scopeFiber.dispose() })
  return agent
}

async function disposeAgentScope(agent: Agent): Promise<void> {
  const dispose = agentScopeDisposers.get(agent)
  if (dispose === undefined) throw new Error(`missing test scope for agent "${agent.id}"`)
  await dispose()
}

/** A controllable producer start-spec: settle its `done` on demand. */
function producer(overrides: Partial<Omit<JobStart, 'run'> & JobHooks> = {}) {
  let settle!: (outcome: JobOutcome) => void
  const { kind = 'bash', label = 'sleep 60', owner, outputLimitBytes, ...hookOverrides } = overrides
  const hooks: JobHooks = {
    cancel() {},
    done: new Promise<JobOutcome>((res) => { settle = res }),
    ...hookOverrides,
  }
  const spec: JobStart = {
    kind,
    label,
    ...owner !== undefined ? { owner } : {},
    ...outputLimitBytes !== undefined ? { outputLimitBytes } : {},
    run: () => hooks,
  }
  return { spec, settle }
}

async function harness(config: JobsConfig = {}) {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(LocalJobRegistry, config)
  ctx.jobs.attachController('test-controller')
  return ctx
}

/** Let the settlement continuation (a `done.then`) run. */
const tick = () => new Promise<void>(r => setTimeout(r, 0))

/** Outlast the one-millisecond retention values the cases configure. */
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

describe('LocalJobRegistry terminal retention', () => {
  it('prunes an unowned completed job once its retention grace elapses', async () => {
    const ctx = await harness({ terminalRetentionMs: 1 })
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    // A terminal read claims the completion report; only then may retention drop it.
    expect(ctx.jobs.kill(id)).toBe('already-finished')

    await sleep(5)
    expect(ctx.jobs.list()).toEqual([])
  })

  it('prunes a reported terminal job while its owner agent is still live', async () => {
    const ctx = await harness({ terminalRetentionMs: 1 })
    const owner = stubAgent(ctx, 'owner')
    ctx.agents.register(owner)
    const p = producer({ owner })
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    ctx.jobs.read(id, owner)

    await sleep(5)
    expect(ctx.jobs.list(owner)).toEqual([])
    await disposeAgentScope(owner)
  })

  it('never prunes an unreported terminal record regardless of age', async () => {
    const ctx = await harness({ terminalRetentionMs: 1 })
    const p = producer()
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()

    await sleep(5)
    expect(ctx.jobs.list()).toHaveLength(1)
    expect(ctx.jobs.get(id)).toMatchObject({ status: 'completed', reported: false })
  })

  it('reads a pruned id as a loud unknown-job failure, not an empty result', async () => {
    const ctx = await harness({ terminalRetentionMs: 1 })
    const p = producer({ kind: 'subagent' })
    const id = ctx.jobs.start(p.spec)
    p.settle({ status: 'completed' })
    await tick()
    ctx.jobs.read(id)
    await sleep(5)

    ctx.jobs.list()
    expect(() => ctx.jobs.get(id)).toThrow(`unknown job ${id}`)
    expect(() => ctx.jobs.read(id)).toThrow(`unknown job ${id}`)
    expect(() => ctx.jobs.kill(id)).toThrow(`unknown job ${id}`)
    await expect(ctx.jobs.wait(id, 5)).rejects.toThrow(`unknown job ${id}`)
  })

  it('caps each bucket at maxTerminalRecords by dropping the oldest finished, keeping active jobs', async () => {
    const ctx = await harness({ maxTerminalRecords: 1, terminalRetentionMs: 60_000 })
    const live = producer()
    const liveId = ctx.jobs.start(live.spec)

    const oldest = producer({ kind: 'subagent' })
    const oldestId = ctx.jobs.start(oldest.spec)
    oldest.settle({ status: 'completed' })
    await tick()
    ctx.jobs.read(oldestId)
    await sleep(3)

    const newest = producer({ kind: 'subagent' })
    const newestId = ctx.jobs.start(newest.spec)
    newest.settle({ status: 'completed' })
    await tick()
    ctx.jobs.read(newestId)
    await sleep(3)

    expect(ctx.jobs.list().map(job => job.id)).toEqual([liveId, newestId])
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid terminalRetentionMs config: %s',
    async (terminalRetentionMs) => {
      const ctx = new Context()
      await expect(ctx.plugin(LocalJobRegistry, { terminalRetentionMs }))
        .rejects.toThrow()
    },
  )

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid maxTerminalRecords config: %s',
    async (maxTerminalRecords) => {
      const ctx = new Context()
      await expect(ctx.plugin(LocalJobRegistry, { maxTerminalRecords }))
        .rejects.toThrow()
    },
  )
})
