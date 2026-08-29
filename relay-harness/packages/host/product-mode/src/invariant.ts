/** Invariant companion for product-mode. */
import type { Context } from '@relay-harness/cordis'
import type { InvariantInstaller } from '@relay-harness/rlh-invariants'
export const name='host-product-mode-invariant'; export const inject=['invariants']
/** No runtime invariant: the closed mode enum is validated by Settings and generated Remote codecs. */
const install:InvariantInstaller=()=>{}
export const apply=(ctx:Context):Promise<()=>void>=>Promise.resolve(ctx.invariants.register('@relay-harness/rlh-host-product-mode',install))
