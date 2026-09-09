/** Gate: the hand-maintained apps/web test lane lists must agree, so a new
 * test cannot silently escape typecheck. Three lists name the same lane:
 * tsconfig.host.json roots the host-plane specs, apps/web/tsconfig.json holds
 * them out of the client program (one program cannot see both sides of the
 * cordis Context merges), and scripts/run-web-snapshots.ts orders the serial
 * browser owners. Drift between the first two drops a spec from the host
 * program or roots it in the wrong one. */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Shared helper imported by specs on both planes; imports add it to either
 * program regardless of exclusion, so it is rooted in host and absent from
 * the client exclude on purpose. */
const sharedHelpers = new Set(['apps/web/tests/support.ts'])

function readConfigEntries(relPath: string, key: 'include' | 'exclude'): string[] {
  const read = ts.readConfigFile(resolve(root, relPath), file => ts.sys.readFile(file))
  if (read.error !== undefined) {
    throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  }
  const entries = (read.config as Record<string, unknown>)[key]
  if (!Array.isArray(entries)) {
    throw new Error(`${relPath} ${key} must be an array`)
  }
  return entries.filter((entry): entry is string => typeof entry === 'string')
}

function hostWebTestEntries(): string[] {
  return readConfigEntries('tsconfig.host.json', 'include')
    .filter(entry => entry.startsWith('apps/web/tests/'))
}

/** Client exclude entries are apps/web-relative (`tests/...`); normalize to
 * repository-relative paths so the two lists compare directly. */
function clientExcludedEntries(): string[] {
  return readConfigEntries('apps/web/tsconfig.json', 'exclude')
    .map(entry => entry.replaceAll('\\', '/'))
    .map(entry => entry.startsWith('tests/') ? `apps/web/${entry}` : entry)
}

/** Serial browser owners are read out of the runner source; importing the
 * module would spawn browser runs. */
function snapshotSerialFiles(): string[] {
  const source = readFileSync(resolve(root, 'scripts/run-web-snapshots.ts'), 'utf8')
  const match = /const serialFiles = \[([^\]]*)\]/.exec(source)
  if (match === null || match[1] === undefined) {
    throw new Error('scripts/run-web-snapshots.ts no longer declares a serialFiles array')
  }
  return [...match[1].matchAll(/'([^']+)'/g)]
    .map(quoted => quoted[1])
    .filter((entry): entry is string => entry !== undefined)
}

describe('apps/web test lane lists', () => {
  it('excludes from the client program exactly the host-plane specs', () => {
    const host = new Set(hostWebTestEntries())
    for (const helper of sharedHelpers) {
      host.delete(helper)
    }
    const excluded = new Set(clientExcludedEntries())
    expect([...excluded].filter(entry => !host.has(entry)).sort())
      .toEqual([])
    expect([...host].filter(entry => !excluded.has(entry)).sort())
      .toEqual([])
  })

  it('names only existing files in every list', () => {
    const lists = {
      'tsconfig.host.json include': hostWebTestEntries(),
      'apps/web/tsconfig.json exclude': clientExcludedEntries(),
      'scripts/run-web-snapshots.ts serialFiles': snapshotSerialFiles(),
    }
    for (const [list, entries] of Object.entries(lists)) {
      expect(entries.filter(entry => !existsSync(resolve(root, entry))), list).toEqual([])
    }
  })
})
