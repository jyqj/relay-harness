'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { manifest, missingSubtrees, vendorDir } = require('./vendor-manifest.js');

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

  test(`the manifest's record of what ${name} is missing is current`, () => {
    const stale = Object.keys(record.missing).filter(subtree => fs.existsSync(path.join(root, subtree)));
    assert.deepEqual(stale, [], `${name}/${stale.join(', ')} is vendored now — drop it from vendor/plugins.json and re-enable the suites that skip on it`);
    for (const [subtree, reason] of Object.entries(record.missing)) {
      assert.ok(reason.length > 0, `vendor/plugins.json must say why ${name}/${subtree} is absent`);
    }
  });
}
