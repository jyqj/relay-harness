/** Release family discovery, publish order, tag naming, and the bump judgements. */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { officialClientBuildEnvironment, writeClientBuildRecord } from '../client-build-environment.ts'
import { releaseFamily, type ReleaseMember } from './families.ts'
import { compareVersions, nextVendorVersion, planShared, reachesPayload } from './bump.ts'

/**
 * A release member standing in for a manifest on disk.
 * @param directory - repository-relative package directory.
 * @param name - package name.
 * @param manifest - manifest fields the subject reads.
 * @returns The member.
 */
function member(directory: string, name: string, manifest: Record<string, unknown> = {}): ReleaseMember {
  return { directory, name, version: '0.0.1', manifest }
}

const roots: string[] = []

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function buildFixture(environment: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'rlh-release-build-'))
  roots.push(root)
  write(join(root, 'apps/web/dist/index.html'), '<main></main>')
  write(join(root, 'packages/client/example/lib/client.js'), 'module.exports = {}\n')
  writeClientBuildRecord(root, environment)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('release families', () => {
  it('excludes private experimental packages from the rlh release', () => {
    const members = releaseFamily('rlh').members(resolve(import.meta.dirname, '../..'))

    expect(members.some(member => member.directory.startsWith('packages/experimental/'))).toBe(false)
    expect(members.map(member => member.name)).not.toContain('@relay-harness/rlh-experimental-agent-team')
    // The desktop app keeps its own installer version line outside this family.
    expect(members.some(member => member.directory.startsWith('apps/desktop/'))).toBe(false)
  })

  it('bumps private rlh packages without adding release tags', () => {
    const root = mkdtempSync(join(tmpdir(), 'rlh-release-version-'))
    roots.push(root)
    write(join(root, 'package.json'), '{"version":"0.0.1"}\n')
    write(join(root, 'packages/experimental/prototype/package.json'), '{"version":"0.0.1","private":true}\n')
    write(join(root, 'packages/core/unselected/package.json'), '{"version":"0.0.1"}\n')

    const rlh = releaseFamily('rlh')
    const published = member('packages/core/published', '@relay-harness/rlh-published')
    const { planned } = planShared(rlh, root, [published], '0.0.2')

    expect(planned.map(entry => ({ path: entry.manifestPath, tag: entry.tag }))).toEqual([
      { path: 'package.json', tag: undefined },
      { path: 'packages/core/published/package.json', tag: 'rlh-v0.0.2' },
      { path: 'packages/experimental/prototype/package.json', tag: undefined },
    ])
  })

  it('names one tag for the whole rlh family and one per vendored package', () => {
    const rlh = releaseFamily('rlh')
    const vendor = releaseFamily('vendor')
    const cli = member('apps/cli', '@relay-harness/rlh')
    const cordis = { ...member('vendor/cordis', '@relay-harness/cordis'), version: '4.0.1' }

    expect(rlh.tagFor(cli)).toBe('rlh-v0.0.1')
    expect(vendor.tagFor(cordis)).toBe('vendor-cordis-v4.0.1')
    // The prefix is constructed, not recovered from a tag: a version with a
    // hyphen would defeat any suffix-stripping.
    expect(vendor.tagPrefixFor({ ...cordis, version: '4.0.0-rc.7' })).toBe('vendor-cordis-v')
    expect(vendor.tagFor({ ...cordis, version: '4.0.0-rc.7' })).toBe('vendor-cordis-v4.0.0-rc.7')
  })

  it('rejects a family whose members disagree on the shared version', () => {
    const rlh = releaseFamily('rlh')
    const members = [member('apps/cli', '@relay-harness/rlh'), { ...member('apps/web', '@relay-harness/rlh-web-frontend'), version: '0.0.2' }]

    expect(() => { rlh.verifyVersions(members) }).toThrow(/must share one version/)
    expect(() => { rlh.verifyVersions([members[0]!]) }).not.toThrow()
  })

  it('accepts independent vendored versions and rejects an unpublishable one', () => {
    const vendor = releaseFamily('vendor')
    const members = [
      { ...member('vendor/cordis', '@relay-harness/cordis'), version: '4.0.1' },
      { ...member('vendor/cosmokit', '@relay-harness/cosmokit'), version: '1.8.2' },
    ]

    expect(() => { vendor.verifyVersions(members) }).not.toThrow()
    expect(() => { vendor.verifyVersions([{ ...members[0]!, version: 'latest' }]) }).toThrow(/unpublishable version/)
  })

  it('requires a current official client build only for rlh artifacts', () => {
    const rlh = releaseFamily('rlh')
    const vendor = releaseFamily('vendor')
    const officialEnvironment = officialClientBuildEnvironment(resolve(import.meta.dirname, '../..'))
    vi.stubEnv('RLH_CLIENT_COMMIT_HASH', officialEnvironment.RLH_CLIENT_COMMIT_HASH)
    const official = buildFixture(officialEnvironment)
    const defaultBuild = buildFixture({})

    expect(() => { rlh.verifyBuildArtifacts(official) }).not.toThrow()
    expect(() => { rlh.verifyBuildArtifacts(defaultBuild) }).toThrow(/RLH_CLIENT_TITLE/)
    expect(() => { rlh.verifyBuildArtifacts(join(defaultBuild, 'missing')) }).toThrow(/record.*missing/)
    expect(() => { vendor.verifyBuildArtifacts(join(defaultBuild, 'missing')) }).not.toThrow()

    write(join(official, 'packages/client/example/lib/client.js'), 'module.exports = { changed: true }\n')
    expect(() => { rlh.verifyBuildArtifacts(official) }).toThrow(/artifacts differ/)
  })

  it('publishes a dependency before its consumer, and orders ties by name', () => {
    const rlh = releaseFamily('rlh')
    const members = [
      member('packages/a/consumer', '@relay-harness/rlh-consumer', { dependencies: { '@relay-harness/rlh-library': 'workspace:^' } }),
      member('packages/a/library', '@relay-harness/rlh-library'),
      member('packages/a/zebra', '@relay-harness/rlh-zebra'),
    ]

    expect(rlh.publishOrder(members).order.map(entry => entry.name)).toEqual([
      '@relay-harness/rlh-library',
      '@relay-harness/rlh-consumer',
      '@relay-harness/rlh-zebra',
    ])
  })

  it('reports a runtime dependency cycle instead of emitting an arbitrary order', () => {
    const rlh = releaseFamily('rlh')
    const members = [
      member('packages/a/left', '@relay-harness/rlh-left', { dependencies: { '@relay-harness/rlh-right': 'workspace:^' } }),
      member('packages/a/right', '@relay-harness/rlh-right', { dependencies: { '@relay-harness/rlh-left': 'workspace:^' } }),
    ]

    expect(() => { rlh.publishOrder(members) }).toThrow(/dependency cycle/)
  })

  it('publishes a peer before its consumer', () => {
    const rlh = releaseFamily('rlh')
    const members = [
      member('packages/a/consumer', '@relay-harness/rlh-consumer', { peerDependencies: { '@relay-harness/rlh-zebra': 'workspace:^' } }),
      member('packages/a/zebra', '@relay-harness/rlh-zebra'),
    ]

    // Name order alone would place the consumer first; the peer edge moves it.
    expect(rlh.publishOrder(members).order.map(entry => entry.name)).toEqual([
      '@relay-harness/rlh-zebra',
      '@relay-harness/rlh-consumer',
    ])
  })

  it('orders around a peer cycle rather than refusing to publish, and reports the edge it dropped', () => {
    const rlh = releaseFamily('rlh')
    const members = [
      member('packages/a/left', '@relay-harness/rlh-left', { peerDependencies: { '@relay-harness/rlh-right': 'workspace:^' } }),
      member('packages/a/right', '@relay-harness/rlh-right', { peerDependencies: { '@relay-harness/rlh-left': 'workspace:^' } }),
    ]

    // Sibling packages declare each other as peers, and npm treats an unmet peer
    // as a warning, so this pair has to publish rather than fail the release.
    const plan = rlh.publishOrder(members)
    expect(plan.order.map(entry => entry.name)).toEqual([
      '@relay-harness/rlh-right',
      '@relay-harness/rlh-left',
    ])
    // One of the two edges has to give, and which one it is belongs in the log.
    expect(plan.droppedPeerEdges).toEqual([
      { consumer: '@relay-harness/rlh-right', peer: '@relay-harness/rlh-left' },
    ])
  })

  it('honours an install edge even when a peer cycle surrounds it', () => {
    const rlh = releaseFamily('rlh')
    const members = [
      member('packages/a/base', '@relay-harness/rlh-base', { peerDependencies: { '@relay-harness/rlh-consumer': 'workspace:^' } }),
      member('packages/a/consumer', '@relay-harness/rlh-consumer', {
        dependencies: { '@relay-harness/rlh-base': 'workspace:^' },
        peerDependencies: { '@relay-harness/rlh-base': 'workspace:^' },
      }),
    ]

    // The install edge is absolute: base publishes first, and the peer edge that
    // would reverse it is the one dropped.
    const plan = rlh.publishOrder(members)
    expect(plan.order.map(entry => entry.name)).toEqual([
      '@relay-harness/rlh-base',
      '@relay-harness/rlh-consumer',
    ])
    expect(plan.droppedPeerEdges).toEqual([
      { consumer: '@relay-harness/rlh-base', peer: '@relay-harness/rlh-consumer' },
    ])
  })

  it('refuses an order that would publish a consumer before a dependency it installs', () => {
    const rlh = releaseFamily('rlh')
    const members = [
      member('packages/a/alpha', '@relay-harness/rlh-alpha', { peerDependencies: { '@relay-harness/rlh-bravo': 'workspace:^' } }),
      member('packages/a/bravo', '@relay-harness/rlh-bravo', { peerDependencies: { '@relay-harness/rlh-charlie': 'workspace:^' } }),
      member('packages/a/charlie', '@relay-harness/rlh-charlie', { dependencies: { '@relay-harness/rlh-alpha': 'workspace:^' } }),
    ]

    // A cycle of two peer edges closed by one install edge: dropping a peer edge
    // would order this, and the traversal drops the install edge instead. That
    // order would publish charlie before the alpha it installs, so it is refused
    // here rather than published.
    expect(() => { rlh.publishOrder(members) }).toThrow(/no publish order honours @relay-harness\/rlh-charlie -> @relay-harness\/rlh-alpha/)
  })

  it('ignores devDependencies when ordering', () => {
    const rlh = releaseFamily('rlh')
    const members = [
      member('packages/a/alpha', '@relay-harness/rlh-alpha', { devDependencies: { '@relay-harness/rlh-zebra': 'workspace:^' } }),
      member('packages/a/zebra', '@relay-harness/rlh-zebra'),
    ]

    // A dev dependency is absent from the published package, so it must not move
    // the consumer behind it.
    expect(rlh.publishOrder(members).order.map(entry => entry.name)).toEqual([
      '@relay-harness/rlh-alpha',
      '@relay-harness/rlh-zebra',
    ])
  })

  it('applies the harness payload policy to rlh and keeps upstream payloads for vendored packages', () => {
    const rlh = releaseFamily('rlh')
    const vendor = releaseFamily('vendor')
    const harness = member('packages/a/library', '@relay-harness/rlh-library')
    const vendored = member('vendor/cordis', '@relay-harness/cordis')

    expect(() => { rlh.validatePayload(harness, ['package/lib/index.js', 'package/src/index.ts']) })
      .toThrow(/publishes source file/)
    expect(() => { vendor.validatePayload(vendored, ['package/lib/index.js', 'package/src/index.ts']) }).not.toThrow()
    expect(() => { vendor.validatePayload(vendored, []) }).toThrow(/empty tarball/)
  })

  it('drives the installed entry only for the family that publishes one', () => {
    expect(releaseFamily('rlh').installedEntry).toEqual({ packageName: '@relay-harness/rlh', binPath: 'lib/bin.js' })
    expect(releaseFamily('vendor').installedEntry).toBeUndefined()
  })

  it('rejects an unknown family identifier', () => {
    expect(() => { releaseFamily('native') }).toThrow(/unknown release family/)
  })
})

describe('vendored version baseline', () => {
  it('drops an upstream prerelease segment and increments the patch', () => {
    expect(nextVendorVersion('4.0.0-rc.7', undefined)).toBe('4.0.1')
    expect(nextVendorVersion('1.0.0-rc.5', undefined)).toBe('1.0.1')
    expect(nextVendorVersion('1.8.1', undefined)).toBe('1.8.2')
  })

  it('increments from the last published version when a re-sync restored a lower one', () => {
    // Upstream moved rc.7 -> rc.8 after this repository published 4.0.1;
    // incrementing the manifest alone would name 4.0.1 a second time.
    expect(nextVendorVersion('4.0.0-rc.8', '4.0.1')).toBe('4.0.2')
    expect(nextVendorVersion('4.1.0', '4.0.1')).toBe('4.1.1')
  })

  it('appends a rehearsal prerelease without consuming its release numbers', () => {
    // A rehearsal burns 4.0.1-rc.1 and leaves 4.0.1 free, so the stable release
    // that follows takes those same numbers instead of skipping to 4.0.2.
    expect(nextVendorVersion('4.0.0-rc.7', undefined, 'rc.1')).toBe('4.0.1-rc.1')
    expect(nextVendorVersion('4.0.0-rc.7', '4.0.1-rc.1', 'rc.2')).toBe('4.0.1-rc.2')
    expect(nextVendorVersion('4.0.0-rc.7', '4.0.1-rc.1')).toBe('4.0.1')
    expect(nextVendorVersion('4.0.0-rc.7', '4.0.1')).toBe('4.0.2')
  })
})

describe('version precedence', () => {
  it('ranks a release above the prerelease it follows', () => {
    // git --sort=v:refname disagrees, placing 4.0.1-rc.1 above 4.0.1, which is
    // why the newest published version is chosen here rather than by git.
    expect(compareVersions('4.0.1', '4.0.1-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('4.0.1-rc.1', '4.0.1')).toBeLessThan(0)
  })

  it('compares numeric prerelease fields numerically', () => {
    expect(compareVersions('4.0.1-rc.10', '4.0.1-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('4.0.1-rc.2', '4.0.1-rc.10')).toBeLessThan(0)
  })

  it('ranks a numeric field below an alphanumeric one, and a shorter list below a longer', () => {
    expect(compareVersions('4.0.1-1', '4.0.1-alpha')).toBeLessThan(0)
    expect(compareVersions('4.0.1-rc', '4.0.1-rc.1')).toBeLessThan(0)
    expect(compareVersions('4.0.2', '4.0.1')).toBeGreaterThan(0)
    expect(compareVersions('4.0.1-rc.1', '4.0.1-rc.1')).toBe(0)
  })
})

describe('payload change judgement', () => {
  const sourceShipping = member('vendor/cosmokit', '@relay-harness/cosmokit', {
    files: ['lib/index.js', 'lib/types/**/*.d.ts', 'src'],
  })
  const buildOutputOnly = member('vendor/cordis', '@relay-harness/cordis', {
    files: ['lib/index.js', 'lib/types/**/*.d.ts', 'bin.js'],
  })

  it('counts the manifest and the files npm always publishes', () => {
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/package.json')).toBe(true)
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/README.md')).toBe(true)
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/src/index.ts')).toBe(true)
  })

  it('counts build inputs for a package whose payload is build output', () => {
    // cordis publishes lib/ only, and lib/ is not tracked: without this, a real
    // source change reads as "nothing changed" and the next publish fails on a
    // version whose bytes moved.
    expect(reachesPayload(buildOutputOnly, 'vendor/cordis/src/context.ts')).toBe(true)
    expect(reachesPayload(buildOutputOnly, 'vendor/cordis/tsconfig.json')).toBe(true)
  })

  it('ignores paths no tarball carries', () => {
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/tests/unit.spec.ts')).toBe(false)
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/CHANGELOG.md')).toBe(false)
    // The README pattern is deliberately loose: over-reporting a change costs one
    // unnecessary patch bump, while under-reporting fails the next publish on a
    // version whose bytes moved.
    expect(reachesPayload(sourceShipping, 'vendor/cosmokit/README.i18n.yaml')).toBe(true)
    expect(reachesPayload(member('packages/a/library', '@relay-harness/rlh-library', { files: ['lib/index.js'] }),
      'packages/a/library/tests/library.spec.ts')).toBe(false)
  })
})
