/**
 * Wire types for the skill Settings Remote.
 * @module @relay-harness/rlh-host-skill-inventory/types
 */

/** Discovery root a Settings create may write. */
export type SkillCreateRoot = 'user-rlh' | 'project-rlh'

/** One catalog row for Settings. */
export interface SkillInventoryEntry {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly source: string
  readonly provider: string
  readonly path?: string
  readonly writable: boolean
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  readonly version?: string
  readonly installSource?: string
  readonly permissions: readonly string[]
  readonly trust: 'bundled' | 'unsigned-local' | 'runtime'
  readonly health: 'healthy' | 'last-good' | 'invalid'
}

/** Catalog snapshot. */
export interface SkillInventorySnapshot {
  readonly skills: readonly SkillInventoryEntry[]
  readonly cwd?: string
}

/** Optional workspace and live-session selector. */
export interface SkillInventoryScope {
  readonly cwd?: string
  readonly sessionId?: string
}

/** Load one skill body. */
export interface SkillInventoryGetRequest extends SkillInventoryScope {
  readonly name: string
}

/** Loaded skill for the editor. */
export interface SkillInventoryDetail {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly source: string
  readonly path?: string
  readonly writable: boolean
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  readonly content: string
  readonly version?: string
  readonly installSource?: string
  readonly permissions: readonly string[]
  readonly trust: 'bundled' | 'unsigned-local' | 'runtime'
  readonly health: 'healthy' | 'last-good' | 'invalid'
}

/** Create a user or project skill bundle. */
export interface SkillInventoryCreateRequest extends SkillInventoryScope {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly content: string
  readonly root: SkillCreateRoot
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

/** Replace frontmatter and body of a writable skill. */
export interface SkillInventoryUpdateRequest extends SkillInventoryScope {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly content: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

/** Delete a writable skill. */
export interface SkillInventoryRemoveRequest extends SkillInventoryScope {
  readonly name: string
}

/** Write invocation frontmatter. */
export interface SkillInventoryInvocationRequest extends SkillInventoryScope {
  readonly name: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

/** Governed local, ZIP, or GitHub skill import request. */
export interface SkillInventoryImportRequest extends SkillInventoryScope {
  readonly kind: 'local' | 'zip' | 'github'
  readonly location: string
  readonly root: SkillCreateRoot
  readonly skillPath?: string
  readonly version?: string
  readonly permissions: readonly string[]
  readonly replace?: boolean
}
