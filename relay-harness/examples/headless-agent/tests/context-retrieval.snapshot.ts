import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runLoaderSmoke, LOADER_SMOKE_TEST_TIMEOUT_MS } from '@relay-harness/rlh-loader-smoke'
import type { SessionEvent } from '@relay-harness/rlh-session'
import { expect, it } from 'vitest'

const configPath = fileURLToPath(new URL('../context.cordis.snapshot.yml', import.meta.url))
const binScript = fileURLToPath(new URL('./fixtures/headless-driver.ts', import.meta.url))
const expectedPath = fileURLToPath(new URL('./context-retrieval.expected.json', import.meta.url))

it('retrieves real workspace evidence through the headless Loader and ordinary tool transcript', async () => {
  const result = await runLoaderSmoke({
    label: 'explicit context retrieval', tempDirPrefix: 'rlh-context-snapshot-', configPath,
    binScript, libBinScript: binScript, binArgs: [configPath, 'go'],
    tsconfigPath: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
    env: { RLH_SNAPSHOT: 'replay' },
    prepare: async cwd => { await writeFile(join(cwd, 'marker.ts'), 'export function spoolQuantaMarker() { return 42 }\n') },
  })
  expect(result.stderr).toBe('')
  const records = result.stdout.trim().split('\n').map(line => JSON.parse(line) as { type: string; event?: SessionEvent; output?: string })
  const events = records.flatMap(record => record.event === undefined ? [] : [record.event])
  const calls = events.filter(event => event.type === 'tool/call')
  const results = events.filter(event => event.type === 'tool/result')
  const receipt = results[0]
  if (receipt?.type !== 'tool/result') throw new Error('missing ordinary tool result')
  const content = receipt.data.message.content[0].content
  const text = content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  expect(text).toContain('spoolQuantaMarker')
  expect(text).toContain('"verification":"verified"')
  const summary = {
    output: records.at(-1)?.output,
    calls: calls.map(event => event.type === 'tool/call' ? event.data.name : ''),
    toolResults: results.length,
    userMessages: events.filter(event => event.type === 'user/message').map(event => event.type === 'user/message' ? event.data.source.kind : ''),
    contextTraces: events.filter(event => event.type === 'context/prepared').length,
  }
  expect(summary).toEqual(JSON.parse(await readFile(expectedPath, 'utf8')))
}, LOADER_SMOKE_TEST_TIMEOUT_MS)
