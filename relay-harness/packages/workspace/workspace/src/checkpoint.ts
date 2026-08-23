/**
 * Co-located workspace file checkpoints and transactional rewind.
 *
 * @module @deepseek-ai/dsh-workspace
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import type { WorkspaceCheckpoint, WorkspaceCheckpointId, WorkspaceId } from './types.ts'

const CHECKPOINT_VERSION = 1
const MAX_CHECKPOINT_FILES = 4096
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024

type FileSnapshot =
  | { readonly path: string; readonly kind: 'absent' }
  | { readonly path: string; readonly kind: 'file'; readonly content: string; readonly mode: number; readonly bytes: number }

interface CheckpointRecord {
  readonly version: typeof CHECKPOINT_VERSION
  readonly workspaceId: WorkspaceId
  readonly id: WorkspaceCheckpointId
  readonly createdAt: string
  readonly bytes: number
  readonly files: readonly FileSnapshot[]
}

/** Stable checkpoint-storage directory for one workspace id. */
function storeDir(root: string, workspaceId: WorkspaceId): string {
  const safeId = createHash('sha256').update(workspaceId).digest('hex').slice(0, 32)
  return resolve(root, '.dsh', 'rewind-checkpoints', safeId)
}

/** Stable filename that never joins caller-controlled checkpoint bytes. */
function recordPath(root: string, workspaceId: WorkspaceId, checkpointId: WorkspaceCheckpointId): string {
  const safeId = createHash('sha256').update(checkpointId).digest('hex')
  return resolve(storeDir(root, workspaceId), `${safeId}.json`)
}

/** Normalize one caller path and prove lexical containment. */
function normalizeRelative(root: string, input: string): { relativePath: string; absolutePath: string } {
  if (input.length === 0 || isAbsolute(input)) throw new Error(`workspace checkpoint path must be relative: ${JSON.stringify(input)}`)
  const absolutePath = resolve(root, input)
  const fromRoot = relative(root, absolutePath)
  if (fromRoot.length === 0 || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`workspace checkpoint path escapes the workspace: ${JSON.stringify(input)}`)
  }
  return { relativePath: fromRoot.split(sep).join('/'), absolutePath }
}

/** Reject a symlink at any existing path component below the workspace root. */
async function rejectSymlinkComponents(root: string, relativePath: string): Promise<void> {
  let current = root
  for (const part of relativePath.split('/')) {
    current = resolve(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new Error(`workspace checkpoint refuses symlink path component: ${relativePath}`)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }
}

/** Capture one regular file or confirmed absence. */
async function captureOne(root: string, path: string): Promise<FileSnapshot> {
  const normalized = normalizeRelative(root, path)
  await rejectSymlinkComponents(root, normalized.relativePath)
  let info
  try {
    info = await lstat(normalized.absolutePath)
  } catch (error: unknown) {
    /* v8 ignore else -- the immediately preceding component walk established
     * every existing component; another code requires an external race. */
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: normalized.relativePath, kind: 'absent' }
    }
    /* v8 ignore next -- see race justification above. */
    throw error
  }
  if (!info.isFile()) throw new Error(`workspace checkpoint path is not a regular file: ${normalized.relativePath}`)
  if (info.size > MAX_CHECKPOINT_BYTES) throw new Error(`workspace checkpoint file exceeds ${MAX_CHECKPOINT_BYTES} bytes: ${normalized.relativePath}`)
  const content = await readFile(normalized.absolutePath)
  return {
    path: normalized.relativePath,
    kind: 'file',
    content: content.toString('base64'),
    mode: info.mode & 0o777,
    bytes: content.byteLength,
  }
}

/** Owner-only atomic file replacement with fsync before rename. */
async function writeAtomic(path: string, content: Uint8Array, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.tmp-${randomUUID()}`
  try {
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, path)
    await chmod(path, mode)
  } catch (error: unknown) {
    await rm(temporary, { force: true })
    throw error
  }
}

/** Create the store-wide ignore file once without replacing it on Windows. */
async function ensureGitignore(path: string): Promise<void> {
  try {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile('*\n')
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch (error: unknown) {
    /* v8 ignore else -- non-EEXIST requires an external permission/I/O failure
     * at the private store after its parent directory was created. */
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      /* v8 ignore next -- see external-failure justification above. */
      throw error
    }
    const info = await lstat(path)
    if (!info.isFile()) {
      throw new Error('workspace checkpoint .gitignore is not a regular file')
    }
  }
}

/** Strictly validate one loaded checkpoint record. */
function parseRecord(raw: string, workspaceId: WorkspaceId, checkpointId?: WorkspaceCheckpointId): CheckpointRecord {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch (error: unknown) {
    throw new Error('workspace checkpoint record is not valid JSON', { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('workspace checkpoint record must be an object')
  const record = value as Record<string, unknown>
  if (record.version !== CHECKPOINT_VERSION || record.workspaceId !== workspaceId
    || typeof record.id !== 'string' || typeof record.createdAt !== 'string'
    || !Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0 || !Array.isArray(record.files)) {
    throw new Error('workspace checkpoint record is malformed or belongs to another workspace')
  }
  if (checkpointId !== undefined && record.id !== checkpointId) throw new Error('workspace checkpoint id does not match its record')
  if (record.files.length > MAX_CHECKPOINT_FILES) throw new Error('workspace checkpoint record exceeds the file-count limit')
  let bytes = 0
  const paths = new Set<string>()
  for (const value of record.files) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('workspace checkpoint contains an invalid or duplicate path')
    }
    const file = value as Record<string, unknown>
    if (typeof file.path !== 'string'
      || paths.has(file.path) || normalizeRelative('/', file.path).relativePath !== file.path) {
      throw new Error('workspace checkpoint contains an invalid or duplicate path')
    }
    paths.add(file.path)
    if (file.kind === 'absent') continue
    if (file.kind !== 'file' || typeof file.content !== 'string' || !Number.isSafeInteger(file.mode)
      || !Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0) throw new Error('workspace checkpoint contains a malformed file snapshot')
    const content = Buffer.from(file.content, 'base64')
    if (content.toString('base64') !== file.content || content.byteLength !== file.bytes) {
      throw new Error('workspace checkpoint file bytes do not match their encoding')
    }
    bytes += content.byteLength
  }
  if (bytes !== record.bytes || bytes > MAX_CHECKPOINT_BYTES) throw new Error('workspace checkpoint byte total is invalid')
  return record as unknown as CheckpointRecord
}

/**
 * Capture and persist one explicit checkpoint.
 * @param root - canonical workspace directory.
 * @param workspaceId - owning Workspace identity.
 * @param paths - explicit workspace-relative paths.
 * @returns durable checkpoint metadata.
 */
export async function createWorkspaceCheckpoint(
  root: string,
  workspaceId: WorkspaceId,
  paths: readonly string[],
): Promise<WorkspaceCheckpoint> {
  const unique = [...new Set(paths)].sort()
  if (unique.length === 0) throw new Error('workspace checkpoint requires at least one path')
  if (unique.length > MAX_CHECKPOINT_FILES) throw new Error(`workspace checkpoint accepts at most ${MAX_CHECKPOINT_FILES} paths`)
  const files: FileSnapshot[] = []
  let bytes = 0
  for (const path of unique) {
    const file = await captureOne(root, path)
    files.push(file)
    if (file.kind === 'file') bytes += file.bytes
    if (bytes > MAX_CHECKPOINT_BYTES) throw new Error(`workspace checkpoint exceeds ${MAX_CHECKPOINT_BYTES} bytes`)
  }
  const id = randomUUID() as WorkspaceCheckpointId
  const createdAt = new Date().toISOString()
  const record: CheckpointRecord = {
    version: CHECKPOINT_VERSION,
    workspaceId,
    id,
    createdAt,
    bytes,
    files,
  }
  const directory = storeDir(root, workspaceId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await ensureGitignore(resolve(dirname(directory), '.gitignore'))
  await writeAtomic(recordPath(root, workspaceId, id), Buffer.from(JSON.stringify(record)), 0o600)
  return { id, createdAt, paths: files.map(file => file.path), bytes }
}

/** Apply one snapshot state. */
async function applySnapshot(root: string, file: FileSnapshot): Promise<void> {
  const target = normalizeRelative(root, file.path)
  await rejectSymlinkComponents(root, target.relativePath)
  if (file.kind === 'absent') {
    try {
      await unlink(target.absolutePath)
    } catch (error: unknown) {
      /* v8 ignore next -- preflight captured this path as absent or regular;
       * a non-ENOENT failure requires an external path-type race. */
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return
  }
  await writeAtomic(target.absolutePath, Buffer.from(file.content, 'base64'), file.mode)
}

/**
 * Restore one checkpoint transactionally, then truncate its future timeline.
 * @param root - canonical workspace directory.
 * @param workspaceId - owning Workspace identity.
 * @param checkpointId - checkpoint to load and restore.
 */
export async function rewindWorkspaceCheckpoint(
  root: string,
  workspaceId: WorkspaceId,
  checkpointId: WorkspaceCheckpointId,
): Promise<void> {
  const checkpoint = parseRecord(
    await readFile(recordPath(root, workspaceId, checkpointId), 'utf8'),
    workspaceId,
    checkpointId,
  )
  const rollback: FileSnapshot[] = []
  for (const file of checkpoint.files) rollback.push(await captureOne(root, file.path))
  const applied: FileSnapshot[] = []
  try {
    for (const file of checkpoint.files) {
      await applySnapshot(root, file)
      applied.push(file)
    }
  } catch (error: unknown) {
    const failures: unknown[] = []
    for (const file of rollback.slice(0, applied.length).reverse()) {
      try {
        await applySnapshot(root, file)
      } catch (rollbackError: unknown) {
        /* v8 ignore next -- requires a second independent filesystem failure
         * during best-effort rollback after the initiating failure. */
        failures.push(rollbackError)
      }
    }
    /* v8 ignore next 2 -- requires the initiating filesystem failure plus a
     * second independent failure while restoring an already-applied sibling. */
    if (failures.length > 0) throw new AggregateError([error, ...failures], 'workspace rewind and rollback failed')
    throw error
  }

  const directory = storeDir(root, workspaceId)
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const path = resolve(directory, entry.name)
    let candidate: CheckpointRecord
    try {
      candidate = parseRecord(await readFile(path, 'utf8'), workspaceId)
    } catch {
      continue
    }
    if (candidate.createdAt >= checkpoint.createdAt) await unlink(path)
  }
}
