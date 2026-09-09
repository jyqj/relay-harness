const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

function digest(file) { return createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Prepare the locked production graph; never fall back to copying the checkout. */
function prepareRuntimeDeploy(projectDir) {
  const root = fs.realpathSync(path.resolve(projectDir, '../..'));
  const pnpm = process.env.npm_execpath || path.join(projectDir, 'node_modules/pnpm/bin/pnpm.cjs');
  const stage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rlh-desktop-deploy-')));
  const lock = path.join(root, 'pnpm-lock.yaml');
  const before = digest(lock);
  try {
    const result = spawnSync(process.execPath, [pnpm,
      '--filter', '@relay-harness/rlh', '--fail-if-no-match', 'deploy', stage,
      '--prod', '--ignore-scripts', '--config.inject-workspace-packages=true', '--config.node-linker=hoisted',
      '--config.force-legacy-deploy=false', '--config.shared-workspace-lockfile=true',
    ], { cwd: root, stdio: 'inherit', env: { ...process.env, CI: '1' } });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Locked desktop deployment failed (${result.status}); no workspace-copy fallback is allowed`);
    if (digest(lock) !== before) throw new Error('Desktop deployment changed the source lockfile');
    return { root: stage, sourceLockSha256: before };
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
}

/** Verify that a deploy is a self-contained physical dependency graph, retaining bin links. */
function validateRuntimeDeploy(stage) {
  const root = fs.realpathSync(stage);
  if (!fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) throw new Error('Runtime deploy has no lockfile');
  if (!fs.existsSync(path.join(root, 'lib/bin.js'))) throw new Error('Runtime deploy has no built CLI');
  const forbidden = new Set(['electron', 'electron-builder', 'relay-harness-desktop', 'rlh-jsonrpc-agent-pkg', '@relay-harness/rlh-root']);
  let files = 0;
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const target = fs.realpathSync(file);
        if (!within(root, target)) throw new Error(`Runtime deploy link escapes its graph: ${path.relative(root, file)}`);
        if (fs.statSync(target).isDirectory()) throw new Error('Runtime deploy requires a physical hoisted dependency layout');
        if (!file.split(path.sep).includes('.bin')) throw new Error(`Unexpected runtime file link: ${path.relative(root, file)}`);
      } else if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        files += 1;

      }
    }
  }
  walk(path.join(root, 'node_modules'));
  for (const directory of installedPackages(path.join(root, 'node_modules'))) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (forbidden.has(manifest.name)) throw new Error(`Runtime deploy includes development/build package ${manifest.name}`);
  }
  return files;
}

function installedPackages(nodeModules) {
  if (!fs.existsSync(nodeModules)) return [];
  const result = [];
  for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const container = path.join(nodeModules, entry.name);
    const packages = entry.name.startsWith('@')
      ? fs.readdirSync(container, { withFileTypes: true }).filter(row => row.isDirectory()).map(row => path.join(container, row.name))
      : [container];
    for (const directory of packages) {
      if (!fs.existsSync(path.join(directory, 'package.json'))) continue;
      result.push(directory, ...installedPackages(path.join(directory, 'node_modules')));
    }
  }
  return result;
}

function workspaceVersions(root) {
  const versions = new Map();
  for (const pattern of ['vendor/*/package.json', 'packages/*/*/package.json', 'apps/*/package.json', 'native/landlock-run/packages/*/package.json']) {
    for (const file of fs.globSync(pattern, { cwd: root })) {
      const manifest = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
      if (manifest.name && manifest.version) versions.set(manifest.name, manifest.version);
    }
  }
  return versions;
}

/** Copy only published CLI artifacts, the production dependency graph, and built Web assets. */
function assembleRuntimeDeploy(sourceRoot, stage, destination) {
  if (fs.existsSync(destination) && fs.readdirSync(destination).length > 0) {
    throw new Error('Runtime assembly requires an empty destination');
  }
  const count = validateRuntimeDeploy(stage);
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'apps/cli/package.json'), 'utf8'));
  const stagedManifest = JSON.parse(fs.readFileSync(path.join(stage, 'package.json'), 'utf8'));
  if (stagedManifest.version !== manifest.version) throw new Error('Runtime deploy CLI version differs from the source build');
  const roots = new Set(manifest.files.map(pattern => pattern.split('/')[0]));
  const cli = path.join(destination, 'apps/cli');
  fs.mkdirSync(cli, { recursive: true });
  for (const entry of fs.readdirSync(stage)) {
    if (entry === 'node_modules' || entry === 'pnpm-lock.yaml' || entry === 'pnpm-workspace.yaml') continue;
    if (entry !== 'package.json' && !roots.has(entry) && !/^(readme|licen[cs]e)(\.|$)/i.test(entry)) {
      throw new Error(`Unexpected deploy-root artifact: ${entry}`);
    }
    fs.cpSync(path.join(stage, entry), path.join(cli, entry), { recursive: true, verbatimSymlinks: true });
  }
  fs.cpSync(path.join(stage, 'node_modules'), path.join(destination, 'node_modules'), {
    recursive: true, verbatimSymlinks: true,
    filter: file => !['.modules.yaml', '.pnpm-workspace-state-v1.json', '.pnpm'].includes(path.basename(file)),
  });
  fs.cpSync(path.join(sourceRoot, 'apps/web/dist'), path.join(destination, 'apps/web/dist'), { recursive: true });
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    fs.copyFileSync(path.join(sourceRoot, name), path.join(destination, name));
  }
  const versions = workspaceVersions(sourceRoot);
  function rewrite(file) {
    const current = JSON.parse(fs.readFileSync(file, 'utf8'));
    let changed = false;
    for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      for (const [name, value] of Object.entries(current[section] || {})) {
        if (/^(workspace:|file:|link:)/.test(value) || value.includes('@file:')) {
          if (!versions.has(name)) throw new Error(`Unresolved local runtime dependency ${name}`);
          current[section][name] = versions.get(name);
          changed = true;
        }
      }
    }
    if (changed) fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
  }
  for (const directory of installedPackages(path.join(destination, 'node_modules'))) rewrite(path.join(directory, 'package.json'));
  // Use the source public manifest rather than deployment-only absolute file aliases.
  fs.writeFileSync(path.join(cli, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  rewrite(path.join(cli, 'package.json'));
  fs.writeFileSync(path.join(destination, 'package.json'), `${JSON.stringify({
    name: 'relay-harness-desktop-runtime', private: true, type: 'module', version: manifest.version,
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(destination, 'runtime-provenance.json'), `${JSON.stringify({
    schemaVersion: 1, deploymentLockSha256: digest(path.join(stage, 'pnpm-lock.yaml')),
    cliVersion: stagedManifest.version, nodeVersion: process.version, platform: process.platform, arch: process.arch,
  }, null, 2)}\n`);
  assertPublishedImports(destination);
  return count;
}

/** Check static relative imports against the actual published first-party files. */
function assertPublishedImports(root) {
  const ts = require('typescript');
  const { fileURLToPath, pathToFileURL } = require('node:url');
  const packages = [path.join(root, 'apps/cli'), ...installedPackages(path.join(root, 'node_modules'))
    .filter(directory => JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).name?.startsWith('@relay-harness/'))];
  for (const directory of packages) {
    for (const relative of fs.globSync('lib/**/*.{js,mjs,cjs}', { cwd: directory })) {
      const file = path.join(directory, relative);
      const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      for (const node of source.statements) {
        if ((!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) || !node.moduleSpecifier
          || !ts.isStringLiteral(node.moduleSpecifier) || !node.moduleSpecifier.text.startsWith('.')) continue;
        const target = fileURLToPath(new URL(node.moduleSpecifier.text, pathToFileURL(file)));
        if (!within(root, target) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
          throw new Error(`Published import is absent: ${path.relative(root, file)} -> ${node.moduleSpecifier.text}`);
        }
      }
    }
  }
}

module.exports = { prepareRuntimeDeploy, validateRuntimeDeploy, assembleRuntimeDeploy };
