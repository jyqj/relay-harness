import { fileURLToPath } from 'node:url'
import { Context } from '@relay-harness/cordis'
import { agentEvents, Inbox, type Agent } from '@relay-harness/rlh-agent'
import { CallId } from '@relay-harness/rlh-llm'
import { boot, loadOverlayPatches } from '@relay-harness/rlh-app-boot'
import { SessionId } from '@relay-harness/rlh-session'
import type {} from '@relay-harness/rlh-skill'
import type {} from '@relay-harness/rlh-tools'

const overlayPath = process.argv[2]
if (overlayPath === undefined) throw new Error('rlh-badge snapshot requires an overlay path')
const rootConfigPath = fileURLToPath(new URL('../../../../../packages/bundle/base/tests/fixtures/root.cordis.yml', import.meta.url))
const basePatchPath = fileURLToPath(new URL('../../../../../packages/bundle/base/cordis.patch.yml', import.meta.url))
const ctx = await boot('rlh-badge-snapshot', rootConfigPath, [
  ...loadOverlayPatches('rlh-badge-snapshot', basePatchPath),
  ...loadOverlayPatches('rlh-badge-snapshot', overlayPath),
])

try {
  const agentId = SessionId('rlh-badge-snapshot')
  const session = ctx.sessions.create(agentId, { meta: { cwd: process.cwd() } })
  const agent: Agent = {
    ctx: new Context(),
    id: agentId,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('rlh-badge snapshot must receive the catalog at the step boundary') },
    cancel: () => {},
    runMaintenance: job => job(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
  const catalog = decision.kind === 'enter'
    ? decision.messages.find(message => message.role === 'user'
      && message.source.kind === 'skill-catalog')?.content
    : undefined
  const summary = (await ctx.skills.list()).find(skill => skill.name === 'rlh-badge')
  const result = await ctx.tools.execute({
    callId: CallId('rlh-badge-snapshot'),
    name: 'skill',
    arguments: { name: 'rlh-badge' },
    signal: new AbortController().signal,
  })
  process.stdout.write(`${JSON.stringify({ catalog: catalog ?? null, summary: summary ?? null, result })}\n`)
} finally {
  await ctx.fiber.dispose()
}
