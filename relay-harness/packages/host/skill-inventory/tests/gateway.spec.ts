import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@relay-harness/cordis'
import { strToU8, zipSync } from 'fflate'
import { bindScopeParent, createScope, scopeOf } from '@relay-harness/rlh-scope'
import SkillRegistry, { type SkillDefinition, type SkillSummary } from '@relay-harness/rlh-skill'
import { remoteMethods, TypertLookupFailure } from '@relay-harness/rlh-typert-protocol'
import SkillInventoryGateway, { parseSkillMarkdown } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function summary(partial: Partial<SkillSummary> & Pick<SkillSummary, 'name'>): SkillSummary {
  return {
    description: partial.description ?? 'desc',
    invocation: partial.invocation ?? { modelInvocable: true, userInvocable: true },
    source: partial.source ?? 'user-rlh',
    provider: partial.provider ?? 'filesystem',
    ...partial,
  }
}

function provideAgents(ctx: Context, entries: ReadonlyMap<string, object> = new Map()): void {
  ctx.provide('agents', {
    get: (id: string) => entries.get(id),
  } as never)
}

describe('SkillInventoryGateway', () => {
  it('publishes catalog and mutation remotes', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    provideAgents(ctx)
    ctx.provide('skills', {
      list: async () => [],
      get: async () => undefined,
      invalidate: () => {},
    } as never)
    await ctx.plugin(SkillInventoryGateway)
    const gateway = ctx.get('skillInventory') as SkillInventoryGateway
    expect(remoteMethods(gateway).map(item => item.method).sort()).toEqual([
      'create', 'delete', 'get', 'importSkill', 'list', 'setInvocation', 'update',
    ])
  })

  it('creates a user-rlh bundle and rejects a non-kebab name', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rlh-skill-inv-'))
    const previous = process.env.RLH_HOME
    process.env.RLH_HOME = home
    const ctx = new Context()
    contexts.push(ctx)
    provideAgents(ctx)
    const catalog: SkillDefinition[] = []
    ctx.provide('skills', {
      list: async () => catalog.map(item => summary(item)),
      get: async (name: string) => catalog.find(item => item.name === name),
      invalidate: () => {},
    } as never)
    await ctx.plugin(SkillInventoryGateway)
    const gateway = ctx.get('skillInventory') as SkillInventoryGateway
    await expect(gateway.create({
      name: 'Not Valid',
      description: 'x',
      content: 'body',
      root: 'user-rlh',
      modelInvocable: true,
      userInvocable: true,
    })).rejects.toThrow(/kebab-case/)
    await gateway.create({
      name: 'demo-skill',
      description: 'A demo',
      content: 'Do it',
      root: 'user-rlh',
      modelInvocable: false,
      userInvocable: false,
    })
    const written = await readFile(join(home, 'skills', 'demo-skill', 'SKILL.md'), 'utf8')
    expect(written).toContain('name: demo-skill')
    expect(written).toContain('disable-model-invocation: true')
    expect(written).toContain('user-invocable: false')
    expect(written).toContain('Do it')
    if (previous === undefined) delete process.env.RLH_HOME
    else process.env.RLH_HOME = previous
  })

  it('imports a local skill bundle with explicit unsigned trust, source, version, and permissions', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rlh-skill-import-home-'))
    const source = await mkdtemp(join(tmpdir(), 'rlh-skill-import-source-'))
    await writeFile(join(source, 'SKILL.md'), '---\nname: imported-skill\ndescription: Imported\n---\n\nImported body\n', 'utf8')
    const previous = process.env.RLH_HOME
    process.env.RLH_HOME = home
    const ctx = new Context()
    contexts.push(ctx)
    provideAgents(ctx)
    const invalidate = vi.fn()
    ctx.provide('skills', { list: async () => [], get: async () => undefined, invalidate } as never)
    await ctx.plugin(SkillInventoryGateway)
    const gateway = ctx.get('skillInventory') as SkillInventoryGateway
    const detail = await gateway.importSkill({
      kind: 'local', location: source, root: 'user-rlh', version: 'v1',
      permissions: ['filesystem:read'],
    }, new AbortController().signal)
    expect(detail).toMatchObject({
      name: 'imported-skill', version: 'v1', permissions: ['filesystem:read'],
      trust: 'unsigned-local', health: 'healthy',
      installSource: `local:${source}`,
    })
    const parsed = parseSkillMarkdown(await readFile(join(home, 'skills', 'imported-skill', 'SKILL.md'), 'utf8'))
    expect(parsed.data.metadata).toMatchObject({
      'rlh-install-source': `local:${source}`,
      'rlh-install-version': 'v1',
      'rlh-permissions': ['filesystem:read'],
      'rlh-trust': 'unsigned-local',
    })
    expect(invalidate).toHaveBeenCalledOnce()
    if (previous === undefined) delete process.env.RLH_HOME
    else process.env.RLH_HOME = previous
  })

  it('rejects symlinked import payloads, unsafe ZIP paths, and invalid permission declarations', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rlh-skill-secure-home-'))
    const source = await mkdtemp(join(tmpdir(), 'rlh-skill-secure-source-'))
    const external = await mkdtemp(join(tmpdir(), 'rlh-skill-secure-external-'))
    await mkdir(join(source, 'secure-skill'))
    await writeFile(join(source, 'secure-skill', 'SKILL.md'), '---\nname: secure-skill\ndescription: Secure\n---\n\nBody\n')
    await writeFile(join(external, 'secret.txt'), 'secret')
    await symlink(join(external, 'secret.txt'), join(source, 'secure-skill', 'linked.txt'))
    const zip = join(source, 'unsafe.zip')
    await writeFile(zip, zipSync({
      '../escape.txt': strToU8('escape'),
      'safe/SKILL.md': strToU8('---\nname: safe\ndescription: Safe\n---\n\nBody\n'),
    }))
    const previous = process.env.RLH_HOME; process.env.RLH_HOME = home
    const ctx = new Context(); contexts.push(ctx); provideAgents(ctx)
    ctx.provide('skills', { list: async () => [], get: async () => undefined, invalidate: () => {} } as never)
    await ctx.plugin(SkillInventoryGateway)
    const gateway = ctx.get('skillInventory') as SkillInventoryGateway
    await expect(gateway.importSkill({
      kind: 'local', location: source, skillPath: 'secure-skill', root: 'user-rlh', permissions: [],
    }, new AbortController().signal)).rejects.toThrow(/symbolic links/u)
    await expect(gateway.importSkill({
      kind: 'zip', location: zip, root: 'user-rlh', permissions: [],
    }, new AbortController().signal)).rejects.toThrow(/unsafe ZIP path/u)
    await expect(gateway.importSkill({
      kind: 'local', location: source, skillPath: 'secure-skill', root: 'user-rlh', permissions: ['../../escape'],
    }, new AbortController().signal)).rejects.toThrow(/invalid declared permission/u)
    if (previous === undefined) delete process.env.RLH_HOME
    else process.env.RLH_HOME = previous
  })

  it('fetches an explicit GitHub ref and records the same unsigned version', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rlh-skill-github-home-'))
    const bytes = zipSync({
      'repo-v1/github-skill/SKILL.md': strToU8('---\nname: github-skill\ndescription: GitHub\n---\n\nBody\n'),
    })
    const fetchMock = vi.fn(async (_input: string | URL | Request) => new Response(bytes, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const previous = process.env.RLH_HOME; process.env.RLH_HOME = home
    const ctx = new Context(); contexts.push(ctx); provideAgents(ctx)
    ctx.provide('skills', { list: async () => [], get: async () => undefined, invalidate: () => {} } as never)
    await ctx.plugin(SkillInventoryGateway)
    const detail = await (ctx.get('skillInventory') as SkillInventoryGateway).importSkill({
      kind: 'github', location: 'https://github.com/example/repo', version: 'v1.2.3',
      root: 'user-rlh', skillPath: 'repo-v1/github-skill', permissions: ['filesystem:read'],
    }, new AbortController().signal)
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://codeload.github.com/example/repo/zip/v1.2.3')
    expect(detail).toMatchObject({ version: 'v1.2.3', trust: 'unsigned-local' })
    vi.unstubAllGlobals()
    if (previous === undefined) delete process.env.RLH_HOME
    else process.env.RLH_HOME = previous
  })

  it('invalidates the registry cache after every successful write', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rlh-skill-inv-'))
    const previous = process.env.RLH_HOME
    process.env.RLH_HOME = home
    const ctx = new Context()
    contexts.push(ctx)
    provideAgents(ctx)
    const catalog: SkillDefinition[] = []
    const invalidate = vi.fn()
    ctx.provide('skills', {
      list: async () => catalog.map(item => summary(item)),
      get: async (name: string) => catalog.find(item => item.name === name),
      invalidate,
    } as never)
    await ctx.plugin(SkillInventoryGateway)
    const gateway = ctx.get('skillInventory') as SkillInventoryGateway
    await gateway.create({
      name: 'demo-skill',
      description: 'A demo',
      content: 'Do it',
      root: 'user-rlh',
      modelInvocable: true,
      userInvocable: true,
    })
    catalog.push({
      name: 'demo-skill',
      description: 'A demo',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'user-rlh',
      provider: 'filesystem',
      path: join(home, 'skills', 'demo-skill', 'SKILL.md'),
      content: 'Do it',
    })
    expect(invalidate).toHaveBeenCalledTimes(1)
    await gateway.update({
      name: 'demo-skill',
      description: 'Updated',
      content: 'New body',
      modelInvocable: true,
      userInvocable: true,
    })
    expect(invalidate).toHaveBeenCalledTimes(2)
    await gateway.setInvocation({ name: 'demo-skill', modelInvocable: false, userInvocable: true })
    expect(invalidate).toHaveBeenCalledTimes(3)
    await gateway.delete({ name: 'demo-skill' })
    expect(invalidate).toHaveBeenCalledTimes(4)
    // A rejected write must not invalidate: kebab-case guard fires first.
    await expect(gateway.create({
      name: 'Bad Name',
      description: 'x',
      content: 'body',
      root: 'user-rlh',
      modelInvocable: true,
      userInvocable: true,
    })).rejects.toThrow(/kebab-case/)
    expect(invalidate).toHaveBeenCalledTimes(4)
    if (previous === undefined) delete process.env.RLH_HOME
    else process.env.RLH_HOME = previous
  })

  it('lists, updates, and toggles a writable skill', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rlh-skill-inv-'))
    const previous = process.env.RLH_HOME
    process.env.RLH_HOME = home
    const ctx = new Context()
    contexts.push(ctx)
    provideAgents(ctx)
    const catalog: SkillDefinition[] = []
    ctx.provide('skills', {
      list: async () => catalog.map(item => summary(item)),
      get: async (name: string) => catalog.find(item => item.name === name),
      invalidate: () => {},
    } as never)
    await ctx.plugin(SkillInventoryGateway)
    const gateway = ctx.get('skillInventory') as SkillInventoryGateway
    await gateway.create({
      name: 'demo-skill',
      description: 'A demo',
      whenToUse: 'When testing',
      content: 'Do it',
      root: 'user-rlh',
      modelInvocable: true,
      userInvocable: true,
    })
    catalog.push({
      name: 'demo-skill',
      description: 'A demo',
      whenToUse: 'When testing',
      invocation: { modelInvocable: true, userInvocable: true },
      source: 'user-rlh',
      provider: 'filesystem',
      path: join(home, 'skills', 'demo-skill', 'SKILL.md'),
      content: 'Do it',
    })
    const path = join(home, 'skills', 'demo-skill', 'SKILL.md')
    await writeFile(path, '---\nname: demo-skill\ndescription: A demo\nwhenToUse: When testing\nmetadata:\n  owner: custom-provider\ncustomFlag: retained\n---\n\nDo it\n', 'utf8')
    const listed = await gateway.list({})
    expect(listed.skills[0]).toMatchObject({ name: 'demo-skill', writable: true })
    const detail = await gateway.get({ name: 'demo-skill' })
    expect(detail.content).toContain('Do it')
    await gateway.update({
      name: 'demo-skill',
      description: 'Updated',
      whenToUse: 'Updated hint',
      content: 'New body',
      modelInvocable: false,
      userInvocable: false,
    })
    let written = parseSkillMarkdown(await readFile(path, 'utf8'))
    expect(written.data).toMatchObject({
      name: 'demo-skill',
      description: 'Updated',
      whenToUse: 'Updated hint',
      'disable-model-invocation': true,
      'user-invocable': false,
      metadata: { owner: 'custom-provider' },
      customFlag: 'retained',
    })
    await gateway.setInvocation({
      name: 'demo-skill',
      modelInvocable: true,
      userInvocable: false,
    })
    written = parseSkillMarkdown(await readFile(path, 'utf8'))
    expect(written.data).toMatchObject({
      name: 'demo-skill',
      description: 'Updated',
      whenToUse: 'Updated hint',
      'user-invocable': false,
      metadata: { owner: 'custom-provider' },
      customFlag: 'retained',
    })
    expect(written.data).not.toHaveProperty('disable-model-invocation')
    await gateway.delete({ name: 'demo-skill' })
    if (previous === undefined) delete process.env.RLH_HOME
    else process.env.RLH_HOME = previous
  })

  it('creates a project skill and refuses create without cwd', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'rlh-skill-proj-'))
    await mkdir(join(cwd, '.git'))
    const ctx = new Context()
    contexts.push(ctx)
    const sessionId = 'project-session'
    provideAgents(ctx, new Map([[sessionId, { id: sessionId, session: { header: { cwd } } }]]))
    ctx.provide('skills', {
      list: async () => [],
      get: async () => undefined,
      invalidate: () => {},
    } as never)
    await ctx.plugin(SkillInventoryGateway)
    const gateway = ctx.get('skillInventory') as SkillInventoryGateway
    await expect(gateway.create({
      name: 'proj-skill',
      description: 'P',
      content: 'body',
      root: 'project-rlh',
      modelInvocable: true,
      userInvocable: true,
    })).rejects.toThrow(/requires cwd/)
    await gateway.create({
      name: 'proj-skill',
      description: 'P',
      content: 'body',
      root: 'project-rlh',
      modelInvocable: true,
      userInvocable: true,
      cwd,
      sessionId,
    })
    expect(await readFile(join(cwd, '.rlh', 'skills', 'proj-skill', 'SKILL.md'), 'utf8')).toContain('name: proj-skill')
  })

  it('creates a project skill at the nearest git root for a nested cwd', async () => {
    const project = await mkdtemp(join(tmpdir(), 'rlh-skill-proj-root-'))
    const cwd = join(project, 'packages', 'app')
    await mkdir(join(project, '.git'))
    await mkdir(cwd, { recursive: true })
    const ctx = new Context()
    contexts.push(ctx)
    const sessionId = 'nested-project-session'
    provideAgents(ctx, new Map([[sessionId, { id: sessionId, session: { header: { cwd } } }]]))
    ctx.provide('skills', {
      list: async () => [],
      get: async () => undefined,
      invalidate: () => {},
    } as never)
    await ctx.plugin(SkillInventoryGateway)
    const gateway = ctx.get('skillInventory') as SkillInventoryGateway
    await gateway.create({
      name: 'nested-project-skill',
      description: 'Nested project skill',
      content: 'body',
      root: 'project-rlh',
      modelInvocable: true,
      userInvocable: true,
      cwd,
      sessionId,
    })
    expect(await readFile(
      join(project, '.rlh', 'skills', 'nested-project-skill', 'SKILL.md'),
      'utf8',
    )).toContain('name: nested-project-skill')
  })

  it('lists preset-scoped skills through the requested live session', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(SkillRegistry)
    const preset = createScope(ctx, { preset: 'standard' })
    const presetSkills = preset.ctx.get('skills')
    if (presetSkills === undefined) throw new Error('skills service missing')
    presetSkills.register({
      name: 'preset-only',
      description: 'Scoped to the standard preset',
      source: 'bundled',
      content: 'Preset body.',
    })
    const sessionId = 'settings-live-session'
    const agent = { id: sessionId }
    const presetScope = scopeOf(preset.ctx)
    if (presetScope === undefined) throw new Error('preset scope missing')
    bindScopeParent(agent, presetScope)
    provideAgents(ctx, new Map([[sessionId, agent]]))
    await ctx.plugin(SkillInventoryGateway)
    const gateway = ctx.get('skillInventory') as SkillInventoryGateway

    expect((await gateway.list({})).skills).toEqual([])
    await expect(gateway.list({ sessionId })).resolves.toMatchObject({
      skills: [{ name: 'preset-only', source: 'bundled', writable: false }],
    })
    await expect(gateway.get({ name: 'preset-only', sessionId })).resolves.toMatchObject({
      name: 'preset-only',
      content: 'Preset body.',
    })
  })

  it('uses a live preset realm skill registry when the host registry cannot see it', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const agent = { id: 'realm-session' }
    const realmSkill = summary({ name: 'realm-only', source: 'bundled', provider: 'preset-filesystem' })
    const definition: SkillDefinition = {
      ...realmSkill,
      content: 'Realm body.',
    }
    provideAgents(ctx, new Map([[agent.id, agent]]))
    ctx.provide('skills', {
      list: async () => [],
      get: async () => undefined,
      invalidate: () => {},
    } as never)
    const realmRegistry = {
      list: async () => [realmSkill],
      get: async (name: string) => name === realmSkill.name ? definition : undefined,
    }
    const serviceFor = vi.fn((requestedAgent: object, name: string) => {
      expect(requestedAgent).toBe(agent)
      return name === 'skills' ? realmRegistry : undefined
    })
    ctx.provide('agentPresets', { serviceFor } as never)
    await ctx.plugin(SkillInventoryGateway)
    const gateway = ctx.get('skillInventory') as SkillInventoryGateway

    await expect(gateway.list({ sessionId: agent.id })).resolves.toMatchObject({
      skills: [{ name: 'realm-only', provider: 'preset-filesystem', writable: false }],
    })
    await expect(gateway.get({ name: 'realm-only', sessionId: agent.id })).resolves.toMatchObject({
      content: 'Realm body.',
    })
    expect(serviceFor).toHaveBeenCalledTimes(2)
  })

  it('rejects a supplied session id when no live agent exists', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    provideAgents(ctx)
    ctx.provide('skills', {
      list: async () => [],
      get: async () => undefined,
      invalidate: () => {},
    } as never)
    await ctx.plugin(SkillInventoryGateway)
    const gateway = ctx.get('skillInventory') as SkillInventoryGateway
    const sessionId = 'missing-live-session'

    const failure = await gateway.list({ sessionId }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(TypertLookupFailure)
    expect((failure as TypertLookupFailure).failure).toEqual({
      code: 'session-not-found',
      message: `session "${sessionId}" not found (not attached)`,
      details: { sessionId },
    })
  })

  it('rejects a Client cwd that differs from the attached Session workspace', async () => {
    const ctx = new Context(); contexts.push(ctx)
    const sessionId = 'scope-session'
    provideAgents(ctx, new Map([[sessionId, { id: sessionId, session: { header: { cwd: '/workspace/a' } } }]]))
    ctx.provide('skills', { list: async () => [], get: async () => undefined, invalidate: () => {} } as never)
    await ctx.plugin(SkillInventoryGateway)
    await expect((ctx.get('skillInventory') as SkillInventoryGateway).list({
      sessionId, cwd: '/workspace/b',
    })).rejects.toThrow(/lookup policy rejected/u)
  })

  it('rejects a writable-looking provider path outside its owned source root', async () => {
    const home = await mkdtemp(join(tmpdir(), 'rlh-skill-owned-home-'))
    const outside = await mkdtemp(join(tmpdir(), 'rlh-skill-owned-outside-'))
    await mkdir(join(home, 'skills'), { recursive: true })
    const outsideFile = join(outside, 'SKILL.md')
    await writeFile(outsideFile, '---\nname: forged-skill\ndescription: Forged\n---\n\nBody\n')
    const previous = process.env.RLH_HOME; process.env.RLH_HOME = home
    const ctx = new Context(); contexts.push(ctx); provideAgents(ctx)
    ctx.provide('skills', {
      list: async () => [summary({ name: 'forged-skill', source: 'user-rlh' })],
      get: async () => ({
        name: 'forged-skill', description: 'Forged', invocation: { modelInvocable: true, userInvocable: true },
        source: 'user-rlh', provider: 'forged', path: outsideFile, content: 'Body',
      }), invalidate: () => {},
    } as never)
    await ctx.plugin(SkillInventoryGateway)
    await expect((ctx.get('skillInventory') as SkillInventoryGateway).delete({ name: 'forged-skill' }))
      .rejects.toThrow(/escapes its owned/u)
    expect(await readFile(outsideFile, 'utf8')).toContain('forged-skill')
    if (previous === undefined) delete process.env.RLH_HOME
    else process.env.RLH_HOME = previous
  })

  it('refuses to mutate a bundled skill', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    provideAgents(ctx)
    ctx.provide('skills', {
      list: async () => [],
      get: async (name: string) => name === 'bundled-one'
        ? ({
          name: 'bundled-one',
          description: 'shipped',
          invocation: { modelInvocable: true, userInvocable: true },
          source: 'bundled',
          provider: 'filesystem',
          path: '/app/skills/bundled-one/SKILL.md',
          content: 'shipped',
        } satisfies SkillDefinition)
        : undefined,
      invalidate: () => {},
    } as never)
    await ctx.plugin(SkillInventoryGateway)
    const gateway = ctx.get('skillInventory') as SkillInventoryGateway
    await expect(gateway.delete({ name: 'bundled-one' })).rejects.toThrow(/read-only/)
    await expect(gateway.get({ name: 'Not Valid' })).rejects.toThrow(/kebab-case/)
    await expect(gateway.get({ name: 'missing-skill' })).rejects.toThrow(/was not found/)
  })
})
