/**
 * Host Remote for listing and mutating filesystem-backed skills.
 * @module @relay-harness/rlh-host-skill-inventory
 */

import { access, cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { unzipSync } from 'fflate'
import type { Context } from '@relay-harness/cordis'
import { resolveRlhHome } from '@relay-harness/rlh-home-paths'
import { writeFileAtomic } from '@relay-harness/rlh-atomic-write'
import { isSkillName, type SkillDefinition, type SkillRegistry, type SkillSummary, type SkillViewOptions } from '@relay-harness/rlh-skill'
import type {} from '@relay-harness/rlh-skill'
import { TypertLookupFailure, TypertRemoteService, Remote } from '@relay-harness/rlh-typert-protocol'
import type {} from 'zod'
import { parseSkillMarkdown, renderSkillInvocationMarkdown, renderSkillMarkdown } from './frontmatter.ts'
import type {
  SkillInventoryCreateRequest,
  SkillInventoryDetail,
  SkillInventoryEntry,
  SkillInventoryGetRequest,
  SkillInventoryInvocationRequest,
  SkillInventoryImportRequest,
  SkillInventoryRemoveRequest,
  SkillInventoryScope,
  SkillInventorySnapshot,
  SkillInventoryUpdateRequest,
} from './types.ts'

export type * from './types.ts'
export { parseSkillMarkdown, renderSkillMarkdown } from './frontmatter.ts'

const WRITABLE_ALWAYS = new Set(['user-rlh', 'user-agents'])
const WRITABLE_WITH_CWD = new Set(['project-rlh', 'project-agents'])
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024
const MAX_EXPANDED_BYTES = 64 * 1024 * 1024
const MAX_ARCHIVE_FILES = 2_048
const MAX_PERMISSION_COUNT = 32
const MAX_PERMISSION_CHARS = 64
const MAX_LOCATION_CHARS = 2_048

interface ResolvedSkillView {
  readonly registry: SkillRegistry
  readonly options: SkillViewOptions
}

/** Remote-only skill catalog and file mutations for Settings. */
export class SkillInventoryGateway extends TypertRemoteService {
  static inject = ['agents', 'skills']

  /**
   * @param ctx - host context carrying the skill registry.
   */
  constructor(ctx: Context) {
    super(ctx, 'skillInventory')
  }

  /**
   * List every discovered skill, including non-user-invocable ones.
   * @param request - optional project cwd.
   * @returns the catalog snapshot for Settings.
   */
  @Remote('list')
  async list(request: SkillInventoryScope): Promise<SkillInventorySnapshot> {
    const view = this.resolveView(request)
    const snapshot = typeof (view.registry as { snapshot?: unknown }).snapshot === 'function'
      ? await view.registry.snapshot(view.options)
      : { skills: await view.registry.list(view.options), complete: true }
    const skills = snapshot.skills
    const entries: SkillInventoryEntry[] = []
    for (const summary of skills) {
      const detail = await view.registry.get(summary.name, view.options)
      entries.push(toEntry(summary, detail, view.options.cwd, snapshot.complete))
    }
    return { skills: entries, ...view.options.cwd === undefined ? {} : { cwd: view.options.cwd } }
  }

  /**
   * Load one skill body for the editor.
   * @param request - name and optional cwd.
   * @returns the skill detail for the editor.
   */
  @Remote('get')
  async get(request: SkillInventoryGetRequest): Promise<SkillInventoryDetail> {
    const view = this.resolveView(request)
    const definition = await this.requireSkill(request.name, view)
    return {
      name: definition.name,
      description: definition.description,
      ...definition.whenToUse === undefined ? {} : { whenToUse: definition.whenToUse },
      source: definition.source,
      ...definition.path === undefined ? {} : { path: definition.path },
      writable: isWritable(definition.source, view.options.cwd, definition.path),
      modelInvocable: definition.invocation.modelInvocable,
      userInvocable: definition.invocation.userInvocable,
      content: definition.content,
      ...installationFields(definition),
    }
  }

  /**
   * Create a new directory-bundle skill.
   * @param request - name, copy, body, and root.
   */
  @Remote('create')
  async create(request: SkillInventoryCreateRequest): Promise<void> {
    if (!isSkillName(request.name)) {
      throw new Error(`skillInventory: name "${request.name}" is not kebab-case`)
    }
    const view = this.resolveView(request)
    const existing = await view.registry.get(request.name, view.options)
    if (existing !== undefined) {
      throw new Error(`skillInventory: skill "${request.name}" already exists`)
    }
    const path = await createPath(request.root, request.name, view.options.cwd)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await writeFileAtomic(path, renderSkillMarkdown({
      name: request.name,
      description: request.description,
      ...optionalWhenToUse(request.whenToUse),
      modelInvocable: request.modelInvocable,
      userInvocable: request.userInvocable,
      content: request.content,
    }), { mode: 0o600, dirMode: 0o700 })
    view.registry.invalidate()
  }

  /**
   * Import or update one unsigned local skill from a directory, ZIP, or GitHub archive.
   * @param request - source, target root, declared permissions, and replacement policy.
   * @param signal - caller cancellation for network and filesystem materialization.
   * @returns immediate imported detail including explicit unsigned trust metadata.
   */
  @Remote('importSkill')
  async importSkill(request: SkillInventoryImportRequest, signal: AbortSignal): Promise<SkillInventoryDetail> {
    signal.throwIfAborted()
    const view = this.resolveView(request)
    const permissions = validatePermissions(request.permissions)
    const version = validateVersion(request.version)
    const temporary = await mkdtemp(join(tmpdir(), 'rlh-skill-import-'))
    try {
      const sourceRoot = await materializeImport(request, temporary, signal)
      const skillFile = await findImportedSkill(sourceRoot, request.skillPath)
      await assertSafeImportTree(dirname(skillFile))
      const parsed = parseSkillMarkdown(await readFile(skillFile, 'utf8'))
      const fallbackName = dirname(skillFile).split(/[\\/]/u).at(-1) ?? ''
      const name = typeof parsed.data['name'] === 'string' ? parsed.data['name'] : fallbackName
      if (!isSkillName(name)) throw new Error(`skillInventory: imported skill name ${JSON.stringify(name)} is not kebab-case`)
      const existing = await view.registry.get(name, view.options)
      if (existing !== undefined && request.replace !== true) throw new Error(`skillInventory: skill "${name}" already exists; set replace to update it`)
      const destination = await createPath(request.root, name, view.options.cwd)
      const destinationRoot = dirname(destination)
      if (existing !== undefined) {
        const writable = await this.requireWritable(name, view)
        if (bundleRoot(writable.path) !== destinationRoot) {
          throw new Error('skillInventory: replace must target the installed skill root')
        }
      }
      const staging = join(dirname(destinationRoot), `.${name}.import-${randomUUID()}`)
      await mkdir(staging, { recursive: true, mode: 0o700 })
      await cp(dirname(skillFile), staging, { recursive: true, force: true, errorOnExist: false })
      await assertSafeImportTree(staging)
      const stagedSkill = join(staging, 'SKILL.md')
      const content = await readFile(stagedSkill, 'utf8')
      const current = parseSkillMarkdown(content)
      const digest = createHash('sha256').update(content).digest('hex')
      const installMetadata = {
        ...isRecord(current.data['metadata']) ? current.data['metadata'] : {},
        'rlh-install-source': `${request.kind}:${safeInstallLocation(request)}`,
        'rlh-install-version': version ?? digest.slice(0, 12),
        'rlh-permissions': permissions,
        'rlh-trust': 'unsigned-local',
      }
      await writeFileAtomic(stagedSkill, renderSkillMarkdown({
        name,
        description: typeof current.data['description'] === 'string' ? current.data['description'] : '',
        ...optionalWhenToUse(typeof current.data['when-to-use'] === 'string' ? current.data['when-to-use'] : undefined),
        modelInvocable: current.data['disable-model-invocation'] !== true,
        userInvocable: current.data['user-invocable'] !== false,
        content: current.body,
        existingData: {
          ...current.data,
          metadata: installMetadata,
        },
      }), { mode: 0o600, dirMode: 0o700 })
      await installStagedBundle(staging, destinationRoot)
      view.registry.invalidate()
      return detailOf({
        name,
        description: typeof current.data['description'] === 'string' ? current.data['description'] : '',
        ...typeof current.data['whenToUse'] === 'string' ? { whenToUse: current.data['whenToUse'] } : {},
        invocation: {
          modelInvocable: current.data['disable-model-invocation'] !== true,
          userInvocable: current.data['user-invocable'] !== false,
        },
        source: request.root,
        provider: 'filesystem',
        resourceBase: { kind: 'directory', path: destinationRoot },
        path: destination,
        metadata: installMetadata,
        content: current.body,
      }, view.options.cwd)
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }

  /**
   * Replace the body and invocation flags of a writable skill.
   * @param request - name, copy, body, and flags.
   */
  @Remote('update')
  async update(request: SkillInventoryUpdateRequest): Promise<void> {
    const view = this.resolveView(request)
    const definition = await this.requireWritable(request.name, view)
    const current = parseSkillMarkdown(await readFile(definition.path, 'utf8'))
    await writeFileAtomic(definition.path, renderSkillMarkdown({
      name: definition.name,
      description: request.description,
      ...optionalWhenToUse(request.whenToUse),
      modelInvocable: request.modelInvocable,
      userInvocable: request.userInvocable,
      content: request.content,
      existingData: current.data,
    }), { mode: 0o600, dirMode: 0o700 })
    view.registry.invalidate()
  }

  /**
   * Delete a writable skill file or bundle directory.
   * @param request - name and optional cwd.
   */
  @Remote('delete')
  async delete(request: SkillInventoryRemoveRequest): Promise<void> {
    const view = this.resolveView(request)
    const definition = await this.requireWritable(request.name, view)
    await rm(bundleRoot(definition.path), { recursive: true, force: true })
    view.registry.invalidate()
  }

  /**
   * Write only the invocation frontmatter of a writable skill.
   * @param request - name and flags.
   */
  @Remote('setInvocation')
  async setInvocation(request: SkillInventoryInvocationRequest): Promise<void> {
    const view = this.resolveView(request)
    const definition = await this.requireWritable(request.name, view)
    const current = await readFile(definition.path, 'utf8')
    const parsed = parseSkillMarkdown(current)
    await writeFileAtomic(definition.path, renderSkillInvocationMarkdown({
      existingData: parsed.data,
      modelInvocable: request.modelInvocable,
      userInvocable: request.userInvocable,
      content: parsed.body,
    }), { mode: 0o600, dirMode: 0o700 })
    view.registry.invalidate()
  }

  private resolveView(request: SkillInventoryScope): ResolvedSkillView {
    const requestedCwd = emptyToUndefined(request.cwd)
    const agent = this.sessionAgent(request.sessionId)
    const sessionCwd = sessionCwdOf(agent)
    if (agent === undefined && requestedCwd !== undefined) {
      throw new TypertLookupFailure({
        code: 'session-required',
        message: 'project-scoped Skill access requires an attached Session',
        details: { cwd: requestedCwd },
      })
    }
    if (agent !== undefined && requestedCwd !== undefined && requestedCwd !== sessionCwd) {
      throw new TypertLookupFailure({
        code: 'workspace-scope-mismatch',
        message: `session "${request.sessionId}" does not own Skill cwd "${requestedCwd}"`,
        details: { sessionId: request.sessionId, cwd: requestedCwd },
      })
    }
    const cwd = sessionCwd
    const presets = this.ctx.get('agentPresets') as {
      serviceFor(agent: object, name: 'skills'): SkillRegistry | undefined
    } | undefined
    const registry = agent === undefined ? this.ctx.skills : presets?.serviceFor(agent, 'skills') ?? this.ctx.skills
    const options: SkillViewOptions = {
      ...cwd === undefined ? {} : { cwd },
      ...agent === undefined ? {} : { scope: agent },
    }
    return { registry, options }
  }

  private sessionAgent(sessionId: string | undefined): object | undefined {
    if (sessionId === undefined) return undefined
    const agents = this.ctx.get('agents') as { get(id: string): object | undefined } | undefined
    const agent = agents?.get(sessionId)
    if (agent === undefined) {
      throw new TypertLookupFailure({
        code: 'session-not-found',
        message: `session "${sessionId}" not found (not attached)`,
        details: { sessionId },
      })
    }
    return agent
  }

  private async requireSkill(name: string, view: ResolvedSkillView): Promise<SkillDefinition> {
    if (!isSkillName(name)) throw new Error(`skillInventory: name "${name}" is not kebab-case`)
    const definition = await view.registry.get(name, view.options)
    if (definition === undefined) throw new Error(`skillInventory: skill "${name}" was not found`)
    return definition
  }

  private async requireWritable(name: string, view: ResolvedSkillView): Promise<SkillDefinition & { path: string }> {
    const definition = await this.requireSkill(name, view)
    if (definition.path === undefined || !isWritable(definition.source, view.options.cwd, definition.path)) {
      throw new Error(`skillInventory: skill "${name}" is read-only`)
    }
    await assertWritablePath(definition.source, definition.path, view.options.cwd)
    return definition as SkillDefinition & { path: string }
  }
}

export default SkillInventoryGateway

function toEntry(
  summary: SkillSummary,
  detail: SkillDefinition | undefined,
  cwd: string | undefined,
  complete: boolean,
): SkillInventoryEntry {
  const path = detail?.path
  return {
    name: summary.name,
    description: summary.description,
    ...summary.whenToUse === undefined ? {} : { whenToUse: summary.whenToUse },
    source: summary.source,
    provider: summary.provider,
    ...path === undefined ? {} : { path },
    writable: isWritable(summary.source, cwd, path),
    modelInvocable: summary.invocation.modelInvocable,
    userInvocable: summary.invocation.userInvocable,
    ...installationFields(detail, complete),
  }
}

function detailOf(definition: SkillDefinition, cwd: string | undefined): SkillInventoryDetail {
  return {
    name: definition.name,
    description: definition.description,
    ...definition.whenToUse === undefined ? {} : { whenToUse: definition.whenToUse },
    source: definition.source,
    ...definition.path === undefined ? {} : { path: definition.path },
    writable: isWritable(definition.source, cwd, definition.path),
    modelInvocable: definition.invocation.modelInvocable,
    userInvocable: definition.invocation.userInvocable,
    content: definition.content,
    ...installationFields(definition),
  }
}

function installationFields(definition: SkillDefinition | undefined, complete = true) {
  const metadata = definition?.metadata
  const permissions = Array.isArray(metadata?.['rlh-permissions'])
    ? metadata['rlh-permissions'].filter((item): item is string => typeof item === 'string') : []
  const trust = definition?.source === 'bundled' ? 'bundled' as const
    : definition?.source === 'runtime' ? 'runtime' as const : 'unsigned-local' as const
  return {
    ...typeof metadata?.['rlh-install-version'] === 'string' ? { version: metadata['rlh-install-version'] } : {},
    ...typeof metadata?.['rlh-install-source'] === 'string' ? { installSource: metadata['rlh-install-source'] } : {},
    permissions,
    trust,
    health: definition === undefined ? 'invalid' as const : complete ? 'healthy' as const : 'last-good' as const,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sessionCwdOf(agent: object | undefined): string | undefined {
  if (agent === undefined || !('session' in agent)) return undefined
  const session = (agent as { session?: { header?: { cwd?: unknown } } }).session
  return typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined
}

function isWritable(source: string, cwd: string | undefined, path: string | undefined): boolean {
  if (path === undefined) return false
  if (WRITABLE_ALWAYS.has(source)) return true
  return cwd !== undefined && WRITABLE_WITH_CWD.has(source)
}

async function assertWritablePath(source: string, path: string, cwd: string | undefined): Promise<void> {
  let root: string | undefined
  if (source === 'user-rlh') root = join(resolveRlhHome(), 'skills')
  else if (source === 'user-agents') root = join(resolve(process.env.RLH_AGENTS_HOME ?? join(homedir(), '.agents')), 'skills')
  else if (cwd !== undefined && (source === 'project-rlh' || source === 'project-agents')) {
    const project = await findProjectRoot(cwd)
    root = join(project, source === 'project-rlh' ? '.rlh/skills' : '.agents/skills')
  }
  if (root === undefined) throw new Error(`skillInventory: source ${source} is not a writable owned root`)
  const [canonicalRoot, canonicalPath] = await Promise.all([realpath(root), realpath(path)])
  const within = relative(canonicalRoot, canonicalPath)
  if (within === '' || within.startsWith('..') || isAbsolute(within)) {
    throw new Error(`skillInventory: skill path escapes its owned ${source} root`)
  }
  if (!(await lstat(canonicalPath)).isFile()) throw new Error('skillInventory: writable skill path is not a regular file')
}

function validatePermissions(input: readonly string[]): string[] {
  if (input.length > MAX_PERMISSION_COUNT) throw new Error(`skillInventory: permissions must not exceed ${MAX_PERMISSION_COUNT}`)
  const permissions = input.map(value => value.trim())
  for (const value of permissions) {
    if (value.length === 0 || Array.from(value).length > MAX_PERMISSION_CHARS
      || !/^[a-z][a-z0-9._:-]*$/u.test(value)) {
      throw new Error(`skillInventory: invalid declared permission ${JSON.stringify(value)}`)
    }
  }
  if (new Set(permissions).size !== permissions.length) throw new Error('skillInventory: declared permissions must be unique')
  return permissions
}

function validateVersion(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const version = value.trim()
  if (version === '' || Array.from(version).length > 128 || /[\u0000-\u001f\u007f]/u.test(version)) {
    throw new Error('skillInventory: version must contain 1..128 printable characters')
  }
  return version
}

async function createPath(
  root: SkillInventoryCreateRequest['root'],
  name: string,
  cwd: string | undefined,
): Promise<string> {
  if (root === 'user-rlh') return join(resolveRlhHome(), 'skills', name, 'SKILL.md')
  if (cwd === undefined || cwd.trim().length === 0) {
    throw new Error('skillInventory: creating a project skill requires cwd')
  }
  const projectRoot = await findProjectRoot(cwd)
  return join(projectRoot, '.rlh', 'skills', name, 'SKILL.md')
}

async function findProjectRoot(cwd: string): Promise<string> {
  const fallback = resolve(cwd)
  let current = fallback
  while (true) {
    try {
      await access(join(current, '.git'))
      return current
    } catch {
      const parent = dirname(current)
      if (parent === current) return fallback
      current = parent
    }
  }
}

function bundleRoot(path: string): string {
  const normalized = path.replace(/\\/g, '/').toLowerCase()
  return normalized.endsWith('/skill.md') ? dirname(path) : path
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim().length === 0 ? undefined : value
}

function optionalWhenToUse(value: string | undefined): { whenToUse: string } | object {
  return value === undefined || value.trim().length === 0 ? {} : { whenToUse: value }
}

async function materializeImport(
  request: SkillInventoryImportRequest,
  temporary: string,
  signal: AbortSignal,
): Promise<string> {
  if (Array.from(request.location).length === 0 || Array.from(request.location).length > MAX_LOCATION_CHARS) {
    throw new Error(`skillInventory: import location must contain 1..${MAX_LOCATION_CHARS} characters`)
  }
  if (request.kind === 'local') {
    const root = await realpath(resolve(request.location))
    if (!(await stat(root)).isDirectory()) throw new Error('skillInventory: local import location must be a directory')
    return root
  }
  let bytes: Uint8Array
  if (request.kind === 'zip') {
    bytes = await readFile(resolve(request.location))
  } else {
    const url = githubArchiveUrl(request.location, request.version)
    const response = await fetch(url, { signal, headers: { 'user-agent': 'relay-harness-skill-import' } })
    if (!response.ok) throw new Error(`skillInventory: GitHub archive fetch failed with HTTP ${response.status}`)
    const advertised = Number(response.headers.get('content-length'))
    if (Number.isFinite(advertised) && advertised > MAX_ARCHIVE_BYTES) {
      throw new Error(`skillInventory: GitHub archive exceeds ${MAX_ARCHIVE_BYTES} bytes`)
    }
    bytes = new Uint8Array(await response.arrayBuffer())
  }
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error(`skillInventory: archive exceeds ${MAX_ARCHIVE_BYTES} bytes`)
  let expandedBytes = 0
  let fileCount = 0
  const files = unzipSync(bytes, {
    filter(info) {
      if (!Number.isSafeInteger(info.originalSize) || info.originalSize < 0) {
        throw new Error('skillInventory: archive entry has invalid expanded size')
      }
      fileCount += 1
      expandedBytes += info.originalSize
      if (fileCount > MAX_ARCHIVE_FILES || expandedBytes > MAX_EXPANDED_BYTES) {
        throw new Error('skillInventory: archive expansion limit exceeded')
      }
      return true
    },
  })
  for (const [name, content] of Object.entries(files)) {
    const normalized = name.replaceAll('\\', '/')
    const segments = normalized.split('/')
    if (normalized.startsWith('/') || isAbsolute(normalized) || /^[A-Za-z]:/u.test(normalized)
      || segments.some(segment => segment === '..' || segment === '.' || /[\u0000-\u001f\u007f]/u.test(segment))) {
      throw new Error(`skillInventory: unsafe ZIP path ${JSON.stringify(name)}`)
    }
    if (normalized.endsWith('/')) continue
    const destination = join(temporary, ...normalized.split('/'))
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await writeFile(destination, content, { mode: 0o600 })
  }
  return temporary
}

function githubArchiveUrl(location: string, version?: string): string {
  const parsed = new URL(location)
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.username !== '' || parsed.password !== ''
    || parsed.search !== '' || parsed.hash !== '') {
    throw new Error('skillInventory: GitHub imports require an https://github.com/<owner>/<repo> URL')
  }
  const parts = parsed.pathname.split('/').filter(Boolean)
  const [owner, rawRepo] = parts
  if (owner === undefined || rawRepo === undefined || parts.length !== 2) throw new Error('skillInventory: invalid GitHub repository URL')
  const repo = rawRepo.replace(/\.git$/u, '')
  const ref = version?.trim() || 'HEAD'
  if (ref.split('/').some(segment => segment === '..' || segment === '') || !/^[A-Za-z0-9._/-]+$/u.test(ref)) {
    throw new Error('skillInventory: GitHub version/ref contains unsupported characters')
  }
  const encodedRef = ref.split('/').map(encodeURIComponent).join('/')
  return `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip/${encodedRef}`
}

function safeInstallLocation(request: SkillInventoryImportRequest): string {
  if (request.kind !== 'github') return request.location
  const parsed = new URL(request.location)
  return `${parsed.origin}${parsed.pathname}`
}

async function installStagedBundle(staging: string, destination: string): Promise<void> {
  const backup = `${destination}.backup-${randomUUID()}`
  let backupPath: string | undefined
  try {
    try {
      await rename(destination, backup)
      backupPath = backup
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await rename(staging, destination)
    if (backupPath !== undefined) await rm(backupPath, { recursive: true, force: true })
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    if (backupPath !== undefined) {
      await rm(destination, { recursive: true, force: true })
      await rename(backupPath, destination)
    }
    throw error
  }
}

async function findImportedSkill(root: string, requestedPath: string | undefined): Promise<string> {
  if (requestedPath !== undefined) {
    const candidate = resolve(root, requestedPath, requestedPath.toLowerCase().endsWith('.md') ? '' : 'SKILL.md')
    if (!candidate.startsWith(resolve(root) + '/') && candidate !== resolve(root)) throw new Error('skillInventory: skillPath escapes the import root')
    await rejectSymlinkPath(root, candidate)
    const canonical = await realpath(candidate)
    const within = relative(await realpath(root), canonical)
    if (within.startsWith('..') || isAbsolute(within)) throw new Error('skillInventory: skillPath escapes the canonical import root')
    if (!(await lstat(canonical)).isFile()) throw new Error('skillInventory: imported SKILL.md must be a regular file')
    return canonical
  }
  const found: string[] = []
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') found.push(path)
    }
  }
  await visit(root)
  if (found.length !== 1) throw new Error(`skillInventory: import must contain exactly one SKILL.md (found ${found.length}); select skillPath`)
  const skill = found[0]
  if (skill === undefined) throw new Error('skillInventory: imported SKILL.md disappeared')
  return skill
}

async function rejectSymlinkPath(root: string, path: string): Promise<void> {
  const within = relative(resolve(root), resolve(path))
  if (within.startsWith('..') || isAbsolute(within)) throw new Error('skillInventory: import path escapes root')
  let current = resolve(root)
  for (const segment of within.split(/[\\/]/u).filter(Boolean)) {
    current = join(current, segment)
    if ((await lstat(current)).isSymbolicLink()) throw new Error('skillInventory: imported bundles must not contain symbolic links')
  }
}

async function assertSafeImportTree(root: string): Promise<void> {
  let files = 0
  let bytes = 0
  const visit = async (path: string): Promise<void> => {
    const info = await lstat(path)
    if (info.isSymbolicLink()) throw new Error('skillInventory: imported bundles must not contain symbolic links')
    if (info.isFile()) {
      files += 1
      bytes += info.size
      if (files > MAX_ARCHIVE_FILES || bytes > MAX_EXPANDED_BYTES) {
        throw new Error('skillInventory: imported bundle expansion limit exceeded')
      }
      return
    }
    if (!info.isDirectory()) throw new Error('skillInventory: imported bundles may contain only directories and regular files')
    for (const entry of await readdir(path)) await visit(join(path, entry))
  }
  await visit(root)
}
