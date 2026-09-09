/** Mentioned-file content injection through the step-context seam. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@relay-harness/cordis'
import type { Fiber } from '@relay-harness/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AgentRegistry from '@relay-harness/rlh-agent'
import ContextEngine, { EvidenceId, SourceId } from '@relay-harness/rlh-context-engine'
import LocalFileSystem from '@relay-harness/rlh-fs-local'
import { createUserMessage } from '@relay-harness/rlh-llm'
import type { UserMessage } from '@relay-harness/rlh-llm'
import SessionStore, { SessionId } from '@relay-harness/rlh-session'
import SystemPrompt from '@relay-harness/rlh-system-prompt'
import ToolRegistry from '@relay-harness/rlh-tools'
import LocalFileReferenceService from '../src/index.ts'
import type { Config } from '../src/index.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'rlh-file-reference-content-'))
  roots.push(root)
  return root
}

async function agentHarness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  return ctx
}

async function harness(fileContent: Config['fileContent'] = {}): Promise<{ ctx: Context; service: Fiber }> {
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  const service = ctx.plugin(LocalFileReferenceService, { fileContent })
  await service
  await ctx.plugin(ContextEngine)
  ctx.sessions.create(SessionId('content-agent'))
  return { ctx, service }
}

function step(ctx: Context, cwd: string, messages: UserMessage[]) {
  return ctx.get('contextEngine')!.prepareStep({
    purpose: 'agent_step',
    messages,
    signal: new AbortController().signal,
    cwd,
    caller: { sessionId: SessionId('content-agent'), agentId: 'content-agent', workspaceId: cwd, turn: 1, step: 1 },
  })
}

function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

function promptText(message: UserMessage): string {
  return message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
}

describe('FileReferenceContentContributor', () => {
  it('contributes nothing when no direct user message mentions a file', async () => {
    const { ctx } = await harness()
    const pluginEcho = createUserMessage({
      content: [{ type: 'text', text: 'see @plugin-only.txt' }],
      source: { kind: 'plugin', plugin: 'fixture' },
    })
    await expect(step(ctx, '/tmp', [
      userMessage('plain question'),
      pluginEcho,
      createUserMessage({
        content: [{ type: 'reasoning', text: '@reasoning-only.txt' }],
        source: { kind: 'user' },
      }),
    ])).resolves.toBeUndefined()
  })

  it('reads every distinct mention into one recall message with revision-bound evidence', async () => {
    const { ctx } = await harness()
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'alpha\n', 'utf8')
    await writeFile(join(root, 'a b.txt'), 'beta\n', 'utf8')
    const absolute = join(root, 'a.txt')
    const spacedPath = join(root, 'a b.txt')
    const aVersion = String((await ctx.fs.stat(await ctx.fs.resolve(absolute)))!.version)
    const spacedVersion = String((await ctx.fs.stat(await ctx.fs.resolve(spacedPath)))!.version)

    const contributed = await step(ctx, root, [
      userMessage('open @"a b.txt" and @a.txt'),
      userMessage('also @a.txt again'),
      userMessage(`and the absolute ${absolute}`),
    ])
    expect(contributed).toBeDefined()
    expect(contributed!.decisions).toContainEqual(expect.objectContaining({
      contributorId: 'file-reference-content', outcome: 'selected', priority: 'explicit-reference',
    }))
    const source = contributed!.messages[0]!.source
    expect(source).toMatchObject({ kind: 'file-reference', form: 'recall', version: 1, cwd: root })
    if (source.kind !== 'file-reference') throw new Error('unreachable')
    expect(source.files).toEqual([
      { path: 'a b.txt', resolvedPath: spacedPath, revision: spacedVersion, bytes: 5, truncated: false },
      { path: 'a.txt', resolvedPath: absolute, revision: aVersion, bytes: 6, truncated: false },
    ])
    const text = promptText(contributed!.messages[0]!)
    expect(text).toContain('read-only snapshots of the files the user explicitly')
    expect(text).toContain('### a b.txt')
    expect(text).toContain('beta')
    expect(text).toContain('alpha')
    expect(contributed!.evidence).toEqual([
      {
        evidenceId: EvidenceId(`file-reference:${spacedPath}`),
        resource: { sourceId: SourceId('file-reference-local'), key: spacedPath, revision: spacedVersion },
        digest: createHash('sha256').update('beta\n').digest('hex'),
        truncated: false,
        freshness: 'current',
        verification: 'unverified',
      },
      {
        evidenceId: EvidenceId(`file-reference:${absolute}`),
        resource: { sourceId: SourceId('file-reference-local'), key: absolute, revision: aVersion },
        digest: createHash('sha256').update('alpha\n').digest('hex'),
        truncated: false,
        freshness: 'current',
        verification: 'unverified',
      },
    ])
  })

  it('records unavailable reasons for missing paths, directories, and unreadable files', async () => {
    const { ctx } = await harness()
    const root = await workspace()
    await writeFile(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0xff, 0xfe]))
    await mkdir(join(root, 'sub'))

    const contributed = await step(ctx, root, [userMessage('check @missing.txt and @sub plus @blob.bin')])
    const source = contributed!.messages[0]!.source
    if (source.kind !== 'file-reference') throw new Error('unreachable')
    expect(source.files).toEqual([
      { path: 'missing.txt', truncated: false, unavailable: 'missing' },
      { path: 'sub', truncated: false, unavailable: 'not a regular file: directory' },
      { path: 'blob.bin', truncated: false, unavailable: 'FS_NOT_TEXT' },
    ])
    const text = promptText(contributed!.messages[0]!)
    expect(text).toContain('### missing.txt')
    expect(text).toContain('unavailable: missing')
    expect(text).toContain('unavailable: FS_NOT_TEXT')
    expect(contributed!.evidence).toEqual([])
  })

  it('truncates at the per-file and total byte budgets and stops after them', async () => {
    const { ctx } = await harness({ maxFileBytes: 5, maxTotalBytes: 8 })
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'aaaaaaaaaa')
    await writeFile(join(root, 'b.txt'), 'bbbbbbbbbb')
    await writeFile(join(root, 'c.txt'), 'cc')

    const contributed = await step(ctx, root, [userMessage('@a.txt @b.txt @c.txt')])
    const source = contributed!.messages[0]!.source
    if (source.kind !== 'file-reference') throw new Error('unreachable')
    expect(source.files).toEqual([
      { path: 'a.txt', resolvedPath: join(root, 'a.txt'), revision: expect.any(String) as string, bytes: 5, truncated: true },
      { path: 'b.txt', resolvedPath: join(root, 'b.txt'), revision: expect.any(String) as string, bytes: 3, truncated: true },
      { path: 'c.txt', truncated: true, unavailable: 'total budget exceeded' },
    ])
    const text = promptText(contributed!.messages[0]!)
    expect(text).toContain('aaaaa')
    expect(text).toContain('bbb')
    expect(text).toContain('unavailable: total budget exceeded')
    expect(contributed!.evidence.map(record => record.digest)).toEqual([
      createHash('sha256').update('aaaaa').digest('hex'),
      createHash('sha256').update('bbb').digest('hex'),
    ])
  })

  it('splits multibyte characters on byte boundaries without replacement characters', async () => {
    const { ctx } = await harness({ maxFileBytes: 3, maxTotalBytes: 64 })
    const root = await workspace()
    await writeFile(join(root, 'u.txt'), 'ééé', 'utf8')

    const contributed = await step(ctx, root, [userMessage('@u.txt')])
    const source = contributed!.messages[0]!.source
    if (source.kind !== 'file-reference') throw new Error('unreachable')
    expect(source.files[0]).toMatchObject({ path: 'u.txt', bytes: 3, truncated: true })
    const text = promptText(contributed!.messages[0]!)
    expect(text).toContain('é')
    expect(text).not.toContain('�')
    expect(contributed!.evidence[0]!.digest).toBe(createHash('sha256').update('é').digest('hex'))
  })

  it('extends the snapshot fence past backtick runs in file content', async () => {
    const { ctx } = await harness()
    const root = await workspace()
    const fencePath = join(root, 'fence.md')
    await writeFile(fencePath, 'before ``` mid ```` after\n')

    const contributed = await step(ctx, root, [userMessage(`@${fencePath}`)])
    const text = promptText(contributed!.messages[0]!)
    expect(text).toContain('`````\nbefore ``` mid ```` after\n\n`````')
  })

  it('records non-filesystem read failures as unavailable', async () => {
    const { ctx } = await harness()
    const root = await workspace()
    const failing = vi.spyOn(ctx.fs, 'resolve').mockRejectedValue(new Error('un_mountable'))

    const contributed = await step(ctx, root, [userMessage('@a.txt')])
    const source = contributed!.messages[0]!.source
    if (source.kind !== 'file-reference') throw new Error('unreachable')
    expect(source.files).toEqual([{ path: 'a.txt', truncated: false, unavailable: 'read failed' }])
    expect(promptText(contributed!.messages[0]!)).toContain('unavailable: read failed')
    expect(contributed!.evidence).toEqual([])
    failing.mockRestore()
  })

  it('fills omitted budget fields from the defaults and rejects invalid ones', async () => {
    const defaults = await agentHarness()
    new LocalFileReferenceService(defaults, { fileContent: {} })

    const badFileBytes = await agentHarness()
    expect(() => new LocalFileReferenceService(badFileBytes, { fileContent: { maxFileBytes: 0 } }))
      .toThrow('fileContent.maxFileBytes')
    const fractionalTotal = await agentHarness()
    expect(() => new LocalFileReferenceService(fractionalTotal, { fileContent: { maxTotalBytes: 1.5 } }))
      .toThrow('fileContent.maxTotalBytes')
  })

  it('removes the contributor when the service fiber is disposed', async () => {
    const { ctx, service } = await harness()
    const root = await workspace()
    await writeFile(join(root, 'a.txt'), 'alpha')
    await expect(step(ctx, root, [userMessage('@a.txt')])).resolves.toBeDefined()
    await service.dispose()
    await expect(step(ctx, root, [userMessage('@a.txt')])).resolves.toBeUndefined()
  })

  it('propagates read failures of an aborted step instead of recording them', async () => {
    const { ctx } = await harness()
    const root = await workspace()
    await writeFile(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0xff, 0xfe]))
    const controller = new AbortController()
    controller.abort()
    await expect(ctx.get('contextEngine')!.prepareStep({
      purpose: 'agent_step',
      messages: [userMessage('@blob.bin')],
      signal: controller.signal,
      cwd: root,
      caller: { sessionId: SessionId('content-agent'), agentId: 'content-agent', workspaceId: root, turn: 1, step: 1 },
    })).rejects.toThrow()
  })

  it('fails loud when no filesystem service backs the injection', async () => {
    const ctx = await agentHarness()
    await ctx.plugin(LocalFileReferenceService, { fileContent: {} })
    await ctx.plugin(ContextEngine)
    const root = await workspace()
    await expect(ctx.get('contextEngine')!.prepareStep({
      purpose: 'agent_step',
      messages: [userMessage('@a.txt')],
      signal: new AbortController().signal,
      cwd: root,
      caller: { sessionId: SessionId('content-agent'), agentId: 'content-agent', workspaceId: root, turn: 1, step: 1 },
    })).rejects.toMatchObject({
      code: 'CONTEXT_ENGINE_INVALID_CONTRIBUTOR',
      message: 'file-reference-local: file-content injection requires a filesystem service',
    })
  })
})
