/** Shared browser owner of the Host-persisted Simple/Developer mode. */
import { Service } from '@relay-harness/cordis'
import type { Context } from '@relay-harness/cordis'
import type { ProductMode } from '@relay-harness/rlh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@relay-harness/rlh-client-runtime/client'

export type { ProductMode } from '@relay-harness/rlh-api-remotes/client'

type ProductModeResult =
  | { ok: true; value: { mode: ProductMode } }
  | { ok: false; error: { code: string; message: string } }
interface ProductModeRemote {
  get(): Promise<ProductModeResult>
  set(request: { mode: ProductMode }): Promise<ProductModeResult>
}
interface DesktopModeShell {
  getConfig?: () => Promise<{ simpleMode?: boolean }>
  saveConfig?: (patch: { simpleMode: boolean }) => Promise<unknown>
}

function desktopShell(): DesktopModeShell | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as Window & { shell?: DesktopModeShell }).shell
}

/** Client lifecycle around the persisted mode value. */
export interface ProductModeView {
  readonly mode: ProductMode
  readonly status: 'loading' | 'ready' | 'saving' | 'error'
  readonly error: string | null
}

declare module '@relay-harness/cordis' {
  interface Context {
    /** Shared mode source used by product-shell policy and feature launchers. */
    productShell: ProductShellService
  }
}

/** Reads and writes the generated productMode Remote, folding successful writes locally. */
export class ProductShellService extends Service {
  readonly store: SnapshotStore<ProductModeView> = createSnapshotStore({
    mode: 'simple',
    status: 'loading',
    error: null,
  })
  private generation = 0
  private desktopMigrated = false

  /** @param ctx - product-shell plugin context. */
  constructor(ctx: Context) {
    super(ctx, 'productShell')
  }

  /** Re-read the Host owner; a failed refresh holds the last known mode. */
  async load(): Promise<void> {
    const generation = ++this.generation
    const before = this.store.getSnapshot()
    if (before.status !== 'ready') this.store.set({ ...before, status: 'loading', error: null })
    try {
      const remote = (this.ctx.remote as unknown as { productMode: ProductModeRemote }).productMode
      const result = await remote.get()
      if (generation !== this.generation) return
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      const mode = await this.reconcileDesktop(remote, result.value.mode)
      if (generation !== this.generation) return
      this.store.set({ mode, status: 'ready', error: null })
    } catch (error) {
      if (generation !== this.generation) return
      this.store.set({
        mode: this.store.getSnapshot().mode,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Persist a mode choice and fold the Host answer into the shared source. */
  async set(mode: ProductMode): Promise<void> {
    const generation = ++this.generation
    const before = this.store.getSnapshot()
    this.store.set({ mode, status: 'saving', error: null })
    try {
      const remote = (this.ctx.remote as unknown as { productMode: ProductModeRemote }).productMode
      const result = await remote.set({ mode })
      if (generation !== this.generation) return
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      this.store.set({ mode: result.value.mode, status: 'ready', error: null })
      await this.mirrorDesktop(result.value.mode)
    } catch (error) {
      if (generation !== this.generation) return
      this.store.set({
        mode: before.mode,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** One-time migration of the legacy Desktop flag, then Host-to-native mirroring. */
  private async reconcileDesktop(remote: ProductModeRemote, hostMode: ProductMode): Promise<ProductMode> {
    const shell = desktopShell()
    let mode = hostMode
    if (!this.desktopMigrated) {
      this.desktopMigrated = true
      try {
        const legacy = await shell?.getConfig?.()
        // Fresh Desktop config is true (Simple), matching the Host base. Only
        // explicit/effective false carries legacy information worth migrating.
        if (hostMode === 'simple' && legacy?.simpleMode === false) {
          const migrated = await remote.set({ mode: 'developer' })
          if (migrated.ok) mode = migrated.value.mode
        }
      } catch {
        // The Host remains authoritative when the optional native bridge fails.
      }
    }
    await this.mirrorDesktop(mode)
    return mode
  }

  /** Keep native menu/tray filtering aligned for the next Desktop shell rebuild. */
  private async mirrorDesktop(mode: ProductMode): Promise<void> {
    try {
      await desktopShell()?.saveConfig?.({ simpleMode: mode === 'simple' })
    } catch {
      // Product mode is already committed on the Host; native mirroring is best-effort.
    }
  }
}
