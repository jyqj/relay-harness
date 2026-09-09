/**
 * Cordis-free storage mechanics for the local spill backend: private
 * session-scoped directory selection, safe-name derivation, path-traversal
 * protection, and the exclusive owner-only write. Kept out of the service class
 * (like `rlh-bash-local`'s `run.ts`) so the filesystem behavior is unit-testable
 * without a `ctx` and without the OS temp dir.
 *
 * @module @relay-harness/rlh-spill-local/store
 */

import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { mkdir, open, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

/** Root-name prefix that marks a temp-dir directory as this backend's per-process spill root. */
export const SPILL_ROOT_PREFIX = 'rlh-spill-'

let defaultRoot: string | undefined

/**
 * The default spill root: a private (0700) per-process directory under the OS
 * tmpdir, created lazily. Predictable world-readable paths would let other
 * local users read spilled tool output or pre-create symlinks; `mkdtemp` gives
 * an unpredictable suffix and 0700 semantics.
 *
 * @returns The lazily-created private spill root.
 */
export function privateRoot(): string {
  defaultRoot ??= mkdtempSync(join(tmpdir(), SPILL_ROOT_PREFIX))
  return defaultRoot
}

// Deliberately mirrors the JSONL path encoder, but keeps spill's empty-name
// policy (`""` -> `"~"`) local so storage backends stay decoupled.
/* jscpd:ignore-start */
/**
 * Encode an arbitrary string as one safe path segment, injectively over ALL JS
 * (UTF-16) strings. A session id / suggested name is untrusted input, so this
 * neutralizes `../`, absolute paths, NUL, and separators before any filesystem
 * use. Each code unit is kept literal (`[A-Za-z0-9._-]`, minus `~`) or escaped
 * as `~XXXX`; `~` is itself escaped, so the mapping is reversible and distinct
 * inputs never collide. The whole-segment tokens `.`/`..` are escaped so they
 * can never traverse. An empty string encodes to `~` (never an empty segment).
 * (Mirrors the JSONL persistence backend's `encodeSegment`.)
 *
 * @param raw The untrusted string to encode as one safe path segment.
 * @returns An injective, filesystem-safe single path segment.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) return '~'
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}
/* jscpd:ignore-end */

/**
 * The session-scoped directory: `<root>/session-<hash(sessionId)>`, a short stable hash.
 *
 * @param root The spill root directory.
 * @param sessionId The owning session id to hash into a stable directory name.
 * @returns The absolute session-scoped spill directory path.
 */
export function sessionDir(root: string, sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 12)
  return join(root, `session-${hash}`)
}

/** Options for {@link saveTextFile} — the resolved root and the request fields the store needs. */
export interface SaveTextOptions {
  /** The spill root directory (configured or the lazy private default). */
  root: string
  /** The owning session id (scopes the directory). */
  sessionId: string
  /** Caller-suggested base name; sanitized to one safe segment before use. */
  suggestedName: string
  /** The full text to persist. */
  content: string
}

/** A written spill file. */
export interface SavedText {
  path: string
  bytes: number
}

/**
 * Write `content` to a fresh file under the session-scoped directory and return
 * its path + byte length. The filename is a random hex prefix plus the
 * sanitized `suggestedName`, so it is unpredictable (defeats symlink planting in
 * a shared root) AND stays readable. The open is exclusive + owner-only
 * (`'wx', 0o600`): it fails on any existing path — symlink or not — so a
 * pre-planted target cannot redirect the write.
 *
 * @param options The resolved root and request fields required to save the file.
 * @returns The written file path and UTF-8 byte length.
 */
export async function saveTextFile(options: SaveTextOptions): Promise<SavedText> {
  const dir = sessionDir(options.root, options.sessionId)
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const safeName = encodeSegment(options.suggestedName)
  const path = join(dir, `${randomBytes(6).toString('hex')}-${safeName}`)
  const bytes = Buffer.byteLength(options.content, 'utf8')
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(options.content)
  } finally {
    await handle.close()
  }
  return { path, bytes }
}

/**
 * Delete a session's entire spill directory. Missing directories resolve —
 * disposal is idempotent and a session may have spilled nothing.
 *
 * @param root The spill root directory.
 * @param sessionId The session whose spill directory should be removed.
 */
export async function deleteSessionFiles(root: string, sessionId: string): Promise<void> {
  await rm(sessionDir(root, sessionId), { recursive: true, force: true })
}

/** Options for {@link pruneOrphanRoots} — what to watch, what to keep, and how old is expired. */
export interface PruneOrphanRootsOptions {
  /** Directory holding the backend's per-process roots (the OS temp dir). */
  parent: string
  /** Root-name prefix identifying this backend's roots. */
  prefix: string
  /** A root that must never be removed (this process's own), even when expired. */
  keep?: string
  /** Roots whose mtime is at least this many ms in the past are reclaimable. */
  retentionMs: number
  /** The current time; overridable for deterministic tests. */
  now?: number
}

/**
 * One bounded startup sweep: remove this backend's roots under `parent` that
 * have not been touched for `retentionMs`. Every process restart orphans the
 * previous per-process root, so expired roots from earlier runs are otherwise
 * permanent residue. The current process's root (`keep`) and anything younger
 * stay, unrelated entries are never touched, and a root that cannot be
 * stat'd or removed is left for the next start.
 *
 * @param options The watched parent, root prefix, kept root, and retention age.
 * @returns The roots that were removed.
 */
export function pruneOrphanRoots(options: PruneOrphanRootsOptions): string[] {
  const now = options.now ?? Date.now()
  let entries: string[]
  try {
    entries = readdirSync(options.parent)
  } catch {
    // An unreadable parent has nothing to sweep; the live root is unaffected.
    return []
  }
  const removed: string[] = []
  for (const entry of entries) {
    if (!entry.startsWith(options.prefix)) continue
    const candidate = join(options.parent, entry)
    if (candidate === options.keep) continue
    try {
      if (now - statSync(candidate).mtimeMs < options.retentionMs) continue
    } catch {
      // The entry vanished mid-sweep: nothing to reclaim.
      continue
    }
    try {
      rmSync(candidate, { recursive: true, force: true })
    } catch {
      // An unlinkable root (EBUSY, EPERM, race) stays behind; the next start retries.
      continue
    }
    removed.push(candidate)
  }
  return removed
}
