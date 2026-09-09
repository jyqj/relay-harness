const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const sink = { write() {} };

async function runner() { return (await import('../../scripts/smoke-process.mjs')).runSmokeProcess; }

function running(pid) {
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
  return result.status === 0 && !result.stdout.trim().startsWith('Z');
}

test('smoke runner drains output before reporting normal exit', async () => {
  const run = await runner();
  let output = '';
  const result = await run(process.execPath, ['-e', 'process.stdout.write("completed")'], {
    cwd: process.cwd(), env: process.env, timeoutMs: 5_000, label: 'normal smoke',
    stdout: { write(chunk) { output += chunk; } }, stderr: sink,
  });
  assert.deepEqual(result, { code: 0, signal: null });
  assert.equal(output, 'completed');
});

test('smoke runner rejects spawn errors without leaving timers armed', async () => {
  const run = await runner();
  await assert.rejects(run(join(tmpdir(), 'absent-relay-smoke-executable'), [], {
    cwd: process.cwd(), env: process.env, timeoutMs: 10_000, label: 'missing smoke', stdout: sink, stderr: sink,
  }), /ENOENT/);
});

test('timeout kills a TERM-resistant owner and its separate descendant group before rejecting', {
  skip: process.platform === 'win32' ? 'POSIX signal resistance; Windows uses taskkill /t /f' : false,
  timeout: 15_000,
}, async (t) => {
  const run = await runner();
  const directory = mkdtempSync(join(tmpdir(), 'rlh-smoke-process-'));
  const marker = join(directory, 'pids.json');
  const script = `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:['ignore','inherit','inherit']});
    require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid]));
    process.on('SIGTERM',()=>{});setInterval(()=>{},1000);
  `;
  t.after(() => {
    // Test-failure cleanup remains scoped to the children this fixture recorded.
    try {
      for (const pid of JSON.parse(readFileSync(marker, 'utf8'))) {
        if (running(pid)) {
          try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    rmSync(directory, { recursive: true, force: true });
  });
  await assert.rejects(run(process.execPath, ['-e', script], {
    cwd: directory, env: process.env, timeoutMs: 1_500, terminationGraceMs: 100,
    label: 'resistant smoke', stdout: sink, stderr: sink,
  }), /resistant smoke timed out/);
  for (const pid of JSON.parse(readFileSync(marker, 'utf8'))) assert.equal(running(pid), false);

});

test('a zero owner exit cannot report success while an observed detached worker remains alive', {
  skip: process.platform === 'win32' ? 'POSIX process-group observation' : false,
  timeout: 15_000,
}, async (t) => {
  const run = await runner();
  const directory = mkdtempSync(join(tmpdir(), 'rlh-smoke-exit-'));
  const marker = join(directory, 'child.json');
  const script = `
    const child=require('node:child_process').spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
    child.unref();require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify(child.pid));
    setTimeout(()=>process.exit(0),1300);
  `;
  t.after(() => {
    try {
      const pid = JSON.parse(readFileSync(marker, 'utf8'));
      if (running(pid)) process.kill(-pid, 'SIGKILL');
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error; }
    rmSync(directory, { recursive: true, force: true });
  });
  await assert.rejects(run(process.execPath, ['-e', script], {
    cwd: directory, env: process.env, timeoutMs: 5_000, terminationGraceMs: 100,
    label: 'early owner', stdout: sink, stderr: sink,
  }), /exited with live descendant process groups/);
  assert.equal(running(JSON.parse(readFileSync(marker, 'utf8'))), false);

});
