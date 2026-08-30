// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { missingRuntimeFiles } = require('./plugin-runtime-files');
const { webProfileDir, upsertManagedBlock, stripBlockFromFile } = require('./plugins');

const RLHMARKET_PACKAGE = 'rlhmarket';
const RLHMARKET_BEGIN = '# --- rlhd-gui-rlhmarket ---';
const RLHMARKET_END = '# --- end rlhd-gui-rlhmarket ---';

function defaultSourceDir() {
  try {
    const { projectRoot } = require('./paths');
    return path.join(projectRoot(), 'vendor', 'rlhmarket');
  } catch {
    return path.join(__dirname, '..', '..', 'vendor', 'rlhmarket');
  }
}

function profileListsBundle(profileDir) {
  const file = path.join(profileDir, 'package.json');
  if (!fs.existsSync(file)) {
    return false;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bundles = manifest.rlh?.profile?.bundles;
    return Array.isArray(bundles) && bundles.includes(RLHMARKET_PACKAGE);
  } catch {
    return false;
  }
}

function missingRuntimeDependencies(sourceDir) {
  return missingRuntimeFiles(sourceDir);
}

function linkIntoProfileModules(destDir, profileDir) {
  const linked = path.join(profileDir, 'node_modules', RLHMARKET_PACKAGE);
  if (fs.existsSync(linked) && !fs.lstatSync(linked).isSymbolicLink()) {
    return;
  }
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  if (fs.existsSync(linked)) {
    fs.unlinkSync(linked);
  }
  fs.symlinkSync(destDir, linked, process.platform === 'win32' ? 'junction' : 'dir');
}

/**
 * Copy the bundled rlhmarket package into the web profile and register it
 * through a managed cordis.patch.yml insert. Does not call `rlh plugin add`.
 * Missing `package.json`, a declared dependency, or a dependency export file
 * returns `{ ok: false }` and strips the managed insert so Loader does not
 * mount a broken copy. The caller logs that and continues Harness start.
 * @param {{ sourceDir?: string, profileDir?: string }} [options]
 */
function ensureRlhMarketPlugin(options = {}) {
  const sourceDir = options.sourceDir || defaultSourceDir();
  if (!fs.existsSync(path.join(sourceDir, 'package.json'))) {
    return { ok: false, added: false, error: 'missing-source:package.json' };
  }
  const profileDir = options.profileDir || webProfileDir();
  const destDir = path.join(profileDir, 'desktop-plugins', RLHMARKET_PACKAGE);
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const missing = missingRuntimeDependencies(sourceDir);
  if (missing.length) {
    stripBlockFromFile(patchFile, RLHMARKET_BEGIN, RLHMARKET_END);
    return {
      ok: false,
      added: false,
      error: `missing-source:node_modules:${missing.join(',')}`,
    };
  }
  const existed = fs.existsSync(path.join(destDir, 'package.json'));
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(sourceDir, destDir, { recursive: true, force: true });
  linkIntoProfileModules(destDir, profileDir);
  if (profileListsBundle(profileDir)) {
    stripBlockFromFile(patchFile, RLHMARKET_BEGIN, RLHMARKET_END);
    return { ok: true, added: false, destDir };
  }
  const body = [
    '- insert:',
    '    - id: rlh-market',
    `      name: ${JSON.stringify(RLHMARKET_PACKAGE)}`,
  ].join('\n');
  upsertManagedBlock(patchFile, RLHMARKET_BEGIN, RLHMARKET_END, body);
  return {
    ok: true,
    added: !existed,
    destDir,
    patchFile,
  };
}

module.exports = {
  RLHMARKET_BEGIN,
  RLHMARKET_END,
  ensureRlhMarketPlugin,
};
