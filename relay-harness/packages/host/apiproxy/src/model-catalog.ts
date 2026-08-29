/**
 * Provider/model catalog assembly shared by the session-scoped `session.models`
 * and host-scoped `llm.models` routes.
 * @module @relay-harness/rlh-host-apiproxy/model-catalog
 */

import type { Context } from '@relay-harness/cordis'
import type { ModelCatalogFailure, ModelProviderGroup, ModelReasoning } from './api/index.ts'

/**
 * Build the provider/model catalog over every registered route. Shared by the
 * session-scoped `session.models` and host-scoped `llm.models`. Catalog
 * membership stays advisory: an unlisted session selection remains valid for
 * provider dispatch, but is not injected back into the selector after its
 * owning catalog stops advertising it. Per-provider failures ride `failures`
 * without failing the sound groups; groups that advertise nothing are dropped.
 * @param ctx - the host context listing providers and models.
 * @returns the advertised provider groups and per-provider failures, with
 * empty-model groups dropped.
 */
export async function buildModelCatalog(ctx: Context): Promise<{
  groups: ModelProviderGroup[]
  failures: ModelCatalogFailure[]
}> {
  const catalog = await Promise.all(ctx.llm.listProviders().map(async (provider) => {
    try {
      const models = await ctx.llm.listModels(provider.id)
      const entries = await Promise.all(models.map(async (model) => {
        const resolved = await ctx.llm.resolveModelInfo(provider.id, model.id)
        const reasoning: ModelReasoning | undefined = resolved.reasoning === undefined
          ? undefined
          : {
            efforts: resolved.reasoning.efforts.map(effort => ({
              id: effort.id,
              name: effort.name,
              ...effort.description === undefined
                ? {}
                : { description: effort.description },
            })),
            ...resolved.reasoning.defaultEffort === undefined
              ? {}
              : { defaultEffort: resolved.reasoning.defaultEffort },
          }
        return {
          id: model.id,
          name: model.name,
          ...model.description === undefined ? {} : { description: model.description },
          ...model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] },
          ...reasoning === undefined ? {} : { reasoning },
        }
      }))
      const group: ModelProviderGroup = {
        id: provider.id,
        name: provider.name,
        models: entries,
      }
      return { kind: 'group' as const, group }
    } catch (error: unknown) {
      const failure: ModelCatalogFailure = {
        id: provider.id,
        name: provider.name,
        message: error instanceof Error ? error.message : String(error),
      }
      return { kind: 'failure' as const, failure }
    }
  }))
  return {
    groups: catalog.flatMap(item => item.kind === 'group' ? [item.group] : []).filter(group => group.models.length > 0),
    failures: catalog.flatMap(item => item.kind === 'failure' ? [item.failure] : []),
  }
}
