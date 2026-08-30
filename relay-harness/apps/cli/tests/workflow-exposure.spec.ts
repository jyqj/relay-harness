/** Shipped agent-preset exposure of the non-sandboxing workflow engine. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@relay-harness/cordis-plugin-include'

const presetRoot = fileURLToPath(new URL('../config/agent-presets/', import.meta.url))

function rowIds(preset: string): string[] {
  const parsed = yaml.load(
    readFileSync(join(presetRoot, preset, 'agent.cordis.yml'), 'utf8'),
    { schema: entryListSchema },
  )
  if (!Array.isArray(parsed)) throw new TypeError(`${preset} preset must parse to an entry list`)
  const ids: string[] = []
  const visit = (rows: unknown[]): void => {
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) continue
      const entry = row as { id?: string; config?: unknown[] }
      if (entry.id !== undefined) ids.push(entry.id)
      if (Array.isArray(entry.config)) visit(entry.config)
    }
  }
  visit(parsed)
  return ids
}

describe('shipped workflow exposure', () => {
  it.each(['standard', 'code'])('keeps arbitrary model-written workflows out of the ordinary-user %s preset', (preset) => {
    expect(rowIds(preset)).toContain('workflow-worker-thread')
    expect(rowIds(preset)).not.toContain('tool-workflow')
    expect(rowIds(preset)).toContain('tool-ralph')
  })

  it('retains workflow as an explicit developer opt-in through the cordis preset', () => {
    expect(rowIds('cordis')).toContain('workflow-worker-thread')
    expect(rowIds('cordis')).toContain('tool-workflow')
    expect(rowIds('cordis')).toContain('tool-ralph')
  })
})
