/** Shared browser owner of the Host-persisted Simple/Developer mode. */
import { Service } from '@relay-harness/cordis'
import type { Context, FiberState } from '@relay-harness/cordis'
import type { ProductMode } from '@relay-harness/rlh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@relay-harness/rlh-client-runtime/client'

export type { ProductMode } from '@relay-harness/rlh-api-remotes/client'

// Cordis exports a const enum, not a runtime object; watch bundlers cannot inline it across declaration files.
const UNLOADING: FiberState.UNLOADING = 5

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
  /** Observable persisted/effective product mode. */
  readonly store: SnapshotStore<ProductModeView> = createSnapshotStore({
    mode: 'simple',
    status: 'loading',
    error: null,
  })
  private readonly ownerFiber: Context['fiber']
  private disposed = false
  private readonly pendingWrites = new Set<Promise<void>>()
  private generation = 0
  private desktopMigrated = false

  /** @param ctx - product-shell plugin context. */
  constructor(ctx: Context) {
    super(ctx, 'productShell')
    this.ownerFiber = ctx.fiber
    ctx.effect(() => () => { this.disposed = true; this.generation += 1 }, 'product-shell mode lifetime')
  }

  private isCurrent(generation: number): boolean {
    return !this.disposed && generation === this.generation
      && this.ownerFiber.uid !== null && this.ownerFiber.state !== UNLOADING
  }

  /** Re-read the Host owner; a failed refresh holds the last known mode. */
  async load(): Promise<void> {
    if (!this.isCurrent(this.generation)) return
    while (this.pendingWrites.size > 0) {
      await Promise.all([...this.pendingWrites])
      if (!this.isCurrent(this.generation)) return
    }
    const generation = ++this.generation
    const before = this.store.getSnapshot()
    if (before.status !== 'ready') this.store.set({ ...before, status: 'loading', error: null })
    try {
      if (!this.isCurrent(generation)) return
      const remote = (this.ctx.remote as unknown as { productMode: ProductModeRemote }).productMode
      const result = await remote.get()
      if (!this.isCurrent(generation)) return
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      const mode = await this.reconcileDesktop(remote, result.value.mode, generation)
      if (!this.isCurrent(generation)) return
      this.store.set({ mode, status: 'ready', error: null })
    } catch (error) {
      if (!this.isCurrent(generation)) return
      this.store.set({
        mode: this.store.getSnapshot().mode,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Persist a mode choice and fold the Host answer into the shared source.
   * @param mode - explicit Simple or Developer mode.
   */
  async set(mode: ProductMode): Promise<void> {
    if (!this.isCurrent(this.generation)) return
    let finish!: () => void
    const completion = new Promise<void>((resolve) => { finish = resolve })
    this.pendingWrites.add(completion)
    try {
      const generation = ++this.generation
      const before = this.store.getSnapshot()
      this.store.set({ mode, status: 'saving', error: null })
      try {
        if (!this.isCurrent(generation)) return
        const remote = (this.ctx.remote as unknown as { productMode: ProductModeRemote }).productMode
        const result = await remote.set({ mode })
        if (!this.isCurrent(generation)) return
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        this.store.set({ mode: result.value.mode, status: 'ready', error: null })
        await this.mirrorDesktop(result.value.mode, generation)
      } catch (error) {
        if (!this.isCurrent(generation)) return
        this.store.set({
          mode: before.mode,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
        })
      }
    } finally {
      this.pendingWrites.delete(completion)
      finish()
    }
  }

  /** One-time migration of the legacy Desktop flag, then Host-to-native mirroring. */
  private async reconcileDesktop(remote: ProductModeRemote, hostMode: ProductMode, generation: number): Promise<ProductMode> {
    const shell = desktopShell()
    let mode = hostMode
    if (!this.desktopMigrated) {
      this.desktopMigrated = true
      try {
        const legacy = await shell?.getConfig?.()
        if (!this.isCurrent(generation)) return hostMode
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
    await this.mirrorDesktop(mode, generation)
    return mode
  }

  /** Keep native menu/tray filtering aligned for the next Desktop shell rebuild. */
  private async mirrorDesktop(mode: ProductMode, generation: number): Promise<void> {
    if (!this.isCurrent(generation)) return
    try {
      await desktopShell()?.saveConfig?.({ simpleMode: mode === 'simple' })
    } catch {
      // Product mode is already committed on the Host; native mirroring is best-effort.
    }
  }
}
