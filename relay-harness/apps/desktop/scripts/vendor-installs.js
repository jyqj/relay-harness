'use strict';

/**
 * Installs the production dependencies of the vendored desktop plugins from
 * their lockfiles. The installs are build output rather than source, so the
 * repository does not carry them; packaging and `pnpm start` call this so a
 * working copy still bundles a complete plugin.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { LOCKED_INSTALL_ARGS, readPluginLock } = require('./vendor-lock');

const {
  installablePlugins,
  installedPackages,
  lockedProductionInstall,
  vendorDir,
} = require('../vendor/vendor-manifest.js');

function install(name) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  readPluginLock(path.join(vendorDir, name));
  const args = [...LOCKED_INSTALL_ARGS];
  const result = spawnSync(npm, args, {
    cwd: path.join(vendorDir, name),
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`\`${npm} ${args.join(' ')}\` failed in vendor/${name} (status ${result.status})`);
  }
}

/**
 * Bring every vendored plugin's install up to its lockfile. Plugins already
 * matching their lockfile are left alone, so this is cheap to call on a path
 * that runs often.
 *
 * @param {{ log?: (message: string) => void }} [options]
 * @returns {string[]} The plugins this call installed.
 */
function syncVendorInstalls(options = {}) {
  const log = options.log ?? (() => {});
  const installed = [];
  for (const name of installablePlugins()) {
    const locked = lockedProductionInstall(name);
    if (installedPackages(name).join() === locked.join()) continue;
    log(`installing vendor/${name}: ${locked.join(', ')}`);
    install(name);
    installed.push(name);
  }
  return installed;
}

module.exports = { syncVendorInstalls };
