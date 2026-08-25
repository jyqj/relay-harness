'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  installablePlugins,
  installedPackages,
  lockedProductionInstall,
  manifest,
  missingSubtrees,
  vendorDir,
} = require('./vendor-manifest.js');

/** Every file path a package manifest names as an entry point. */
function declaredEntryPoints(pkg) {
  const paths = [];
  const collect = (value) => {
    if (typeof value === 'string') {
      if (value.startsWith('./')) paths.push(value.slice(2));
      return;
    }
    if (value && typeof value === 'object') for (const nested of Object.values(value)) collect(nested);
  };
  if (typeof pkg.main === 'string') paths.push(pkg.main);
  collect(pkg.exports);
  return [...new Set(paths)];
}

/** Paths git tracks under `vendor/`, or null outside a checkout. */
function trackedVendorPaths() {
  const result = spawnSync('git', ['ls-files', '-z', '--', '.'], { cwd: vendorDir, encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.split('\0').filter(Boolean);
}

test('no vendored install is committed', { skip: trackedVendorPaths() ? false : 'not a git checkout' }, () => {
  const committed = trackedVendorPaths().filter(file => file.split('/').includes('node_modules'));
  assert.deepEqual(committed, [],
    'vendored node_modules are installed from a lockfile, not committed — see vendor/README.md');
});

test('the vendor manifest names every vendored plugin directory', () => {
  const directories = fs.readdirSync(vendorDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort();
  assert.deepEqual(directories, Object.keys(manifest).sort());
});

for (const [name, record] of Object.entries(manifest)) {
  const root = path.join(vendorDir, name);

  test(`vendored ${name} matches the version the manifest pins`, () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(pkg.name, name);
    assert.equal(pkg.version, record.version);
  });

  test(`vendored ${name} carries every entry point its package.json declares`, () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const absent = missingSubtrees(name);
    const expected = declaredEntryPoints(pkg).filter(entry => !absent.some(subtree => entry.startsWith(`${subtree}/`)));
    const broken = expected.filter(entry => !fs.existsSync(path.join(root, entry)));
    assert.deepEqual(broken, [], `${name} declares entry points that are not vendored: ${broken.join(', ')}`);
  });

  test(`vendored ${name}'s lockfile resolves every dependency it declares`, {
    skip: installablePlugins().includes(name) ? false : `${name} vendors no package-lock.json`,
  }, () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const resolved = new Set(lockedProductionInstall(name).map(entry => entry.slice(0, entry.lastIndexOf('@'))));
    const unresolved = Object.keys(pkg.dependencies ?? {}).filter(dependency => !resolved.has(dependency));
    assert.deepEqual(unresolved, [], `vendor/${name}/package-lock.json cannot install: ${unresolved.join(', ')}`);
  });

  test(`vendored ${name}'s working install matches its lockfile`, {
    skip: installedPackages(name).length > 0 ? false : `vendor/${name}/node_modules is not installed here`,
  }, () => {
    assert.deepEqual(installedPackages(name), lockedProductionInstall(name),
      `run \`pnpm run vendor:sync\` from apps/desktop to bring vendor/${name}/node_modules back to its lockfile`);
  });

  test(`the manifest's record of what ${name} is missing is current`, () => {
    const stale = Object.keys(record.missing).filter(subtree => fs.existsSync(path.join(root, subtree)));
    assert.deepEqual(stale, [], `${name}/${stale.join(', ')} is vendored now — drop it from vendor/plugins.json and re-enable the suites that skip on it`);
    for (const [subtree, reason] of Object.entries(record.missing)) {
      assert.ok(reason.length > 0, `vendor/plugins.json must say why ${name}/${subtree} is absent`);
    }
  });
}
