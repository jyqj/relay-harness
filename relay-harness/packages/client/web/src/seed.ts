/**
 * Platform-singleton module-table. These are the ONLY entities the shell
 * shares into the frozen module table — fetch bundles resolve their externals
 * against exactly this set through the loader's require. Keys come from the
 * platform constant module ({@link ./platform.ts}, the single source
 * of truth with the tsdown client externals); values stay shell-static
 * imports so every bundle sees the same instance.
 */
import * as React from 'react'
import * as ReactJsxRuntime from 'react/jsx-runtime'
import * as ReactDom from 'react-dom'
import * as ReactDomClient from 'react-dom/client'
import * as Cordis from '@relay-harness/cordis'
import * as Zod from 'zod'
import * as UiSlots from '@relay-harness/rlh-client-ui-slots'
import * as UiPrimitives from '@relay-harness/rlh-client-ui-primitives'
import type { PlatformModule } from './platform.ts'

function preserveModuleExports<T extends object>(module: T): T {
  // Runtime-loaded plugins read platform exports through string-keyed require.
  // Copying forces Vite to retain members that the static shell never reads.
  return { ...module }
}

/**
 * Build the static table handed to the module loader at boot.
 * @returns module specifier → exported entity (one entry per platform word).
 */
export function getStaticModules(): Record<string, unknown> {
  // The satisfies pin is the projection contract: a word added to
  // PLATFORM_MODULES without a static import here (or vice versa) fails to
  // compile instead of drifting into a runtime require miss.
  return {
    'react': preserveModuleExports(React),
    'react/jsx-runtime': preserveModuleExports(ReactJsxRuntime),
    'react-dom': preserveModuleExports(ReactDom),
    'react-dom/client': preserveModuleExports(ReactDomClient),
    '@relay-harness/cordis': preserveModuleExports(Cordis),
    'zod': preserveModuleExports(Zod),
    '@relay-harness/rlh-client-ui-slots': preserveModuleExports(UiSlots),
    '@relay-harness/rlh-client-ui-primitives': preserveModuleExports(UiPrimitives),
  } satisfies Record<PlatformModule, unknown>
}
