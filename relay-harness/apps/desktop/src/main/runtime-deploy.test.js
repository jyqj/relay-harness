const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const test = require('node:test');
const { assembleRuntimeDeploy, validateRuntimeDeploy } = require('../../scripts/runtime-deploy');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlh-runtime-deploy-test-'));
  const source = path.join(root, 'source'), stage = path.join(root, 'stage'), output = path.join(root, 'output');
  const write = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  };
  const cli = { name: '@relay-harness/rlh', version: '1.0.0', type: 'commonjs', files: ['lib', 'config'], dependencies: {} };
  write(path.join(source, 'apps/cli/package.json'), cli);
  write(path.join(source, 'apps/web/dist/index.html'), '<h1>built web</h1>');
  write(path.join(source, 'apps/desktop/dist/forbidden'), 'desktop output');
  write(path.join(source, '.env'), 'PRIVATE_FIXTURE');
  write(path.join(source, 'LICENSE'), 'root license');
  write(path.join(source, 'THIRD_PARTY_NOTICES.md'), 'third-party notices');
  write(path.join(stage, 'package.json'), cli);
  write(path.join(stage, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  write(path.join(stage, 'lib/bin.js'), 'console.log(require("commander").version, require("consumer"));');
  write(path.join(stage, 'config/profile.yml'), 'profile fixture');
  write(path.join(stage, 'config/agent-presets/standard/.rlh/skills/example/SKILL.md'), 'published skill');
  for (const [dir, version] of [['commander', '15.0.0'], ['consumer/node_modules/commander', '8.3.0']]) {
    write(path.join(stage, 'node_modules', dir, 'package.json'), { name: 'commander', version, main: 'index.js' });
    write(path.join(stage, 'node_modules', dir, 'index.js'), `module.exports = {version:${JSON.stringify(version)}};`);
  }
  write(path.join(stage, 'node_modules/consumer/package.json'), { name: 'consumer', version: '1.0.0', main: 'index.js' });
  write(path.join(stage, 'node_modules/consumer/index.js'), 'module.exports = require("commander").version;');
  write(path.join(stage, 'node_modules/consumer/LICENSE.md'), 'consumer license');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, source, stage, output, write };
}

test('production assembly preserves dependency-version resolution, licenses, and the published artifact boundary', (t) => {
  const { source, stage, output } = fixture(t);
  assembleRuntimeDeploy(source, stage, output);
  assert.equal(execFileSync(process.execPath, [path.join(output, 'apps/cli/lib/bin.js')], { encoding: 'utf8' }), '15.0.0 8.3.0\n');
  assert.equal(fs.readFileSync(path.join(output, 'node_modules/consumer/LICENSE.md'), 'utf8'), 'consumer license');
  assert.equal(fs.readFileSync(path.join(output, 'LICENSE'), 'utf8'), 'root license');
  assert.equal(fs.readFileSync(path.join(output, 'apps/cli/config/agent-presets/standard/.rlh/skills/example/SKILL.md'), 'utf8'), 'published skill');
  assert.equal(fs.existsSync(path.join(output, 'apps/desktop')), false);
  assert.equal(fs.existsSync(path.join(output, '.env')), false);
  assert.equal(fs.existsSync(path.join(output, 'apps/cli/pnpm-lock.yaml')), false);
});

test('deployment rejects development/runtime-recursion packages', (t) => {
  const { stage, write } = fixture(t);
  write(path.join(stage, 'node_modules/electron/package.json'), { name: 'electron', version: '1.0.0' });
  assert.throws(() => validateRuntimeDeploy(stage), /development\/build package electron/);
});

test('deployment refuses a directory link that escapes the staged graph', (t) => {
  const { root, stage } = fixture(t);
  const external = path.join(root, 'external');
  fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(stage, 'node_modules/foreign'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validateRuntimeDeploy(stage), /escapes its graph/);
});

test('deployment requires built CLI and a lockfile instead of silently copying a checkout', (t) => {
  const { stage } = fixture(t);
  fs.unlinkSync(path.join(stage, 'pnpm-lock.yaml'));
  assert.throws(() => validateRuntimeDeploy(stage), /no lockfile/);
});

test('assembly rejects a shared bundle chunk omitted by the publication manifest', (t) => {
  const { source, stage, output, write } = fixture(t);
  write(path.join(stage, 'node_modules/@relay-harness/owned/package.json'), {
    name: '@relay-harness/owned', version: '1.0.0', type: 'module',
  });
  write(path.join(stage, 'node_modules/@relay-harness/owned/lib/index.js'), 'export { value } from "./shared-hash.js";');
  assert.throws(() => assembleRuntimeDeploy(source, stage, output), /Published import is absent:.*shared-hash/);
});

test('assembly refuses stale output and a mismatched CLI version', (t) => {
  const { source, stage, output, write } = fixture(t);
  write(path.join(output, 'stale.txt'), 'previous build');
  assert.throws(() => assembleRuntimeDeploy(source, stage, output), /empty destination/);
  assert.equal(fs.readFileSync(path.join(output, 'stale.txt'), 'utf8'), 'previous build');
  fs.rmSync(output, { recursive: true, force: true });
  write(path.join(stage, 'package.json'), { name: '@relay-harness/rlh', version: 'old' });
  assert.throws(() => assembleRuntimeDeploy(source, stage, output), /CLI version differs/);
});
