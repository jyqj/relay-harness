const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { LOCKED_INSTALL_ARGS, readPluginLock, lockedPackages } = require('../../scripts/vendor-lock');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-lock-check-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = { name: 'fixture', version: '1.0.0' };
  const lock = { name: pkg.name, version: pkg.version, lockfileVersion: 3, packages: { '': pkg } };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  const writeLock = () => fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  writeLock();
  return { root, pkg, lock, writeLock };
}

test('release dependency installation is lock-only, skips scripts, and takes peers from its Host', () => {
  assert.equal(LOCKED_INSTALL_ARGS[0], 'ci');
  for (const arg of ['--omit=dev', '--ignore-scripts', '--legacy-peer-deps', '--workspaces=false']) assert.ok(LOCKED_INSTALL_ARGS.includes(arg));
  assert.equal(LOCKED_INSTALL_ARGS.includes('install'), false);
});

test('a zero-production-dependency plugin has a valid empty install, not an invented registry resolution', (t) => {
  const { root } = fixture(t);
  assert.deepEqual(lockedPackages(root), []);
});

test('lock validation rejects identity drift, manifest drift, and missing production records', (t) => {
  const { root, lock, writeLock } = fixture(t);
  lock.packages[''] = { name: 'another', version: '1.0.0' };
  writeLock();
  assert.throws(() => readPluginLock(root), /identity mismatch/);
  const pkg = { name: 'fixture', version: '1.0.0', dependencies: { missing: '1.0.0' } };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
  lock.packages[''] = { name: 'fixture', version: '1.0.0' };
  writeLock();
  assert.throws(() => readPluginLock(root), /dependencies mismatch/);
  lock.packages[''] = pkg;
  writeLock();
  assert.throws(() => readPluginLock(root), /omits production dependency/);
  lock.packages['node_modules/missing'] = { version: '1.0.0' };
  writeLock();
  assert.throws(() => readPluginLock(root), /resolution and integrity/);
});

test('packaged install actually invokes npm ci with the shared immutable flags', (t) => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, 'node_modules'));
  fs.writeFileSync(path.join(root, 'node_modules', 'stale'), 'stale');
  const file = path.resolve(__dirname, '../../scripts/after-pack.js');
  const calls = [];
  const module = { exports: {} };
  const ordinaryRequire = require('node:module').createRequire(file);
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, process, console, Buffer,
    require: (name) => name === 'child_process'
      ? { spawnSync: (command, args, options) => { calls.push({ command, args: [...args], cwd: options.cwd }); return { status: 0 }; }, execFileSync() {} }
      : ordinaryRequire(name),
  }, { filename: file });
  const result = module.exports.installPluginRuntimeDeps(root);
  assert.equal(result.installed, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, [...LOCKED_INSTALL_ARGS]);
  assert.equal(calls[0].cwd, root);
  assert.equal(fs.existsSync(path.join(root, 'node_modules', 'stale')), false);
});
