/** Experimental-package publication and dependency constraints. */

import { describe, expect, it } from 'vitest'
import {
  checkExperimentalDependencyIsolation,
  checkExperimentalManifest,
  checkWorkspace,
  publishedRepositoryDirectory,
  type WorkspaceManifest,
} from './check-workspace-constraints.ts'

const experimental: WorkspaceManifest = {
  dir: 'packages/experimental/prototype',
  manifest: { name: '@relay-harness/rlh-experimental-prototype', private: true },
}

describe('experimental workspace constraints', () => {
  it('requires the experimental package-name prefix', () => {
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, name: '@relay-harness/rlh-prototype' },
    })).toEqual([
      '@relay-harness/rlh-prototype: experimental package name must start with "@relay-harness/rlh-experimental-"',
    ])
  })

  it('requires private manifests without publication metadata', () => {
    expect(checkExperimentalManifest(experimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, private: false, publishConfig: { access: 'public' } },
    })).toEqual([
      '@relay-harness/rlh-experimental-prototype: experimental package must set "private": true',
      '@relay-harness/rlh-experimental-prototype: experimental package must omit publishConfig',
    ])
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects release %s on an experimental package',
    (section) => {
      expect(checkExperimentalDependencyIsolation([experimental, {
        dir: 'packages/core/consumer',
        manifest: {
          name: '@relay-harness/rlh-consumer',
          [section]: { '@relay-harness/rlh-experimental-prototype': 'workspace:^' },
        },
      }])).toEqual([
        `@relay-harness/rlh-consumer: ${section}.@relay-harness/rlh-experimental-prototype must not reference an experimental package`,
      ])
    },
  )

  it('allows development and experimental consumers but rejects the Python release runtime', () => {
    const manifests: WorkspaceManifest[] = [experimental, {
      dir: 'packages/core/test-only',
      manifest: {
        name: '@relay-harness/rlh-test-only',
        devDependencies: { '@relay-harness/rlh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'packages/experimental/consumer',
      manifest: {
        name: '@relay-harness/rlh-experimental-consumer',
        dependencies: { '@relay-harness/rlh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'python/sdk-runtime',
      manifest: {
        name: '@relay-harness/rlh-python-runtime',
        dependencies: { '@relay-harness/rlh-experimental-prototype': 'workspace:^' },
      },
    }]

    expect(checkExperimentalDependencyIsolation(manifests)).toEqual([
      '@relay-harness/rlh-python-runtime: dependencies.@relay-harness/rlh-experimental-prototype must not reference an experimental package',
    ])
  })
})

describe('private application constraints', () => {
  it('keeps the installer-only desktop app private', () => {
    expect(checkWorkspace({
      dir: 'apps/desktop',
      manifest: { name: 'relay-harness-desktop', private: true },
    })).toEqual([])
  })
})

describe('published repository directories', () => {
  it('converts runtime package paths to outer Git-root-relative metadata', () => {
    expect(publishedRepositoryDirectory('packages/core/session')).toBe('relay-harness/packages/core/session')
    expect(publishedRepositoryDirectory('native/landlock-run/packages/entry')).toBe('relay-harness/native/landlock-run/packages/entry')
  })

  it('rejects the pre-container release-member directory', () => {
    expect(checkWorkspace({
      dir: 'vendor/cosmokit',
      manifest: {
        name: '@relay-harness/cosmokit',
        publishConfig: { access: 'public' },
        repository: {
          type: 'git',
          url: 'git+https://github.com/jyqj/relay-harness.git',
          directory: 'vendor/cosmokit',
        },
      },
    })).toEqual([
      '@relay-harness/cosmokit: release member repository must use git+https://github.com/jyqj/relay-harness.git with directory relay-harness/vendor/cosmokit',
    ])
  })
})
