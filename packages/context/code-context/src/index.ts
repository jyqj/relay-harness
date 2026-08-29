/**
 * Opt-in code-index recall context. When the plugin entry carries a config
 * section, the package registers one context-engine step-context contributor
 * that recalls ranked local-code-index hits into every claimed step; without a
 * config section nothing registers and requests stay byte-identical.
 *
 * @module @relay-harness/rlh-code-context
 */

import { Context, Service } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import {
  CodeContextContributor,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_HITS,
  DEFAULT_MIN_QUERY_CHARS,
} from './contributor.ts'
import type { CodeContextConfig } from './contributor.ts'

export {
  CodeContextContributor,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_HITS,
  DEFAULT_MIN_QUERY_CHARS,
} from './contributor.ts'
export type { CodeContextConfig } from './contributor.ts'
export type { CodeContextRecallHit, CodeContextRecallSource } from './types.ts'

declare module '@relay-harness/cordis' {
  interface Context {
    codeContext: CodeContext
  }
}

/** Code-index recall injection configuration. */
export interface Config {
  /** Maximum characters of rendered hit lines included in one recall message. */
  maxChars?: number
  /** Maximum hits injected per step. */
  maxHits?: number
  /** Minimum trimmed direct-user-text length that triggers a search. */
  minQueryChars?: number
}

/**
 * Owner of the code-index recall contributor (`ctx.codeContext`). The service
 * itself carries no query surface: it exists so a deployment can observe that
 * recall injection is active and dispose it as one unit. Registration is
 * strictly opt-in — a Loader entry without a `config` section constructs the
 * service but registers no contributor.
 */
export class CodeContext extends Service {
  /**
   * The top-level default is cleared explicitly: schemastery gives every
   * object schema an implicit `{}` default, which would fill the budget
   * defaults for an absent section and defeat the opt-in gate below.
   */
  static Config: z<Config> = z.object({
    maxChars: z.number().step(1).min(1).default(DEFAULT_MAX_CHARS),
    maxHits: z.number().step(1).min(1).default(DEFAULT_MAX_HITS),
    minQueryChars: z.natural().default(DEFAULT_MIN_QUERY_CHARS),
  }).default(undefined as never)

  constructor(ctx: Context, config?: Config) {
    super(ctx, 'codeContext')
    // A Loader entry may carry an explicit null config (`config:`); treat it as absent.
    if (config == null) return
    const resolved: CodeContextConfig = {
      maxChars: config.maxChars ?? DEFAULT_MAX_CHARS,
      maxHits: config.maxHits ?? DEFAULT_MAX_HITS,
      minQueryChars: config.minQueryChars ?? DEFAULT_MIN_QUERY_CHARS,
    }
    validateConfig(resolved)
    ctx.inject(['contextEngine'], scope => scope.contextEngine.registerContributor(
      new CodeContextContributor(ctx, resolved),
    ))
  }
}

export default CodeContext

/**
 * Reject invalid budgets before anything registers, so a misconfigured section
 * fails the plugin load instead of misbehaving mid-step.
 * @param config - the resolved configuration to check.
 */
function validateConfig(config: CodeContextConfig): void {
  for (const name of ['maxChars', 'maxHits'] as const) {
    const value = config[name]
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`code-context: ${name} must be a positive safe integer`)
    }
  }
  if (!Number.isSafeInteger(config.minQueryChars) || config.minQueryChars < 0) {
    throw new Error('code-context: minQueryChars must be a non-negative safe integer')
  }
}
