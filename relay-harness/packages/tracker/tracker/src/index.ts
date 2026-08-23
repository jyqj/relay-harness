/**
 * Provider registry for issue-tracker reads and provider-native host tools.
 * @module @deepseek-ai/dsh-tracker
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { deepFreeze } from '@deepseek-ai/dsh-llm'
import { assertObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import type {
  TrackerProvider,
  TrackerToolContext,
  TrackerToolBinding,
  TrackerToolResult,
} from './types.ts'
import type { JsonValue } from '@deepseek-ai/dsh-session'

export type * from './types.ts'
export type { TrackerIssueId as TrackerIssueIdValue } from './types.ts'

/**
 * Brand an issue identity.
 * @param value Provider-owned stable identity.
 * @returns Branded issue identity.
 */
export const TrackerIssueId = (value: string): import('./types.ts').TrackerIssueId =>
  value as import('./types.ts').TrackerIssueId

const PROVIDER_NAME = /^[a-z][a-z0-9-]*$/
const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]*$/
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

declare module '@deepseek-ai/cordis' {
  interface Context {
    trackers: TrackerRegistry
  }

  interface Events {
    /**
     * A provider became available after its registry insertion committed.
     * @param provider Exact registered provider.
     * @mode emit
     */
    'tracker/provider-added'(provider: TrackerProvider): void
    /**
     * A provider was removed before this notification.
     * @param name Removed provider name.
     * @mode emit
     */
    'tracker/provider-removed'(name: string): void
  }
}

/** Provider-neutral registry with effect-scoped registration and run-scoped tool capture. */
export class TrackerRegistry extends Service {
  private readonly providers = new Map<string, TrackerProvider>()

  constructor(ctx: Context) {
    super(ctx, 'trackers')
  }

  /**
   * Register a provider.
   * @param provider Provider to own until caller disposal.
   * @returns Exact effect disposer.
   */
  register(provider: TrackerProvider): () => void {
    const name = provider.name
    if (!PROVIDER_NAME.test(name)) {
      throw new TypeError(`tracker provider name ${JSON.stringify(name)} must match ${String(PROVIDER_NAME)}`)
    }
    // oxlint-disable-next-line typescript/no-misused-promises -- Cordis attaches async teardown to the callable disposer.
    return this.ctx.effect(function* (this: TrackerRegistry) {
      if (this.providers.has(name)) throw new Error(`tracker provider ${JSON.stringify(name)} is already registered`)
      this.providers.set(name, provider)
      yield () => {
        this.providers.delete(name)
        this.ctx.emit('tracker/provider-removed', name)
      }
      this.ctx.emit('tracker/provider-added', provider)
    }.bind(this), 'trackers.register()')
  }

  /**
   * Resolve a provider.
   * @param name Registered provider name.
   * @returns Exact provider or throws.
   */
  require(name: string): TrackerProvider {
    const provider = this.providers.get(name)
    if (provider === undefined) throw new Error(`tracker provider ${JSON.stringify(name)} is not registered`)
    return provider
  }

  /**
   * List providers.
   * @returns Provider names in registration order.
   */
  list(): readonly string[] {
    return [...this.providers.keys()]
  }

  /**
   * Capture and validate one provider's exact tool/configuration snapshot.
   * Provider removal blocks later captures but does not revoke a returned binding.
   * @param name Registered provider to capture.
   * @returns Validated immutable tool binding.
   */
  bindTools(name: string): TrackerToolBinding {
    const raw = this.require(name).bindTools()
    if (raw.provider !== name) {
      throw new Error(`tracker provider ${JSON.stringify(name)} returned binding for ${JSON.stringify(raw.provider)}`)
    }
    const seen = new Set<string>()
    const tools = raw.tools.map((tool) => {
      if (!TOOL_NAME.test(tool.name)) {
        throw new Error(`tracker tool name ${JSON.stringify(tool.name)} must match ${String(TOOL_NAME)}`)
      }
      if (seen.has(tool.name)) throw new Error(`tracker binding repeats tool ${JSON.stringify(tool.name)}`)
      seen.add(tool.name)
      if (tool.description.length === 0 || tool.description.trim() !== tool.description) {
        throw new Error(`tracker tool ${JSON.stringify(tool.name)} description must be non-blank and trimmed`)
      }
      assertObjectJsonSchema(tool.parameters)
      return deepFreeze(structuredClone(tool))
    })
    const environment = new Set<string>()
    for (const variable of raw.secretEnvironmentNames) {
      if (!ENVIRONMENT_NAME.test(variable)) {
        throw new Error(`tracker secret environment name ${JSON.stringify(variable)} is invalid`)
      }
      if (environment.has(variable)) {
        throw new Error(`tracker binding repeats secret environment name ${JSON.stringify(variable)}`)
      }
      environment.add(variable)
    }
    const toolNames = new Set(tools.map(tool => tool.name))
    return Object.freeze({
      provider: name,
      tools: Object.freeze(tools),
      secretEnvironmentNames: Object.freeze([...environment]),
      execute: async (
        toolName: string,
        arguments_: JsonValue,
        context: TrackerToolContext,
        signal?: AbortSignal,
      ): Promise<TrackerToolResult> => {
        if (!toolNames.has(toolName)) {
          return deepFreeze({
            success: false,
            value: { error: { code: 'UNSUPPORTED_TRACKER_TOOL', tool: toolName } },
          })
        }
        signal?.throwIfAborted()
        const result = await raw.execute(toolName, arguments_, context, signal)
        signal?.throwIfAborted()
        return deepFreeze(structuredClone(result))
      },
    })
  }
}

export default TrackerRegistry
