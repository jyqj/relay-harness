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
const { readPluginLock, lockedPackages, installedPackagesAt } = require('../scripts/vendor-lock');

const vendorDir = __dirname;
const manifest = JSON.parse(fs.readFileSync(path.join(vendorDir, 'plugins.json'), 'utf8'));

/**
 * Package roots currently present below a vendor directory. A directory that
 * contains only ignored build residue (for example, a pre-rebrand `lib/`)
 * is not an installable or packageable plugin and must not widen the manifest.
 *
 * @param {string} [root=vendorDir] Vendor directory to inspect.
 * @returns {string[]} Sorted plugin package directory names.
 */
function vendoredPluginDirectories(root = vendorDir) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, 'package.json')))
    .map(entry => entry.name)
    .sort();
}

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
 * @returns {string[]} Sorted `name@version` pairs; missing or incomplete locks fail.
 */
function lockedProductionInstall(name) {
  return lockedPackages(path.join(vendorDir, name));
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
  return installedPackagesAt(path.join(vendorDir, name));
}

/** Complete vendored plugins; all manifests require locks, but an explicitly absent Host tree stays unmountable. */
function installablePlugins() {
  return Object.keys(manifest).filter((name) => {
    readPluginLock(path.join(vendorDir, name));
    return missingSubtrees(name).length === 0;
  });
}

module.exports = {
  absenceReason,
  installablePlugins,
  installedPackages,
  lockedProductionInstall,
  manifest,
  missingSubtrees,
  vendoredPluginDirectories,
  vendorDir,
};
