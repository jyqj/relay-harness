/** Tests for client package modes, dependency sections, and module requests. */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectClientPackageViolations,
  collectRuntimeSourcePackageUses,
  collectSourcePackageUses,
  collectStaticLinkedPackageNames,
  fixClientPackageManifests,
  readClientDeclarations,
  type ClientDeclaration,
  type ClientPackage,
  type ClientPackageFacts,
} from './verify-client-packages.ts'

const CORDIS = '@relay-harness/cordis'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('static Client assembly discovery', () => {
  it('reads a literal id without importing the tsdown config or its artifact dependencies', () => {
    expect(collectStaticLinkedPackageNames('tsdown.config.ts', [
      "import { staticLinked as clientEntry } from '../tsdown.client.ts'",
      "export default clientEntry('@relay-harness/rlh-client-demo', ['lib/types/index.js'])",
    ].join('\n'))).toEqual(['@relay-harness/rlh-client-demo'])
  })

  it('rejects a computed static package id', () => {
    expect(() => collectStaticLinkedPackageNames('tsdown.config.ts', [
      "import { staticLinked } from '../tsdown.client.ts'",
      "const id = '@relay-harness/rlh-client-demo'",
      "export default staticLinked(id, ['lib/types/index.js'])",
    ].join('\n'))).toThrow(/package id must be a string literal/)
  })
})

function declaration(
  short: string,
  fields: Partial<Omit<ClientDeclaration, 'name' | 'manifest'>> = {},
): ClientDeclaration {
  return {
    name: short.startsWith('@') ? short : '@relay-harness/rlh-client-' + short,
    manifest: 'packages/client/' + short.replace(/^.*\//, '') + '/package.json',
    dynamic: true,
    external: [],
    inject: [],
    ...fields,
  }
}

function pkg(
  short: string,
  fields: Partial<Omit<ClientPackage, 'name' | 'manifest'>> = {},
): ClientPackage {
  return {
    ...declaration(short),
    staticLinked: false,
    sourceUses: {},
    runtimeSourceUses: {},
    dependencies: {},
    peerDependencies: { [CORDIS]: 'workspace:^' },
    devDependencies: { [CORDIS]: 'workspace:^' },
    ...fields,
  }
}

function facts(
  packages: readonly ClientPackage[],
  options: Partial<Omit<ClientPackageFacts, 'packages'>> = {},
): ClientPackageFacts {
  return {
    packages,
    declarations: options.declarations ?? packages,
    staticLinkedPackages: options.staticLinkedPackages ?? new Set(
      packages.filter(item => item.staticLinked).map(item => item.name),
    ),
    platformModules: options.platformModules ?? [],
    preloadedExternals: options.preloadedExternals ?? [],
    parserPreloadIds: options.parserPreloadIds
      ?? (options.preloadedExternals ?? []).map(value => value.replace(/\/client$/, '')),
    malformed: options.malformed ?? [],
  }
}

describe('source package uses', () => {
  it('counts type imports, module augmentations, dynamic imports, and JSX', () => {
    const uses = collectSourcePackageUses('feature.tsx', [
      "import type { A } from '@relay-harness/rlh-a/subpath'",
      "declare module '@relay-harness/rlh-client-ui-slots' {}",
      "const load = () => import('@relay-harness/rlh-b')",
      'export const view = <div />',
      "export type { Local } from './local.ts'",
    ].join('\n'))

    expect([...uses].sort()).toEqual([
      '@relay-harness/rlh-a',
      '@relay-harness/rlh-b',
      '@relay-harness/rlh-client-ui-slots',
      'react',
    ])
    expect([...collectRuntimeSourcePackageUses('feature.tsx', [
      "import type { A } from '@relay-harness/rlh-a/subpath'",
      "declare module '@relay-harness/rlh-client-ui-slots' {}",
      "const load = () => import('@relay-harness/rlh-b')",
      'export const view = <div />',
    ].join('\n'))].sort()).toEqual([
      '@relay-harness/rlh-b',
      'react',
    ])
  })
})

describe('package modes', () => {
  it('accepts one dynamic package and one statically linked package', () => {
    const dynamic = pkg('runtime')
    const shell = pkg('ui-slots', { dynamic: false, staticLinked: true })
    expect(collectClientPackageViolations(facts([dynamic, shell]))).toEqual([])
  })

  it('rejects a package with both modes or neither mode', () => {
    const both = pkg('both', { staticLinked: true })
    const neither = pkg('neither', { dynamic: false })
    const found = collectClientPackageViolations(facts([both, neither]))
    expect(found).toHaveLength(2)
    expect(found.join('\n')).toContain('must be dynamic or statically linked, not both')
    expect(found.join('\n')).toContain('has no supported client package mode')
  })

  it('requires seeded workspace packages to use staticLinked and preloads to name dynamic rows', () => {
    const slots = declaration('ui-slots', { dynamic: false })
    const runtime = declaration('runtime', { dynamic: false })
    const found = collectClientPackageViolations(facts([], {
      declarations: [slots, runtime],
      platformModules: [slots.name],
      preloadedExternals: [runtime.name + '/client'],
    }))
    expect(found).toHaveLength(2)
    expect(found.join('\n')).toContain('does not use the staticLinked preset')
    expect(found.join('\n')).toContain('has no dynamic rlh.client row')
  })

  it('requires every preloaded external to have a parser preload row', () => {
    const runtime = declaration('runtime')
    expect(collectClientPackageViolations(facts([], {
      declarations: [runtime],
      preloadedExternals: [runtime.name + '/client'],
      parserPreloadIds: [],
    }))).toEqual([
      'packages/client/web/src/platform.ts: parser-preloaded external '
      + '"@relay-harness/rlh-client-runtime/client" has no matching PARSER_PRELOAD_IDS row in '
      + 'packages/client/modules/src/index.ts',
    ])
  })
})

describe('dependency sections', () => {
  it('accepts dynamic peer plus dev relationships, static dev inputs, and private dependencies', () => {
    const slots = pkg('ui-slots', { dynamic: false, staticLinked: true })
    const runtime = pkg('runtime', {
      inject: ['@relay-harness/rlh-client-feature'],
      sourceUses: {
        '@relay-harness/rlh-agent': ['packages/client/runtime/src/index.ts'],
        '@relay-harness/rlh-client-ui-slots': ['packages/client/runtime/src/client/slots.ts'],
        react: ['packages/client/runtime/src/client/view.tsx'],
      },
      dependencies: { immer: '^10.1.1' },
      peerDependencies: {
        [CORDIS]: 'workspace:^',
        '@relay-harness/rlh-agent': 'workspace:^',
        '@relay-harness/rlh-client-feature': 'workspace:^',
      },
      devDependencies: {
        [CORDIS]: 'workspace:^',
        '@relay-harness/rlh-agent': 'workspace:^',
        '@relay-harness/rlh-client-feature': 'workspace:^',
        '@relay-harness/rlh-client-ui-slots': 'workspace:^',
        react: '^18.2.0',
      },
    })
    expect(collectClientPackageViolations(facts([slots, runtime], {
      platformModules: ['react', slots.name],
    }))).toEqual([])
  })

  it('rejects internal dependencies, static peers, and mismatched peer development ranges', () => {
    const slots = pkg('ui-slots', { dynamic: false, staticLinked: true })
    const subject = pkg('feature', {
      sourceUses: {
        '@relay-harness/rlh-agent': ['packages/client/feature/src/index.ts'],
        [slots.name]: ['packages/client/feature/src/view.tsx'],
      },
      dependencies: { '@relay-harness/rlh-agent': 'workspace:^' },
      peerDependencies: { [CORDIS]: 'workspace:^', [slots.name]: 'workspace:^' },
      devDependencies: { [CORDIS]: 'workspace:^', [slots.name]: 'workspace:*' },
    })
    const found = collectClientPackageViolations(facts([slots, subject]))
    expect(found).toHaveLength(2)
    expect(found.join('\n')).toContain('peer-installed RLH relationship')
    expect(found.join('\n')).toContain('static client input')
  })

  it('requires every peer to have the same development range', () => {
    const subject = pkg('feature', {
      peerDependencies: { [CORDIS]: 'workspace:^', '@relay-harness/cordis-plugin-loader': 'workspace:^' },
    })
    expect(collectClientPackageViolations(facts([subject]))).toEqual([
      'packages/client/feature/package.json: peerDependencies.@relay-harness/cordis-plugin-loader'
      + ' is workspace:^, so devDependencies.@relay-harness/cordis-plugin-loader must use the same range;'
      + ' found no declaration',
    ])
  })

  it('requires statically linked third-party runtime imports in dependencies', () => {
    const primitives = pkg('ui-primitives', {
      dynamic: false,
      staticLinked: true,
      runtimeSourceUses: { shiki: ['packages/client/ui-primitives/src/highlight.ts'] },
      devDependencies: { [CORDIS]: 'workspace:^', shiki: '^4.3.1' },
    })
    const found = collectClientPackageViolations(facts([primitives]))
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('runtime import retained by a statically linked artifact')
    expect(found[0]).toContain('declare it only in dependencies')

    const valid = { ...primitives, dependencies: { shiki: '^4.3.1' }, devDependencies: { [CORDIS]: 'workspace:^' } }
    expect(collectClientPackageViolations(facts([valid]))).toEqual([])
  })

  it('keeps the web shell runtime inputs development-only', () => {
    const web = pkg('web', {
      dynamic: false,
      staticLinked: true,
      runtimeSourceUses: {
        '@relay-harness/cordis-plugin-loader': ['packages/client/web/src/boot.ts'],
        react: ['packages/client/web/src/seed.ts'],
      },
      devDependencies: {
        [CORDIS]: 'workspace:^',
        '@relay-harness/cordis-plugin-loader': 'workspace:^',
        react: '^18.2.0',
      },
    })
    expect(collectClientPackageViolations(facts([web]))).toEqual([])
  })

  it('allows npm dependency cycles', () => {
    const a = pkg('a', {
      peerDependencies: { [CORDIS]: 'workspace:^', '@relay-harness/rlh-client-b': 'workspace:^' },
      devDependencies: { [CORDIS]: 'workspace:^', '@relay-harness/rlh-client-b': 'workspace:^' },
    })
    const b = pkg('b', {
      peerDependencies: { [CORDIS]: 'workspace:^', '@relay-harness/rlh-client-a': 'workspace:^' },
      devDependencies: { [CORDIS]: 'workspace:^', '@relay-harness/rlh-client-a': 'workspace:^' },
    })
    expect(collectClientPackageViolations(facts([a, b]))).toEqual([])
  })
})

describe('module requests', () => {
  it('accepts a dynamic row supplier and its client subpath', () => {
    const ui = declaration('ui', { external: ['@relay-harness/rlh-client-slots/client'] })
    const slots = declaration('slots')
    expect(collectClientPackageViolations(facts([], { declarations: [ui, slots] }))).toEqual([])
  })

  it('rejects an explicit baseline request', () => {
    const ui = declaration('ui', { external: ['react'] })
    expect(collectClientPackageViolations(facts([], {
      declarations: [ui],
      platformModules: ['react'],
    }))).toEqual([
      ui.manifest + ': rlh.client.external repeats baseline module "react"; remove the explicit declaration',
    ])
  })

  it('rejects duplicates, empty values, self-requests, and missing suppliers', () => {
    const ui = declaration('ui', {
      external: ['', '@relay-harness/rlh-client-ui', '@relay-harness/rlh-missing', '@relay-harness/rlh-missing'],
      inject: ['', '@relay-harness/rlh-a', '@relay-harness/rlh-a'],
    })
    const found = collectClientPackageViolations(facts([], { declarations: [ui] }))
    expect(found).toHaveLength(6)
    expect(found.join('\n')).toContain('rlh.client.external contains an empty value')
    expect(found.join('\n')).toContain('rlh.client.inject contains an empty value')
    expect(found.join('\n')).toContain('names its own row')
    expect(found.join('\n')).toContain('has no supplier')
  })

  it('rejects synchronous module-request cycles but ignores inject cycles', () => {
    const a = declaration('a', {
      external: ['@relay-harness/rlh-client-b'],
      inject: ['@relay-harness/rlh-client-b'],
    })
    const b = declaration('b', {
      external: ['@relay-harness/rlh-client-a'],
      inject: ['@relay-harness/rlh-client-a'],
    })
    const found = collectClientPackageViolations(facts([], { declarations: [a, b] }))
    expect(found).toHaveLength(1)
    expect(found[0]).toContain('synchronous rlh.client.external cycle')
  })
})

describe('manifest declarations', () => {
  it('reports malformed arrays without hiding other packages', () => {
    const root = mkdtempSync(join(tmpdir(), 'client-packages-'))
    roots.push(root)
    const files: Record<string, unknown> = {
      'packages/g/a/package.json': {
        name: '@f/a', rlh: { client: { external: 'react', inject: ['@f/b', 1] } },
      },
      'packages/g/b/package.json': { name: '@f/b', rlh: { client: {} } },
    }
    for (const [path, value] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), JSON.stringify(value))
    }

    const result = readClientDeclarations(root)
    expect(result.declarations).toHaveLength(2)
    expect(result.malformed).toEqual([
      'packages/g/a/package.json: @f/a rlh.client.external must be a string array',
      'packages/g/a/package.json: @f/a rlh.client.inject must be a string array',
    ])
  })

  it('fixes unambiguous dependency sections and declaration entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'client-packages-fix-'))
    roots.push(root)
    const subject = pkg('feature', {
      external: ['', 'react', '@relay-harness/rlh-client-feature', '@relay-harness/rlh-missing'],
      inject: ['', '@relay-harness/rlh-agent', '@relay-harness/rlh-agent'],
      sourceUses: {
        '@relay-harness/rlh-agent': ['packages/client/feature/src/index.ts'],
        '@relay-harness/rlh-client-ui-slots': ['packages/client/feature/src/view.tsx'],
      },
      dependencies: {
        [CORDIS]: 'workspace:^',
        '@relay-harness/rlh-agent': 'workspace:*',
      },
      peerDependencies: {
        '@relay-harness/rlh-client-ui-slots': 'workspace:^',
        '@relay-harness/cordis-plugin-loader': 'workspace:^',
      },
      devDependencies: {},
    })
    const slots = declaration('ui-slots', { dynamic: false })
    const manifest = {
      name: subject.name,
      rlh: { client: { external: subject.external, inject: subject.inject, platform: 'web' } },
      dependencies: subject.dependencies,
      peerDependencies: subject.peerDependencies,
      devDependencies: subject.devDependencies,
    }
    mkdirSync(dirname(join(root, subject.manifest)), { recursive: true })
    writeFileSync(join(root, subject.manifest), JSON.stringify(manifest))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }))

    expect(fixClientPackageManifests(root, facts([subject], {
      declarations: [subject, slots],
      staticLinkedPackages: new Set([slots.name]),
      platformModules: ['react', slots.name],
    }))).toEqual([subject.manifest])

    const fixed = JSON.parse(readFileSync(join(root, subject.manifest), 'utf8')) as {
      rlh: { client: { external: string[]; inject: string[] } }
      dependencies?: Record<string, string>
      peerDependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(fixed.rlh.client).toMatchObject({
      external: ['@relay-harness/rlh-missing'],
      inject: ['@relay-harness/rlh-agent'],
    })
    expect(fixed.dependencies).toBeUndefined()
    expect(fixed.peerDependencies).toEqual({
      '@relay-harness/cordis-plugin-loader': 'workspace:^',
      [CORDIS]: 'workspace:^',
      '@relay-harness/rlh-agent': 'workspace:*',
    })
    expect(fixed.devDependencies).toEqual({
      '@relay-harness/rlh-client-ui-slots': 'workspace:^',
      [CORDIS]: 'workspace:^',
      '@relay-harness/rlh-agent': 'workspace:*',
      '@relay-harness/cordis-plugin-loader': 'workspace:^',
    })
  })

  it('fixes a statically linked runtime import into dependencies', () => {
    const root = mkdtempSync(join(tmpdir(), 'client-packages-static-fix-'))
    roots.push(root)
    const subject = pkg('ui-primitives', {
      dynamic: false,
      staticLinked: true,
      runtimeSourceUses: { shiki: ['packages/client/ui-primitives/src/highlight.ts'] },
      devDependencies: { [CORDIS]: 'workspace:^', shiki: '^4.3.1' },
    })
    mkdirSync(dirname(join(root, subject.manifest)), { recursive: true })
    writeFileSync(join(root, subject.manifest), JSON.stringify({
      name: subject.name,
      peerDependencies: subject.peerDependencies,
      devDependencies: subject.devDependencies,
    }))
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true }))

    expect(fixClientPackageManifests(root, facts([subject]))).toEqual([subject.manifest])
    const fixed = JSON.parse(readFileSync(join(root, subject.manifest), 'utf8')) as {
      dependencies: Record<string, string>
      devDependencies: Record<string, string>
    }
    expect(fixed.dependencies).toEqual({ shiki: '^4.3.1' })
    expect(fixed.devDependencies).toEqual({ [CORDIS]: 'workspace:^' })
  })
})
