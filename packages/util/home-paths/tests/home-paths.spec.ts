import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_RLH_HOME_DISPLAY,
  RLH_HOME_DIR_NAME,
  canonicalizeWatchPath,
  defaultRlhHome,
  rlhHomeDisplay,
  rlhHomePath,
  expandHomePath,
  resolveRlhHome,
} from '@relay-harness/rlh-home-paths'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('rlh path helpers', () => {
  it('owns the shared default RLH home directory name', () => {
    expect(RLH_HOME_DIR_NAME).toBe('.rlh')
    expect(DEFAULT_RLH_HOME_DISPLAY).toBe('~/.rlh')
    expect(defaultRlhHome()).toBe(join(homedir(), '.rlh'))
  })

  it('expands tilde paths without changing non-tilde paths', () => {
    expect(expandHomePath('~')).toBe(homedir())
    expect(expandHomePath('~/.rlh')).toBe(join(homedir(), '.rlh'))
    expect(expandHomePath('~\\.rlh')).toBe(join(homedir(), '.rlh'))
    expect(expandHomePath('/tmp/.rlh')).toBe('/tmp/.rlh')
    expect(expandHomePath('~other/.rlh')).toBe('~other/.rlh')
  })

  it('resolves explicit path before RLH_HOME and the default', () => {
    const envHome = join(homedir(), 'env-rlh')

    expect(resolveRlhHome('/tmp/explicit-rlh', { RLH_HOME: '~/env-rlh' })).toBe(resolve('/tmp/explicit-rlh'))
    expect(resolveRlhHome(undefined, { RLH_HOME: '~/env-rlh' })).toBe(envHome)
    expect(resolveRlhHome(undefined, {})).toBe(defaultRlhHome())
  })

  it('treats an empty or whitespace-only RLH_HOME as unset', () => {
    expect(resolveRlhHome(undefined, { RLH_HOME: '' })).toBe(defaultRlhHome())
    expect(resolveRlhHome(undefined, { RLH_HOME: '   ' })).toBe(defaultRlhHome())
  })

  it('joins child segments onto the resolved RLH_HOME', () => {
    vi.stubEnv('RLH_HOME', '~/env-rlh')
    expect(rlhHomePath()).toBe(join(homedir(), 'env-rlh'))
    expect(rlhHomePath('storages', 'cache')).toBe(join(homedir(), 'env-rlh', 'storages', 'cache'))
  })

  it('labels a resolved home by whether it is the default root', () => {
    expect(rlhHomeDisplay(resolve(defaultRlhHome()))).toBe('~/.rlh')
    expect(rlhHomeDisplay('/some/other/root')).toBe('$RLH_HOME')
  })

  it('canonicalizes a watcher ancestor while preserving a missing suffix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rlh-watch-path-'))
    const target = join(root, 'target')
    const alias = join(root, 'alias')
    try {
      await mkdir(target)
      await symlink(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      await expect(canonicalizeWatchPath(join(alias, 'later', 'config.yml'))).resolves.toBe(
        join(await realpath(target), 'later', 'config.yml'),
      )
      const file = join(root, 'file')
      await writeFile(file, 'not a directory')
      await expect(canonicalizeWatchPath(join(file, 'child'))).rejects.toMatchObject({ code: 'ENOTDIR' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
