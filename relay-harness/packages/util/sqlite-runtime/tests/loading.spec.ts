import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

const root = fileURLToPath(new URL('../../../../', import.meta.url))
const entry = new URL('../src/index.ts', import.meta.url).href
const notice = 'SQLite is an experimental feature and might change at any time'
afterEach(() => { vi.restoreAllMocks(); vi.resetModules() })

function cold(script: string): string {
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  delete env.NODE_NO_WARNINGS
  return execFileSync(process.execPath, ['--import', 'tsx/esm', '--input-type=module', '-e', script], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })
}

describe('Node SQLite load owner', () => {
  it('cold-loads a real database without notices and leaves later warnings intact', () => {
    const result = cold(`
      import assert from 'node:assert/strict';
      const warnings = [];
      process.on('warning', warning => warnings.push([warning.name, warning.message]));
      const original = process.emitWarning;
      const { loadNodeSqlite } = await import(${JSON.stringify(entry)});
      assert.equal(process.emitWarning, original);
      const sqlite = loadNodeSqlite();
      assert.equal(process.emitWarning, original);
      assert.equal(loadNodeSqlite(), sqlite);
      const db = new sqlite.DatabaseSync(':memory:');
      db.exec("CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES ('committed')");
      assert.equal(db.prepare('SELECT value FROM proof').get().value, 'committed');
      db.close();
      process.emitWarning('unrelated experimental feature', 'ExperimentalWarning');
      process.emitWarning(${JSON.stringify(notice)}, 'DeprecationWarning');
      await new Promise(resolve => setImmediate(resolve));
      console.log(JSON.stringify(warnings));
    `)
    expect(JSON.parse(result)).toEqual([
      ['ExperimentalWarning', 'unrelated experimental feature'],
      ['DeprecationWarning', notice],
    ])
  })

  it.each(['subagent', 'workflow'])('cold imports and uses the %s owner without an eager warning', (owner) => {
    const url = new URL(owner === 'subagent' ? '../../../subagent/subagent/src/activation-lease.ts' : '../../../workflow/workflow-worker-thread/src/journal-lock.ts', import.meta.url).href
    const result = cold(`
      import assert from 'node:assert/strict';
      import { mkdtempSync, rmSync } from 'node:fs';
      import { join } from 'node:path';
      import { tmpdir } from 'node:os';
      const warnings = [];
      process.on('warning', warning => warnings.push(warning.message));
      const target = await import(${JSON.stringify(url)});
      const directory = mkdtempSync(join(tmpdir(), 'rlh-sqlite-cold-'));
      try {
        ${owner === 'subagent' ? "const store = new target.SubagentActivationLeaseStore(join(directory, 'lease.sqlite')); store.close();" : "const release = target.claimWorkflowJournal(join(directory, 'journal.jsonl')); release();"}
        await new Promise(resolve => setImmediate(resolve));
        console.log(JSON.stringify(warnings));
      } finally { rmSync(directory, { recursive: true, force: true }); }
    `)
    expect(JSON.parse(result)).toEqual([])
  })

  it('delegates every non-matching warning overload and restores the emitter after a failed load', async () => {
    const forwarded = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
    const builtin = vi.spyOn(process, 'getBuiltinModule').mockImplementation(() => {
      process.emitWarning(notice, 'ExperimentalWarning')
      process.emitWarning(notice, { type: 'ExperimentalWarning' })
      const matching = new Error(notice); matching.name = 'ExperimentalWarning'
      process.emitWarning(matching)
      process.emitWarning('another feature', 'ExperimentalWarning', 'TEST_WARNING')
      process.emitWarning(notice, 'DeprecationWarning')
      process.emitWarning('ordinary warning')
      throw new Error('builtin unavailable')
    })
    const { loadNodeSqlite } = await import('../src/index.ts')
    expect(() => loadNodeSqlite()).toThrow('builtin unavailable')
    expect(Reflect.get(process, 'emitWarning')).toBe(forwarded)
    expect(forwarded.mock.calls).toEqual([
      ['another feature', 'ExperimentalWarning', 'TEST_WARNING'],
      [notice, 'DeprecationWarning'],
      ['ordinary warning'],
    ])
    builtin.mockRestore()
    const sqlite = loadNodeSqlite()
    expect(sqlite.DatabaseSync).toBeTypeOf('function')
    expect(Reflect.get(process, 'emitWarning')).toBe(forwarded)
  })
})
