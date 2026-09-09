'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  assertHarnessRuntime,
  assertVendoredPluginRuntimeDeps,
  nodePtyPrebuildRelative,
  resolveDeployDir,
  resolveResourcesDir,
  restoreVendoredPluginNodeModules,
  installPluginRuntimeDeps,
} = require('../../scripts/after-pack');

const RC7_PIN = { npm: '0.1.0-rc.7' };

/** Runtime-file tests reuse real release lock metadata while supplying minimal non-executed module fixtures. */
function prepareLockedPluginFixture(packageDir) {
  const vendor = path.resolve(__dirname, '../../vendor/rlhmarket');
  fs.copyFileSync(path.join(vendor, 'package.json'), path.join(packageDir, 'package.json'));
  fs.copyFileSync(path.join(vendor, 'package-lock.json'), path.join(packageDir, 'package-lock.json'));
  const lock = JSON.parse(fs.readFileSync(path.join(vendor, 'package-lock.json'), 'utf8'));
  for (const name of ['js-yaml', 'argparse', 'undici']) {
    const dir = path.join(packageDir, 'node_modules', name);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'package.json');
    const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { name, main: 'index.js' };
    fs.writeFileSync(file, JSON.stringify({ ...existing, version: lock.packages[`node_modules/${name}`].version }));
    if (name !== 'js-yaml') fs.writeFileSync(path.join(dir, 'index.js'), 'module.exports = {}\n');
  }
}


function writeRuntimeVersions(root, npm) {
  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify({ version: npm })}\n`);
  fs.mkdirSync(path.join(root, 'apps', 'cli'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps', 'cli', 'package.json'), `${JSON.stringify({ version: npm })}\n`);
}

function writeNodePtyPrebuild(root, platform = process.platform, arch = process.arch) {
  const relative = nodePtyPrebuildRelative(platform, arch);
  const file = path.join(root, 'node_modules', 'node-pty', relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'node-pty', 'package.json'), '{"name":"node-pty"}\n');
  fs.writeFileSync(file, 'native');
}

test('resolveDeployDir ignores local caches unless a deploy directory is explicit', () => {
  assert.equal(resolveDeployDir(undefined), null);
  assert.equal(resolveDeployDir(''), null);
  assert.equal(resolveDeployDir('off'), null);
  assert.equal(resolveDeployDir('.pack-release'), path.resolve('.pack-release'));
});

function writeGhosttyTerminalPackage(root) {
  const base = path.join(root, 'node_modules', '@relay-harness', 'rlh-client-ui-user-terminal', 'lib');
  fs.mkdirSync(path.join(base, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(base, 'client.js'), 'export {}\n');
  for (const name of ['ghostty-vt.wasm', 'ghostty-write-pty.wasm', 'SymbolsNerdFontMono-Regular.woff2']) {
    fs.writeFileSync(path.join(base, 'assets', name), 'asset');
  }
}

test('assertHarnessRuntime accepts a complete compatible host', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-runtime-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = new Map([
    [path.join('apps', 'cli', 'lib', 'bin.js'), 'export {}\n'],
    [path.join('apps', 'cli', 'lib', 'plugin.js'), 'missingHostFeatures parseCompatibilityFeatures\n'],
    [path.join('apps', 'web', 'dist', 'index.html'), '<!doctype html>\n'],
    [
      path.join('node_modules', '@relay-harness', 'rlh-app-boot', 'lib', 'features.js'),
      'conversation.chat.user-actions session.fork.beforeSeq session.fork.blank\n',
    ],
    [
      path.join('node_modules', '@relay-harness', 'rlh-client-modules', 'lib', 'index.js'),
      'missingHostFeatures parseCompatibilityFeatures\n',
    ],
    [
      path.join('node_modules', '@relay-harness', 'rlh-client-ui-conversation', 'lib', 'client.js'),
      'conversation.chat.user-actions\n',
    ],
    [path.join('node_modules', '@relay-harness', 'rlh-mcp-servers-file', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-host-mcp-servers', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-host-skill-inventory', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-mcp', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-mcp', 'lib', 'client.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-skills', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-skills', 'lib', 'client.js'), 'export {}\n'],
  ]);
  for (const [relative, content] of files) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  writeRuntimeVersions(root, RC7_PIN.npm);
  writeNodePtyPrebuild(root);
  writeGhosttyTerminalPackage(root);

  assert.doesNotThrow(() => assertHarnessRuntime(root, RC7_PIN));
});

test('assertHarnessRuntime rejects a host missing Ghostty terminal assets', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-ghostty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = new Map([
    [path.join('apps', 'cli', 'lib', 'bin.js'), 'export {}\n'],
    [path.join('apps', 'cli', 'lib', 'plugin.js'), 'missingHostFeatures parseCompatibilityFeatures\n'],
    [path.join('apps', 'web', 'dist', 'index.html'), '<!doctype html>\n'],
    [
      path.join('node_modules', '@relay-harness', 'rlh-app-boot', 'lib', 'features.js'),
      'conversation.chat.user-actions session.fork.beforeSeq session.fork.blank\n',
    ],
    [
      path.join('node_modules', '@relay-harness', 'rlh-client-modules', 'lib', 'index.js'),
      'missingHostFeatures parseCompatibilityFeatures\n',
    ],
    [
      path.join('node_modules', '@relay-harness', 'rlh-client-ui-conversation', 'lib', 'client.js'),
      'conversation.chat.user-actions\n',
    ],
    [path.join('node_modules', '@relay-harness', 'rlh-mcp-servers-file', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-host-mcp-servers', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-host-skill-inventory', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-mcp', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-mcp', 'lib', 'client.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-skills', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-skills', 'lib', 'client.js'), 'export {}\n'],
    [
      path.join('node_modules', '@relay-harness', 'rlh-client-ui-user-terminal', 'lib', 'client.js'),
      'export {}\n',
    ],
  ]);
  for (const [relative, content] of files) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  writeRuntimeVersions(root, RC7_PIN.npm);
  writeNodePtyPrebuild(root);

  assert.throws(
    () => assertHarnessRuntime(root, RC7_PIN),
    /ghostty-vt\.wasm/,
  );
});

test('assertHarnessRuntime rejects a host missing MCP settings runtime', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-mcp-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = new Map([
    [path.join('apps', 'cli', 'lib', 'bin.js'), 'export {}\n'],
    [path.join('apps', 'cli', 'lib', 'plugin.js'), 'missingHostFeatures parseCompatibilityFeatures\n'],
    [path.join('apps', 'web', 'dist', 'index.html'), '<!doctype html>\n'],
    [
      path.join('node_modules', '@relay-harness', 'rlh-app-boot', 'lib', 'features.js'),
      'conversation.chat.user-actions session.fork.beforeSeq session.fork.blank\n',
    ],
    [
      path.join('node_modules', '@relay-harness', 'rlh-client-modules', 'lib', 'index.js'),
      'missingHostFeatures parseCompatibilityFeatures\n',
    ],
    [
      path.join('node_modules', '@relay-harness', 'rlh-client-ui-conversation', 'lib', 'client.js'),
      'conversation.chat.user-actions\n',
    ],
  ]);
  for (const [relative, content] of files) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }

  assert.throws(
    () => assertHarnessRuntime(root, RC7_PIN),
    /rlh-mcp-servers-file/,
  );
});

test('assertHarnessRuntime rejects stale deploy output before archiving', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-stale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'apps', 'cli', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'apps', 'web', 'dist'), { recursive: true });
  fs.writeFileSync(path.join(root, 'apps', 'cli', 'lib', 'bin.js'), 'export {}\n');
  fs.writeFileSync(path.join(root, 'apps', 'web', 'dist', 'index.html'), '<!doctype html>\n');

  assert.throws(
    () => assertHarnessRuntime(root, RC7_PIN),
    /rlh-app-boot.*features\.js/,
  );
});

test('assertHarnessRuntime rejects pin.npm mismatch', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-pin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = new Map([
    [path.join('apps', 'cli', 'lib', 'bin.js'), 'export {}\n'],
    [path.join('apps', 'cli', 'lib', 'plugin.js'), 'missingHostFeatures parseCompatibilityFeatures\n'],
    [path.join('apps', 'web', 'dist', 'index.html'), '<!doctype html>\n'],
    [
      path.join('node_modules', '@relay-harness', 'rlh-app-boot', 'lib', 'features.js'),
      'conversation.chat.user-actions session.fork.beforeSeq session.fork.blank\n',
    ],
    [
      path.join('node_modules', '@relay-harness', 'rlh-client-modules', 'lib', 'index.js'),
      'missingHostFeatures parseCompatibilityFeatures\n',
    ],
    [
      path.join('node_modules', '@relay-harness', 'rlh-client-ui-conversation', 'lib', 'client.js'),
      'conversation.chat.user-actions\n',
    ],
    [path.join('node_modules', '@relay-harness', 'rlh-mcp-servers-file', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-host-mcp-servers', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-host-skill-inventory', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-mcp', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-mcp', 'lib', 'client.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-skills', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-skills', 'lib', 'client.js'), 'export {}\n'],
  ]);
  for (const [relative, content] of files) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  writeRuntimeVersions(root, '0.1.0-rc.5');
  writeNodePtyPrebuild(root);
  writeGhosttyTerminalPackage(root);
  assert.throws(
    () => assertHarnessRuntime(root, { npm: '0.1.0-rc.7' }),
    /0\.1\.0-rc\.7/,
  );
});

test('assertHarnessRuntime rejects a missing node-pty prebuild', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-pty-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = new Map([
    [path.join('apps', 'cli', 'lib', 'bin.js'), 'export {}\n'],
    [path.join('apps', 'cli', 'lib', 'plugin.js'), 'missingHostFeatures parseCompatibilityFeatures\n'],
    [path.join('apps', 'web', 'dist', 'index.html'), '<!doctype html>\n'],
    [
      path.join('node_modules', '@relay-harness', 'rlh-app-boot', 'lib', 'features.js'),
      'conversation.chat.user-actions session.fork.beforeSeq session.fork.blank\n',
    ],
    [
      path.join('node_modules', '@relay-harness', 'rlh-client-modules', 'lib', 'index.js'),
      'missingHostFeatures parseCompatibilityFeatures\n',
    ],
    [
      path.join('node_modules', '@relay-harness', 'rlh-client-ui-conversation', 'lib', 'client.js'),
      'conversation.chat.user-actions\n',
    ],
    [path.join('node_modules', '@relay-harness', 'rlh-mcp-servers-file', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-host-mcp-servers', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-host-skill-inventory', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-mcp', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-mcp', 'lib', 'client.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-skills', 'lib', 'index.js'), 'export {}\n'],
    [path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-skills', 'lib', 'client.js'), 'export {}\n'],
  ]);
  for (const [relative, content] of files) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  writeRuntimeVersions(root, RC7_PIN.npm);
  writeGhosttyTerminalPackage(root);
  assert.throws(
    () => assertHarnessRuntime(root, RC7_PIN),
    /node-pty/,
  );
});

test('resolveResourcesDir uses Contents/Resources inside the macOS .app', () => {
  const darwin = resolveResourcesDir({
    electronPlatformName: 'darwin',
    appOutDir: path.join('dist', 'mac-arm64'),
    packager: { appInfo: { productFilename: 'Relay-Harness-Desktop' } },
  });
  assert.equal(
    darwin,
    path.join('dist', 'mac-arm64', 'Relay-Harness-Desktop.app', 'Contents', 'Resources'),
  );
});

test('resolveResourcesDir prefers electron-builder getResourcesDir', () => {
  const expected = path.join('out', 'Resources');
  assert.equal(
    resolveResourcesDir({
      electronPlatformName: 'darwin',
      appOutDir: path.join('dist', 'mac'),
      packager: {
        getResourcesDir: (appOutDir) => {
          assert.equal(appOutDir, path.join('dist', 'mac'));
          return expected;
        },
      },
    }),
    expected,
  );
});

test('resolveResourcesDir uses the unpacked resources folder on Windows', () => {
  assert.equal(
    resolveResourcesDir({
      electronPlatformName: 'win32',
      appOutDir: path.join('dist', 'win-unpacked'),
    }),
    path.join('dist', 'win-unpacked', 'resources'),
  );
});

test('restoreVendoredPluginNodeModules copies dropped plugin node_modules', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-plugin-nm-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const projectDir = path.join(workspace, 'project');
  const resources = path.join(workspace, 'resources');
  const srcNm = path.join(projectDir, 'vendor', 'rlhmarket', 'node_modules', 'undici');
  const destPkg = path.join(resources, 'vendor', 'rlhmarket');
  fs.mkdirSync(srcNm, { recursive: true });
  fs.mkdirSync(destPkg, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'vendor', 'rlhmarket', 'package.json'),
    `${JSON.stringify({ name: 'rlhmarket', dependencies: { undici: '7.29.0' } })}\n`,
  );
  fs.writeFileSync(path.join(srcNm, 'package.json'), '{"name":"undici"}\n');
  fs.writeFileSync(
    path.join(destPkg, 'package.json'),
    `${JSON.stringify({ name: 'rlhmarket', dependencies: { undici: '7.29.0' } })}\n`,
  );

  const result = restoreVendoredPluginNodeModules(projectDir, resources, 'rlhmarket');
  assert.equal(result.restored, true);
  assertVendoredPluginRuntimeDeps(resources, 'rlhmarket');
  assert.equal(
    fs.existsSync(path.join(destPkg, 'node_modules', 'undici', 'package.json')),
    true,
  );
});

test('assertVendoredPluginRuntimeDeps rejects a packaged plugin without its dependencies', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-plugin-missing-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const destPkg = path.join(workspace, 'vendor', 'rlhmarket');
  fs.mkdirSync(destPkg, { recursive: true });
  fs.writeFileSync(
    path.join(destPkg, 'package.json'),
    `${JSON.stringify({ name: 'rlhmarket', dependencies: { undici: '7.29.0' } })}\n`,
  );
  assert.throws(
    () => assertVendoredPluginRuntimeDeps(workspace, 'rlhmarket'),
    /undici/,
  );
});

test('assertVendoredPluginRuntimeDeps rejects a dependency whose export file is missing', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-plugin-export-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const destPkg = path.join(workspace, 'vendor', 'rlhmarket');
  const yamlDir = path.join(destPkg, 'node_modules', 'js-yaml');
  fs.mkdirSync(yamlDir, { recursive: true });
  fs.writeFileSync(
    path.join(destPkg, 'package.json'),
    `${JSON.stringify({ name: 'rlhmarket', dependencies: { 'js-yaml': '4.1.1' } })}\n`,
  );
  fs.writeFileSync(path.join(yamlDir, 'package.json'), `${JSON.stringify({
    name: 'js-yaml',
    exports: { '.': { import: './dist/js-yaml.mjs', require: './index.js' } },
  })}\n`);
  fs.writeFileSync(path.join(yamlDir, 'index.js'), 'module.exports = {}\n');
  assert.throws(
    () => assertVendoredPluginRuntimeDeps(workspace, 'rlhmarket'),
    /js-yaml\.mjs/,
  );
});

test('installPluginRuntimeDeps repairs missing exports through a locked install', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-plugin-npm-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const destPkg = path.join(workspace, 'vendor', 'rlhmarket');
  const yamlDir = path.join(destPkg, 'node_modules', 'js-yaml');
  fs.mkdirSync(yamlDir, { recursive: true });
  fs.writeFileSync(
    path.join(destPkg, 'package.json'),
    `${JSON.stringify({ name: 'rlhmarket', dependencies: { 'js-yaml': '4.1.1' } })}\n`,
  );
  fs.writeFileSync(path.join(yamlDir, 'package.json'), `${JSON.stringify({
    name: 'js-yaml',
    exports: { '.': { import: './dist/js-yaml.mjs' } },
  })}\n`);
  prepareLockedPluginFixture(destPkg);
  let ran = '';
  const result = installPluginRuntimeDeps(destPkg, {
    skipIfComplete: true,
    run: (dir) => {
      ran = dir;
      fs.mkdirSync(path.join(dir, 'node_modules', 'js-yaml', 'dist'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'node_modules', 'js-yaml', 'dist', 'js-yaml.mjs'),
        'export default {}\n',
      );
    },
  });
  assert.equal(result.installed, true);
  assert.equal(ran, destPkg);
  assertVendoredPluginRuntimeDeps(workspace, 'rlhmarket');
});

test('assertVendoredPluginRuntimeDeps accepts a hoisted nested dependency', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-plugin-hoist-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const destPkg = path.join(workspace, 'vendor', 'rlhmarket');
  const yamlDir = path.join(destPkg, 'node_modules', 'js-yaml');
  const argparseDir = path.join(destPkg, 'node_modules', 'argparse');
  fs.mkdirSync(path.join(yamlDir, 'dist'), { recursive: true });
  fs.mkdirSync(argparseDir, { recursive: true });
  fs.writeFileSync(
    path.join(destPkg, 'package.json'),
    `${JSON.stringify({ name: 'rlhmarket', dependencies: { 'js-yaml': '4.1.1' } })}\n`,
  );
  fs.writeFileSync(path.join(yamlDir, 'package.json'), `${JSON.stringify({
    name: 'js-yaml',
    exports: { '.': { import: './dist/js-yaml.mjs' } },
    dependencies: { argparse: '2.0.1' },
  })}\n`);
  fs.writeFileSync(path.join(yamlDir, 'dist', 'js-yaml.mjs'), 'export default {}\n');
  fs.writeFileSync(
    path.join(argparseDir, 'package.json'),
    `${JSON.stringify({ name: 'argparse', main: './index.js' })}\n`,
  );
  fs.writeFileSync(path.join(argparseDir, 'index.js'), 'module.exports = {}\n');
  assert.doesNotThrow(() => assertVendoredPluginRuntimeDeps(workspace, 'rlhmarket'));
});

test('installPluginRuntimeDeps skipIfComplete does not run npm when export files exist', (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-plugin-skip-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const destPkg = path.join(workspace, 'vendor', 'rlhmarket');
  const yamlDir = path.join(destPkg, 'node_modules', 'js-yaml', 'dist');
  fs.mkdirSync(yamlDir, { recursive: true });
  fs.writeFileSync(
    path.join(destPkg, 'package.json'),
    `${JSON.stringify({ name: 'rlhmarket', dependencies: { 'js-yaml': '4.1.1' } })}\n`,
  );
  fs.writeFileSync(
    path.join(destPkg, 'node_modules', 'js-yaml', 'package.json'),
    `${JSON.stringify({
      name: 'js-yaml',
      exports: { '.': { import: './dist/js-yaml.mjs' } },
    })}\n`,
  );
  fs.writeFileSync(path.join(yamlDir, 'js-yaml.mjs'), 'export default {}\n');
  prepareLockedPluginFixture(destPkg);
  let ran = false;
  const result = installPluginRuntimeDeps(destPkg, {
    skipIfComplete: true,
    run: () => {
      ran = true;
    },
  });
  assert.equal(result.installed, false);
  assert.equal(ran, false);
});


test('missing vendor lock fails before touching an existing install or invoking npm', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-missing-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  fs.mkdirSync(path.join(root, 'node_modules'));
  const sentinel = path.join(root, 'node_modules', 'keep.txt');
  fs.writeFileSync(sentinel, 'original install');
  let invoked = false;
  assert.throws(() => installPluginRuntimeDeps(root, { run: () => { invoked = true; } }), /requires a regular package-lock/);
  assert.equal(invoked, false);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'original install');
});

test('a complete but version-drifted install cannot bypass its lock', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'after-pack-drift-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  prepareLockedPluginFixture(root);
  const yaml = path.join(root, 'node_modules/js-yaml');
  fs.writeFileSync(path.join(yaml, 'index.js'), 'module.exports = {}\n');
  fs.writeFileSync(path.join(yaml, 'package.json'), JSON.stringify({ name: 'js-yaml', version: '0.0.0', main: 'index.js' }));
  let invoked = false;
  const result = installPluginRuntimeDeps(root, { skipIfComplete: true, run: () => { invoked = true; } });
  assert.equal(result.installed, true);
  assert.equal(invoked, true);
});

test('afterPack rejects cross-architecture assembly before reading or mutating packaged resources', async () => {
  const afterPack = require('../../scripts/after-pack');
  const { Arch } = require('electron-builder');
  await assert.rejects(afterPack({
    electronPlatformName: process.platform,
    arch: process.arch === 'arm64' ? Arch.x64 : Arch.arm64,
    get packager() { throw new Error('packaged resources were accessed before target validation'); },
  }), /native platform and architecture runner/);
});

test('native runtime target validation covers all supported build architectures and rejects unspecified targets', () => {
  const { assertNativeRuntimeTarget } = require('../../scripts/after-pack');
  const { Arch } = require('electron-builder');
  for (const [arch, runnerArch] of [['x64', 'x64'], ['arm64', 'arm64'], ['ia32', 'ia32'], ['armv7l', 'arm']]) {
    assert.doesNotThrow(() => assertNativeRuntimeTarget({ electronPlatformName: 'linux', arch: Arch[arch] }, { platform: 'linux', arch: runnerArch }));
  }
  const runner = { platform: 'darwin', arch: 'arm64' };
  for (const target of [
    { electronPlatformName: 'win32', arch: Arch.arm64 },
    { electronPlatformName: 'darwin', arch: Arch.x64 },
    { electronPlatformName: 'darwin', arch: Arch.universal },
    { electronPlatformName: 'darwin', arch: 999 },
    { electronPlatformName: 'darwin', arch: 'arm64' },
    { electronPlatformName: 'darwin' },
    { arch: Arch.arm64 },
  ]) assert.throws(() => assertNativeRuntimeTarget(target, runner), /native platform and architecture runner/);
});
