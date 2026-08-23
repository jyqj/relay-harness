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

module.exports = { absenceReason, manifest, missingSubtrees, vendorDir };
