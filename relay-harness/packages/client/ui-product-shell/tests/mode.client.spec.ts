import { Context } from '@relay-harness/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProductShellService } from '../src/client/mode.ts'
import { resolveWorkspaceDeliverable, SIMPLE_MODE_SUPPRESSIONS } from '../src/client/index.ts'

describe('ProductShellService', () => {
  it('keeps Context provenance visible in Simple Mode while suppressing advanced diagnostics', () => {
    expect(SIMPLE_MODE_SUPPRESSIONS).not.toContainEqual(['conversation.session.header.utilities', 'context-inspector'])
    expect(SIMPLE_MODE_SUPPRESSIONS).toContainEqual(['conversation.view', 'trajectory'])
  })
  it('confines model-produced deliverables to the Session workspace', () => {
    expect(resolveWorkspaceDeliverable('/workspace', 'out/report.md')).toBe('/workspace/out/report.md')
    expect(resolveWorkspaceDeliverable('/workspace', '/workspace/report.md')).toBe('/workspace/report.md')
    expect(resolveWorkspaceDeliverable('/workspace', '../secret.txt')).toBeUndefined()
    expect(resolveWorkspaceDeliverable('/workspace', '/etc/passwd')).toBeUndefined()
  })
  afterEach(() => { Reflect.deleteProperty(globalThis, 'window') })
  it('opens simple before the Host answers, folds writes, and reloads after errors', async () => {
    const ctx = new Context()
    const get = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: { mode: 'simple' } })
      .mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: 'offline' } })
    const set = vi.fn().mockResolvedValue({ ok: true, value: { mode: 'developer' } })
    ctx.provide('remote', { productMode: { get, set } } as never)
    const service = new ProductShellService(ctx)
    expect(service.store.getSnapshot().mode).toBe('simple')
    await service.load()
    expect(service.store.getSnapshot()).toEqual({ mode: 'simple', status: 'ready', error: null })
    await service.set('developer')
    expect(set).toHaveBeenCalledWith({ mode: 'developer' })
    expect(service.store.getSnapshot()).toEqual({ mode: 'developer', status: 'ready', error: null })
    await service.load()
    expect(service.store.getSnapshot()).toMatchObject({ mode: 'developer', status: 'error', error: 'offline: offline' })
  })

  it('rolls a rejected write back to the last confirmed mode', async () => {
    const ctx = new Context()
    ctx.provide('remote', { productMode: {
      get: vi.fn(),
      set: vi.fn().mockResolvedValue({ ok: false, error: { code: 'denied', message: 'read only' } }),
    } } as never)
    const service = new ProductShellService(ctx)
    await service.set('developer')
    expect(service.store.getSnapshot()).toMatchObject({ mode: 'simple', status: 'error' })
  })

  it('keeps a fresh Desktop Simple default aligned without inventing Developer mode', async () => {
    const ctx = new Context()
    const set = vi.fn()
    const saveConfig = vi.fn(async () => ({ simpleMode: true }))
    Object.assign(globalThis, { window: { shell: { getConfig: async () => ({ simpleMode: true }), saveConfig } } })
    ctx.provide('remote', { productMode: {
      get: vi.fn().mockResolvedValue({ ok: true, value: { mode: 'simple' } }), set,
    } } as never)
    const service = new ProductShellService(ctx)
    await service.load()
    expect(service.store.getSnapshot().mode).toBe('simple')
    expect(set).not.toHaveBeenCalled()
    expect(saveConfig).toHaveBeenCalledWith({ simpleMode: true })
  })

  it('migrates a legacy explicit Desktop false once and mirrors Developer mode', async () => {
    const ctx = new Context()
    const set = vi.fn().mockResolvedValue({ ok: true, value: { mode: 'developer' } })
    const saveConfig = vi.fn(async () => ({ simpleMode: false }))
    Object.assign(globalThis, { window: { shell: { getConfig: async () => ({ simpleMode: false }), saveConfig } } })
    ctx.provide('remote', { productMode: {
      get: vi.fn().mockResolvedValue({ ok: true, value: { mode: 'simple' } }), set,
    } } as never)
    const service = new ProductShellService(ctx)
    await service.load()
    expect(set).toHaveBeenCalledWith({ mode: 'developer' })
    expect(service.store.getSnapshot().mode).toBe('developer')
    expect(saveConfig).toHaveBeenCalledWith({ simpleMode: false })
  })
})
