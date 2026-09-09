/**
 * Service Definition for the spill storage capability seam (`ctx.spillStore`): an abstract service defining WHAT a
 * spill backend does — persist a tool's oversized text, return a model-facing
 * locator plus retrieval guidance, and reclaim a session's storage at
 * disposal — without saying HOW. Implementations subclass {@link SpillStore}
 * and register as the `spillStore` service;
 * `@relay-harness/rlh-spill-local` (host filesystem) is the first.
 *
 * The Service Definition is deliberately small: `saveText` plus one
 * reclamation verb. It owns NO preview policy (that is
 * `@relay-harness/rlh-output-retention`), NO tool-result replacement (that is
 * `@relay-harness/rlh-spill-policy`), and NO retrieval or search API. The
 * backend supplies the locator and retrieval hint appropriate for its storage
 * substrate, and owns its own retention mechanics.
 *
 * @module @relay-harness/rlh-spill
 */

import { Context, Service } from '@relay-harness/cordis'
import type { SessionId } from '@relay-harness/rlh-session'
import type { SaveTextSpill, SpillRef } from './types.ts'

export { SpillLocator } from './types.ts'
export type { SaveTextSpill, SpillOwner, SpillRef, SpillSource } from './types.ts'

declare module '@relay-harness/cordis' {
  interface Context {
    spillStore: SpillStore
  }
}

/**
 * Abstract spill storage service. Subclass, implement {@link saveText}, and load
 * the subclass as a plugin — it registers as `ctx.spillStore` (one
 * implementation per context; loading a second throws, cordis' standard
 * duplicate-service behavior).
 *
 * Semantics every implementation must honor:
 * - {@link saveText} persists the FULL `content` verbatim and returns an opaque
 *   locator, exact byte length, and model-facing retrieval guidance.
 * - Storage is scoped by the request's {@link SaveTextSpill.owner} session; the
 *   backend chooses a private (not world-readable) location and a collision-free
 *   name derived from — never equal to — the caller's `suggestedName`.
 * - `saveText` REJECTS on a real storage failure (permissions, ENOSPC, backend
 *   unavailable); the caller decides how to degrade (the spill policy treats a
 *   rejection as best-effort and keeps the inline result).
 * - {@link disposeSession} reclaims the session's whole storage scope.
 *   Locators are best-effort recovery paths, not durable promises: a disposed
 *   session's log may still reference the reclaimed paths, and reads of them
 *   fail loudly.
 */
export abstract class SpillStore extends Service {
  constructor(ctx: Context) {
    super(ctx, 'spillStore')
  }

  /**
   * Persist `input.content` to a session-scoped spill artifact.
   * @param input - the owner, caller-supplied source fields, suggested name, and full text to save.
   * @returns the saved artifact's {@link SpillRef}; rejects on a storage failure.
   */
  abstract saveText(input: SaveTextSpill): Promise<SpillRef>

  /**
   * Reclaim every artifact owned by `sessionId`. Called at that session's
   * disposal; idempotent, and a session that spilled nothing resolves.
   * @param sessionId - the session whose spill storage should be reclaimed.
   * @returns resolves when reclamation completes; rejects on a storage failure.
   */
  abstract disposeSession(sessionId: SessionId): Promise<void>
}

export default SpillStore
