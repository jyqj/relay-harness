/**
 * `LocalSpillStore`: the host-filesystem implementation of the
 * `@relay-harness/rlh-spill` storage seam. Persists a tool's oversized text to a
 * private, session-scoped file (see `./store.ts` for the traversal-safe naming
 * and exclusive owner-only write) and returns a path locator plus local
 * read/grep retrieval guidance. Storage is reclaimed per session at that
 * session's disposal, and a one-shot startup sweep removes orphan roots left
 * by earlier processes once they outlive `orphanRetentionMs`.
 *
 * @module @relay-harness/rlh-spill-local
 */

import { Context } from '@relay-harness/cordis'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import z from '@relay-harness/schemastery'
import { SpillLocator, SpillStore } from '@relay-harness/rlh-spill'
import type { SaveTextSpill, SpillRef } from '@relay-harness/rlh-spill'
import type { SessionId } from '@relay-harness/rlh-session'
import { deleteSessionFiles, pruneOrphanRoots, privateRoot, SPILL_ROOT_PREFIX, saveTextFile } from './store.ts'

export { encodeSegment, privateRoot, pruneOrphanRoots, saveTextFile, sessionDir, SPILL_ROOT_PREFIX } from './store.ts'
export type { PruneOrphanRootsOptions, SavedText, SaveTextOptions } from './store.ts'

/** Default grace before the startup sweep reclaims an orphan root from a previous process: 7 days. */
export const DEFAULT_ORPHAN_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

/** Plugin config (all optional — `static Config` supplies the defaults). */
export interface Config {
  /**
   * Root directory for spill files. Omitted uses a lazily-created private
   * (0700) per-process directory under the OS temp dir — the safe default for
   * a local deployment. Set it to keep spill files under a known location.
   */
  root?: string
  /**
   * Age in milliseconds at which a spill root left by an earlier process
   * becomes reclaimable by the one-shot startup sweep. The sweep watches the
   * OS temp dir for `rlh-spill-*` roots and never removes the current
   * process's own root.
   * @default 604800000
   */
  orphanRetentionMs?: number
}

/**
 * Local-filesystem spill backend. Files land under `<root>/session-<hash>/…`
 * with unpredictable names, an exclusive owner-only (0600) write, and a private
 * (0700) root — a spilled tool result must not be readable by other local users
 * or redirectable via a planted symlink.
 */
export class LocalSpillStore extends SpillStore {
  static Config: z<Config> = z.object({
    root: z.string(),
    orphanRetentionMs: z.number()
      .step(1)
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(DEFAULT_ORPHAN_RETENTION_MS),
  })

  /** Resolved absolute spill root (config `root`, else the private default), fixed at construction. */
  readonly root: string

  /** Schemastery-defaulted age before an orphan root is reclaimable. */
  private readonly orphanRetentionMs: number

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.root = config.root !== undefined ? resolve(config.root) : privateRoot()
    // Schemastery validates and fills the default before constructing the service.
    this.orphanRetentionMs = (config as Required<Config>).orphanRetentionMs
    pruneOrphanRoots({ parent: tmpdir(), prefix: SPILL_ROOT_PREFIX, keep: this.root, retentionMs: this.orphanRetentionMs })
    // The backend owns its storage lifecycle: a disposed session's spill scope
    // is reclaimable because locators are best-effort recovery paths. The
    // session store contains and logs listener rejections.
    ctx.on('session/disposed', (session) => { void this.disposeSession(session.header.id) })
  }

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const saved = await saveTextFile({
      root: this.root,
      sessionId: input.owner.sessionId,
      suggestedName: input.suggestedName,
      content: input.content,
    })
    return {
      locator: SpillLocator(saved.path),
      bytes: saved.bytes,
      retrievalHint: 'Use read with offset/limit, or grep this path to search within it.',
    }
  }

  async disposeSession(sessionId: SessionId): Promise<void> {
    await deleteSessionFiles(this.root, sessionId)
  }
}

export default LocalSpillStore
