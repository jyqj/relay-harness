'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  RLHBOT_BEGIN,
  RLHBOT_END,
  ensureRlhbotPlugin,
} = require('./rlhbot-preset');

function writeSource(dir) {
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'client'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'presets', 'rlhbot-room'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({
    name: 'rlhbot',
    version: '0.1.0',
    type: 'module',
    main: 'lib/index.js',
    exports: {
      '.': './lib/index.js',
      './ask-participant': './lib/ask-participant.js',
      './client': './client/client.js',
    },
    rlh: {
      bundle: { patch: './cordis.patch.yml' },
      client: { platform: 'web', inject: [] },
    },
  }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(dir, 'lib', 'index.js'), 'export const name = "rlh-bot"\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'client', 'client.js'), 'export function apply() {}\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: rlh-bot',
    "      name: 'rlhbot'",
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(
    path.join(dir, 'presets', 'rlhbot-room', 'agent.cordis.yml'),
    '- id: persona\n  name: \'@relay-harness/rlh-persona\'\n',
    'utf8',
  );
  fs.writeFileSync(
    path.join(dir, 'presets', 'rlhbot-room', 'preset.yml'),
    'name: 群聊主持\n',
    'utf8',
  );
  return dir;
}

test('ensureRlhbotPlugin copies the bundled package, room preset, and inserts a managed patch', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rlh-home-'));
  const source = writeSource(fs.mkdtempSync(path.join(os.tmpdir(), 'rlhbot-src-')));
  try {
    const profileDir = path.join(home, 'profiles', 'web');
    const result = ensureRlhbotPlugin({ sourceDir: source, profileDir });
    assert.equal(result.ok, true);
    assert.equal(result.added, true);
    const dest = path.join(profileDir, 'desktop-plugins', 'rlhbot');
    assert.equal(fs.readFileSync(path.join(dest, 'lib', 'index.js'), 'utf8'), 'export const name = "rlh-bot"\n');
    assert.equal(fs.existsSync(path.join(dest, 'client', 'client.js')), true);
    const linked = path.join(profileDir, 'node_modules', 'rlhbot');
    assert.equal(fs.existsSync(path.join(linked, 'package.json')), true);
    const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
    assert.ok(patch.includes(RLHBOT_BEGIN));
    assert.ok(patch.includes(RLHBOT_END));
    assert.ok(patch.includes('id: rlh-bot'));
    assert.match(patch, /name: ['"]rlhbot['"]/);
    const preset = path.join(home, '.agent-presets', 'rlhbot-room', 'agent.cordis.yml');
    assert.equal(fs.existsSync(preset), true);
    const manifestFile = path.join(profileDir, 'package.json');
    assert.equal(fs.existsSync(manifestFile), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('ensureRlhbotPlugin refreshes the bundled copy on later starts', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rlh-home-'));
  const source = writeSource(fs.mkdtempSync(path.join(os.tmpdir(), 'rlhbot-src-')));
  try {
    const profileDir = path.join(home, 'profiles', 'web');
    ensureRlhbotPlugin({ sourceDir: source, profileDir });
    fs.writeFileSync(path.join(source, 'lib', 'index.js'), 'export const name = "updated"\n', 'utf8');
    const again = ensureRlhbotPlugin({ sourceDir: source, profileDir });
    assert.equal(again.ok, true);
    assert.equal(again.added, false);
    const dest = path.join(profileDir, 'desktop-plugins', 'rlhbot', 'lib', 'index.js');
    assert.equal(fs.readFileSync(dest, 'utf8'), 'export const name = "updated"\n');
    const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
    assert.equal(patch.split(RLHBOT_BEGIN).length, 2);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('ensureRlhbotPlugin skips the patch insert when the profile already lists the bundle', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rlh-home-'));
  const source = writeSource(fs.mkdtempSync(path.join(os.tmpdir(), 'rlhbot-src-')));
  try {
    const profileDir = path.join(home, 'profiles', 'web');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify({
      dependencies: { rlhbot: '0.1.0' },
      rlh: { profile: { bundles: ['@relay-harness/rlh-web-app', 'rlhbot'] } },
    }, null, 2)}\n`, 'utf8');
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), [
      RLHBOT_BEGIN,
      '- insert:',
      '    - id: rlh-bot',
      '      name: "rlhbot"',
      RLHBOT_END,
      '',
    ].join('\n'), 'utf8');
    const result = ensureRlhbotPlugin({ sourceDir: source, profileDir });
    assert.equal(result.ok, true);
    assert.equal(result.added, false);
    const patch = fs.readFileSync(path.join(profileDir, 'cordis.patch.yml'), 'utf8');
    assert.equal(patch.includes(RLHBOT_BEGIN), false);
    assert.equal(patch.includes('id: rlh-bot'), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('ensureRlhbotPlugin does not replace a pnpm-installed rlhbot directory', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rlh-home-'));
  const source = writeSource(fs.mkdtempSync(path.join(os.tmpdir(), 'rlhbot-src-')));
  try {
    const profileDir = path.join(home, 'profiles', 'web');
    const installed = path.join(profileDir, 'node_modules', 'rlhbot');
    fs.mkdirSync(installed, { recursive: true });
    fs.writeFileSync(path.join(installed, 'package.json'), '{"name":"rlhbot","version":"9.9.9"}\n', 'utf8');
    ensureRlhbotPlugin({ sourceDir: source, profileDir });
    assert.equal(JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version, '9.9.9');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

test('ensureRlhbotPlugin fails closed when the bundled package is missing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rlh-home-'));
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'rlhbot-missing-'));
  try {
    const result = ensureRlhbotPlugin({
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

test('ensureRlhbotPlugin fails closed when the room preset is missing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rlh-home-'));
  const source = writeSource(fs.mkdtempSync(path.join(os.tmpdir(), 'rlhbot-src-')));
  try {
    fs.rmSync(path.join(source, 'presets'), { recursive: true, force: true });
    const result = ensureRlhbotPlugin({
      sourceDir: source,
      profileDir: path.join(home, 'profiles', 'web'),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /missing-source:preset/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(source, { recursive: true, force: true });
  }
});

// Entry points and versions are gated in vendor/vendor-plugins.test.js, which
// reads them from package.json; this covers what the offline profile copy
// reads and package.json does not name.
test('repo vendors rlhbot for offline profile copy', () => {
  const root = path.join(__dirname, '..', '..', 'vendor', 'rlhbot');
  assert.equal(fs.existsSync(path.join(root, 'cordis.patch.yml')), true);
  assert.equal(fs.existsSync(path.join(root, 'presets', 'rlhbot-room', 'agent.cordis.yml')), true);
});
