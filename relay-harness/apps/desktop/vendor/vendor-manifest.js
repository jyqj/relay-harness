'use strict';

/**
 * Reader for `vendor/plugins.json`, the record of which vendored desktop
 * plugin subtrees this repository actually carries. A suite that imports a
 * vendored build artifact asks `missingSubtrees` whether that artifact is
 * present before it runs; `vendor-plugins.test.js` keeps the record honest by
 * failing when a subtree it lists as absent turns up.
 */

const fs = require('node:fs');
const path = require('node:path');

const vendorDir = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(vendorDir, 'plugins.json'), 'utf8'));

/**
 * The subtrees of one vendored plugin that the manifest records as absent.
 *
 * @param {string} name Vendored plugin directory name.
 * @returns {string[]} Subtree names, empty when the drop is complete.
 */
function missingSubtrees(name) {
  return Object.keys(manifest[name]?.missing ?? {});
}

/**
 * Why a vendored subtree is absent, for a skip message that tells the reader
 * what to restore rather than that a test did not run.
 *
 * @param {string} name Vendored plugin directory name.
 * @param {string} subtree Subtree name, such as `lib`.
 * @returns {string | undefined} The recorded reason, or undefined when present.
 */
function absenceReason(name, subtree) {
  return manifest[name]?.missing?.[subtree];
}

/**
 * The production install a vendored plugin's `package-lock.json` resolves to,
 * as `name@version`. npm marks development-only entries, so what remains is
 * what `npm ci --omit=dev` writes and what the installer must therefore carry.
 *
 * @param {string} name Vendored plugin directory name.
 * @returns {string[]} Sorted `name@version` pairs, empty without a lockfile.
 */
function lockedProductionInstall(name) {
  const lockPath = path.join(vendorDir, name, 'package-lock.json');
  if (!fs.existsSync(lockPath)) return [];
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  return Object.entries(lock.packages)
    .filter(([key, entry]) => key.startsWith('node_modules/') && !entry.dev && !entry.devOptional)
    .map(([key, entry]) => `${key.slice('node_modules/'.length)}@${entry.version}`)
    .sort();
}

/**
 * The packages a vendored plugin's working-copy `node_modules` contains, as
 * `name@version`. The directory is build output rather than source, so it is
 * absent until `pnpm run vendor:sync` writes it.
 *
 * @param {string} name Vendored plugin directory name.
 * @returns {string[]} Sorted `name@version` pairs, empty without the directory.
 */
function installedPackages(name) {
  const root = path.join(vendorDir, name, 'node_modules');
  if (!fs.existsSync(root)) return [];
  const directories = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .flatMap(entry => entry.name.startsWith('@')
      ? fs.readdirSync(path.join(root, entry.name)).map(scoped => `${entry.name}/${scoped}`)
      : [entry.name]);
  return directories
    .map(directory => `${directory}@${JSON.parse(fs.readFileSync(path.join(root, directory, 'package.json'), 'utf8')).version}`)
    .sort();
}

/** Vendored plugins whose production dependencies come from a lockfile. */
function installablePlugins() {
  return Object.keys(manifest).filter(name => fs.existsSync(path.join(vendorDir, name, 'package-lock.json')));
}

module.exports = {
  absenceReason,
  installablePlugins,
  installedPackages,
  lockedProductionInstall,
  manifest,
  missingSubtrees,
  vendorDir,
};
