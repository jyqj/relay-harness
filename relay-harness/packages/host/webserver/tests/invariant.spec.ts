import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@relay-harness/cordis'
import Invariants from '@relay-harness/rlh-invariants'
import WebServer from '../src/index.ts'
import * as invariant from '../src/invariant.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
})

async function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  await ctx.plugin(Invariants)
  const errors: unknown[] = []
  vi.spyOn(ctx.logger, 'error').mockImplementation((...args: unknown[]) => { errors.push(...args) })
  await ctx.plugin(invariant)
  return { ctx, errors }
}

it('observes a real leaked route after its owner quiesces without registering probe paths', async () => {
  const { ctx, errors } = await harness()
  const owner = await ctx.plugin((scope: Context) => {
    scope.get('webServer')?.register({ kind: 'exact', path: '/__rlh_invariant_probe__', handler: (_req, res) => { res.end('leaked') } })
  })
  expect(errors).toEqual([])
  await owner.dispose()
  await vi.waitFor(() => { expect(errors.map(String).join('\n')).toContain('registration after its owning activation quiesced') })
})

it('does not mistake asynchronous effect cleanup for a leaked route', async () => {
  const { ctx, errors } = await harness()
  let release!: () => void
  const blocker = new Promise<void>((resolve) => { release = resolve })
  const owner = await ctx.plugin((scope: Context) => {
    const remove = scope.get('webServer')!.register({ kind: 'prefix', path: '/owned', handler: () => {} })
    scope.effect(() => async () => { await blocker; remove() })
  })
  const disposing = owner.dispose()
  await Promise.resolve()
  await Promise.resolve()
  expect(errors).toEqual([])
  release()
  await disposing
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(errors).toEqual([])
})


it('finds a leaked activation after same-fiber reload, not just final disposal', async () => {
  const { ctx, errors } = await harness()
  const owner = await ctx.plugin((scope: Context, config: { path: string }) => {
    scope.get('webServer')!.register({ kind: 'exact', path: config.path, handler: () => {} })
  }, { path: '/first-activation' })
  const uid = owner.uid
  await owner.update({ path: '/second-activation' })
  expect(owner.uid).toBe(uid)
  await vi.waitFor(() => { expect(errors.map(String).join(' ')).toContain('owning activation quiesced') })
})

it('covers actual fallback and upgrade ownership without mutating reserved routes', async () => {
  const { ctx, errors } = await harness()
  const owner = await ctx.plugin((scope: Context) => {
    scope.get('webServer')!.registerFallback(() => {})
    scope.get('webServer')!.registerUpgrade({ path: '/__rlh_invariant_upgrade_probe__', handler: () => {} })
    scope.get('webServer')!.tapIndex(html => html)
  })
  expect(errors).toEqual([])
  await owner.dispose()
  await vi.waitFor(() => { expect(errors.map(String).join(' ')).toContain('owning activation quiesced') })
})
