'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  RLHMARKET_BEGIN,
  RLHMARKET_END,
  ensureRlhMarketPlugin,
} = require('./rlhmarket-preset');

function writeSource(dir) {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'client'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
    name: 'rlhmarket',
    version: '1.14.0',
    type: 'module',
    main: 'lib/index.js',
    exports: { '.': './lib/index.js', './client': './client/client.js' },
    rlh: {
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web', inject: [] },
    },
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export const name = "rlh-market"\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'client', 'client.js'), 'export function apply() {}\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: rlh-market',
    "      name: 'rlhmarket'",
    '',
  ].join('\n'), 'utf8');
  return dir;
}

test('ensureRlhMarketPlugin copies the bundled package and inserts a managed patch', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rlh-home-'));
  const source = writeSource(fs.mkdtempSync(path.join(os.tmpdir(), 'rlhmarket-src-')));
  try {
    const profileDir = path.join(home, 'profiles', 'web');
    const result = ensureRlhMarketPlugin({ sourceDir: source, profileDir });
    assert.equal(result.ok, true);
    assert.equal(result.added, true);
    const dest = path.join(profileDir, 'desktop-plugins', 'rlhmarket');
    assert.equal(fs.readFileSync(path.join(dest, 'lib', 'index.js'), 'utf8'), 'export const name = "rlh-market"\n');
    assert.equal(fs.existsSync(path.join(dest, 'client', 'client.js')), true);
    const linked = path.join(profileDir, 'node_modules', 'rlhmarket');
    assert.equal(fs.existsSync(path.join(linked, 'package.json')), true);
    const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
    assert.ok(patch.includes(RLHMARKET_BEGIN));
    assert.ok(patch.includes(RLHMARKET_END));
    assert.ok(patch.includes('id: rlh-market'));
    assert.match(patch, /name: ['"]rlhmarket['"]/);
    const manifestFile = path.join(profileDir, 'package.json');
    assert.equal(fs.existsSync(manifestFile), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('ensureRlhMarketPlugin refreshes the bundled copy on later starts', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rlh-home-'));
  const source = writeSource(fs.mkdtempSync(path.join(os.tmpdir(), 'rlhmarket-src-')));
  try {
    const profileDir = path.join(home, 'profiles', 'web');
    ensureRlhMarketPlugin({ sourceDir: source, profileDir });
    fs.writeFileSync(path.join(source, 'lib', 'index.js'), 'export const name = "updated"\n', 'utf8');
    const again = ensureRlhMarketPlugin({ sourceDir: source, profileDir });
    assert.equal(again.ok, true);
    assert.equal(again.added, false);
    const dest = path.join(profileDir, 'desktop-plugins', 'rlhmarket', 'lib', 'index.js');
    assert.equal(fs.readFileSync(dest, 'utf8'), 'export const name = "updated"\n');
    const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
    assert.equal(patch.split(RLHMARKET_BEGIN).length, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('ensureRlhMarketPlugin skips the patch insert when the profile already lists the bundle', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rlh-home-'));
  const source = writeSource(fs.mkdtempSync(path.join(os.tmpdir(), 'rlhmarket-src-')));
  try {
    const profileDir = path.join(home, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify({
      dependencies: { rlhmarket: '1.14.0' },
      rlh: { profile: { bundles: ['@relay-harness/rlh-web-app', 'rlhmarket'] } },
    }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
      RLHMARKET_BEGIN,
      '- insert:',
      '    - id: rlh-market',
      '      name: "rlhmarket"',
      RLHMARKET_END,
      '',
    ].join('\n'), 'utf8');
    const result = ensureRlhMarketPlugin({ sourceDir: source, profileDir });
    assert.equal(result.ok, true);
    assert.equal(result.added, false);
    const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
    assert.equal(patch.includes(RLHMARKET_BEGIN), false);
    assert.equal(patch.includes('id: rlh-market'), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('ensureRlhMarketPlugin does not replace a pnpm-installed rlhmarket directory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rlh-home-'));
  const source = writeSource(fs.mkdtempSync(path.join(os.tmpdir(), 'rlhmarket-src-')));
  try {
    const profileDir = path.join(home, 'profiles', 'web');
    const installed = path.join(profileDir, 'node_modules', 'rlhmarket');
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, 'package.json'), '{"name":"rlhmarket","version":"9.9.9"}\n', 'utf8');
    ensureRlhMarketPlugin({ sourceDir: source, profileDir });
    assert.equal(JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version, '9.9.9');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('ensureRlhMarketPlugin fails closed when the bundled package is missing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rlh-home-'));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'rlhmarket-missing-'));
  try {
    const result = ensureRlhMarketPlugin({
      sourceDir: source,
      profileDir: path.join(home, 'profiles', 'web'),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /missing-source/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('ensureRlhMarketPlugin copies bundled node_modules with the package', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rlh-home-'));
  const source = writeSource(fs.mkdtempSync(path.join(os.tmpdir(), 'rlhmarket-src-')));
  try {
    const pkgFile = path.join(source, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    pkg.dependencies = { undici: '7.29.0' };
    fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    fs.mkdirSync(path.join(source, 'node_modules', 'undici'), { recursive: true });
    fs.writeFileSync(path.join(source, 'node_modules', 'undici', 'package.json'), '{"name":"undici"}\n', 'utf8');
    const profileDir = path.join(home, 'profiles', 'web');
    const result = ensureRlhMarketPlugin({ sourceDir: source, profileDir });
    assert.equal(result.ok, true);
    const dest = path.join(profileDir, 'desktop-plugins', 'rlhmarket', 'node_modules', 'undici', 'package.json');
    assert.equal(fs.existsSync(dest), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('ensureRlhMarketPlugin fails closed and strips the insert when runtime deps are missing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rlh-home-'));
  const source = writeSource(fs.mkdtempSync(path.join(os.tmpdir(), 'rlhmarket-src-')));
  try {
    const pkgFile = path.join(source, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    pkg.dependencies = { undici: '7.29.0' };
    fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    const profileDir = path.join(home, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
      RLHMARKET_BEGIN,
      '- insert:',
      '    - id: rlh-market',
      '      name: "rlhmarket"',
      RLHMARKET_END,
      '',
    ].join('\n'), 'utf8');
    const dest = path.join(profileDir, 'desktop-plugins', 'rlhmarket', 'lib');
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'index.js'), 'export const name = "kept"\n', 'utf8');
    const result = ensureRlhMarketPlugin({ sourceDir: source, profileDir });
    assert.equal(result.ok, false);
    assert.match(result.error, /missing-source:node_modules:undici/);
    const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
    assert.equal(patch.includes(RLHMARKET_BEGIN), false);
    assert.equal(patch.includes('id: rlh-market'), false);
    assert.equal(fs.readFileSync(path.join(dest, 'index.js'), 'utf8'), 'export const name = "kept"\n');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('ensureRlhMarketPlugin fails closed when a dependency export file is missing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rlh-home-'));
  const source = writeSource(fs.mkdtempSync(path.join(os.tmpdir(), 'rlhmarket-src-')));
  try {
    const pkgFile = path.join(source, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    pkg.dependencies = { 'js-yaml': '4.1.1' };
    fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
    const yamlDir = path.join(source, 'node_modules', 'js-yaml');
    fs.mkdirSync(yamlDir, { recursive: true });
    fs.writeFileSync(path.join(yamlDir, 'package.json'), `${JSON.stringify({
      name: 'js-yaml',
      exports: { '.': { import: './dist/js-yaml.mjs', require: './index.js' } },
    })}\n`, 'utf8');
    fs.writeFileSync(path.join(yamlDir, 'index.js'), 'module.exports = {}\n', 'utf8');
    const profileDir = path.join(home, 'profiles', 'web');
    const result = ensureRlhMarketPlugin({ sourceDir: source, profileDir });
    assert.equal(result.ok, false);
    assert.match(result.error, /js-yaml\.mjs/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('repo vendors published rlhmarket package source', () => {
  const root = path.join(__dirname, '..', '..', 'vendor', 'rlhmarket');
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'rlhmarket');
  assert.equal(pkg.version, '1.14.0');
  assert.equal(fs.existsSync(path.join(root, 'client', 'client.js')), true);
  assert.equal(fs.existsSync(path.join(root, 'lib', 'index.js')), true);
  assert.equal(fs.existsSync(path.join(root, 'cordis.patch.yml')), true);
  assert.ok(pkg.dependencies && pkg.dependencies.undici && pkg.dependencies['js-yaml']);
});

test('rlhmarket extraResources is nested under vendor so electron-builder keeps node_modules', () => {
  const extra = require('../../package.json').build.extraResources;
  const market = extra.find((entry) => (
    entry
    && entry.from === 'vendor'
    && entry.to === 'vendor'
    && Array.isArray(entry.filter)
    && entry.filter.includes('rlhmarket/**')
  ));
  assert.ok(market, 'rlhmarket extraResources must copy from vendor with filter rlhmarket/**');
  assert.equal(extra.some((entry) => entry && entry.from === 'vendor/rlhmarket'), false);
});
