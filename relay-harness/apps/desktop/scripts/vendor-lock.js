'use strict';
const fs = require('node:fs');
const path = require('node:path');

const LOCKED_INSTALL_ARGS = ['ci', '--omit=dev', '--ignore-scripts', '--legacy-peer-deps', '--workspaces=false', '--no-fund', '--no-audit'];

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
}

/** Validate the source lock before any installed directory is removed or accepted. */
function readPluginLock(packageDir) {
  const lockPath = path.join(packageDir, 'package-lock.json');
  const stat = fs.lstatSync(lockPath, { throwIfNoEntry: false });
  if (!stat || !stat.isFile() || stat.isSymbolicLink()) throw new Error(`vendor package requires a regular package-lock.json: ${packageDir}`);
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) throw new Error(`invalid vendor lockfile: ${packageDir}`);
  const root = lock.packages[''];
  if (!root || root.name !== pkg.name || root.version !== pkg.version) throw new Error(`vendor manifest/lock identity mismatch: ${packageDir}`);
  for (const field of ['dependencies', 'optionalDependencies', 'devDependencies', 'peerDependencies', 'peerDependenciesMeta']) {
    if (JSON.stringify(canonical(root[field] ?? {})) !== JSON.stringify(canonical(pkg[field] ?? {}))) throw new Error(`vendor manifest/lock ${field} mismatch: ${packageDir}`);
  }
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    const entry = lock.packages[`node_modules/${name}`];
    if (!entry || entry.dev || entry.devOptional) throw new Error(`vendor lock omits production dependency: ${name}`);
  }
  for (const [key, entry] of productionEntries(lock)) {
    if (typeof entry.version !== 'string' || typeof entry.resolved !== 'string' || !entry.resolved.startsWith('https://')
      || typeof entry.integrity !== 'string' || !/^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/.test(entry.integrity)) {
      throw new Error(`vendor production dependency lacks locked HTTPS resolution and integrity: ${key}`);
    }
  }
  return lock;
}

function productionEntries(lock) {
  return Object.entries(lock.packages).filter(([key, entry]) => key.startsWith('node_modules/') && !entry.dev && !entry.devOptional);
}

function lockedPackages(packageDir) {
  return productionEntries(readPluginLock(packageDir)).map(([key, entry]) => `${key.slice('node_modules/'.length)}@${entry.version}`).sort();
}

/** Capture installed package identities at the same nested paths the npm lock describes. */
function installedPackagesAt(packageDir) {
  const result = [];
  function scan(directory, prefix) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (entry.name.startsWith('@')) {
        for (const scoped of fs.readdirSync(path.join(directory, entry.name))) visit(`${entry.name}/${scoped}`);
      } else visit(entry.name);
    }
    function visit(name) {
      const root = path.join(directory, name);
      const file = path.join(root, 'package.json');
      if (!fs.existsSync(file)) return;
      const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
      result.push(`${prefix}${name}@${pkg.version}`);
      scan(path.join(root, 'node_modules'), `${prefix}${name}/node_modules/`);
    }
  }
  scan(path.join(packageDir, 'node_modules'), '');
  return result.sort();
}

function matchesLockedInstall(packageDir) {
  return installedPackagesAt(packageDir).join('\n') === lockedPackages(packageDir).join('\n');
}

module.exports = { LOCKED_INSTALL_ARGS, readPluginLock, lockedPackages, installedPackagesAt, matchesLockedInstall };
