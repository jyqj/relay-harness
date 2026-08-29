/** Cross-feature navigation seam for the Settings shell. */
import { Service } from '@relay-harness/cordis'
import type { Context } from '@relay-harness/cordis'
import { createSnapshotStore, type SnapshotStore } from '@relay-harness/rlh-client-runtime/client'

/** One imperative selection request. Revision makes repeated opens observable. */
export interface SettingsNavigationSnapshot {
  readonly section: string | undefined
  readonly revision: number
}

declare module '@relay-harness/cordis' {
  interface Context {
    /** Settings-shell selection owner; feature launchers request a real section through it. */
    settingsNavigation: SettingsNavigationService
  }
}

/** Owns Settings open/section requests without owning any feature page. */
export class SettingsNavigationService extends Service {
  /** Observable request stream bound into SettingsRoot by the slot renderer. */
  readonly store: SnapshotStore<SettingsNavigationSnapshot> = createSnapshotStore({
    section: undefined,
    revision: 0,
  })

  /** @param ctx - providing settings-shell context. */
  constructor(ctx: Context) {
    super(ctx, 'settingsNavigation')
  }

  /** Open Settings on a registered section id. */
  open(section: string): void {
    const before = this.store.getSnapshot()
    this.store.set({ section, revision: before.revision + 1 })
  }
}
