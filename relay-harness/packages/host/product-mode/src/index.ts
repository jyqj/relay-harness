/** Persisted ordinary-user versus Developer product-mode owner. */
import type { Context } from '@relay-harness/cordis'
import z from '@relay-harness/schemastery'
import { settingsNamespace, type SettingsScope } from '@relay-harness/rlh-settings'
import { Remote, TypertRemoteService } from '@relay-harness/rlh-typert-protocol'

import type { ProductModeSetRequest, ProductModeSnapshot } from './types.ts'
export type { ProductMode, ProductModeSetRequest, ProductModeSnapshot } from './types.ts'
const NS = settingsNamespace('product-mode')

declare module '@relay-harness/cordis' { interface Context { productMode: ProductModeService } }

/** Host Remote and settings-backed single owner of product-mode state. */
export class ProductModeService extends TypertRemoteService {
  static inject = ['settings']
  private readonly scope: SettingsScope<ProductModeSnapshot>
  constructor(ctx: Context) {
    super(ctx, 'productMode')
    this.scope = ctx.settings.register(NS, z.object({ mode: z.union(['simple', 'developer'] as const).required() }), {
      base: { mode: 'simple' }, applies: 'live',
    })
  }
  /**
   * Read the current resolved product mode.
   * @returns current resolved product mode.
   */
  @Remote('get') get(): ProductModeSnapshot { return this.scope.get() }
  /**
   * Persist one explicit product mode.
   * @param request - next explicit mode.
   * @returns the resolved mode after durable settings persistence.
   */
  @Remote('set') async set(request: ProductModeSetRequest): Promise<ProductModeSnapshot> {
    await this.scope.update({ mode: request.mode })
    return this.scope.get()
  }
}
export default ProductModeService
