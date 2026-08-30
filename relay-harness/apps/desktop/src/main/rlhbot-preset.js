// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { webProfileDir, upsertManagedBlock, stripBlockFromFile } = require('./plugins');

const RLHBOT_PACKAGE = 'rlhbot';
const RLHBOT_BEGIN = '# --- rlhd-gui-rlhbot ---';
const RLHBOT_END = '# --- end rlhd-gui-rlhbot ---';
const ROOM_PRESET_ID = 'rlhbot-room';

function defaultSourceDir() {
  try {
    const { projectRoot } = require('./paths');
    return path.join(projectRoot(), 'vendor', 'rlhbot');
  } catch {
    return path.join(__dirname, '..', '..', 'vendor', 'rlhbot');
  }
}

function defaultPresetDir(profileDir) {
  return path.join(profileDir, '..', '..', '.agent-presets', ROOM_PRESET_ID);
}

/** Collect every local file a package export declaration names. */
function collectLocalEntries(value, entries) {
  if (typeof value === 'string') {
    if (value.startsWith('./')) entries.add(value.slice(2));
    return;
  }
  if (value && typeof value === 'object') {
    for (const nested of Object.values(value)) collectLocalEntries(nested, entries);
  }
}

/** Read the source manifest and reject every incomplete declared entry before profile mutation. */
function validateSourcePackage(sourceDir) {
  const manifestFile = path.join(sourceDir, 'package.json');
  if (!fs.existsSync(manifestFile)) return { ok: false, error: 'missing-source:package.json' };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch {
    return { ok: false, error: 'invalid-source:package.json' };
  }
  if (!manifest || typeof manifest !== 'object' || manifest.name !== RLHBOT_PACKAGE) {
    return { ok: false, error: 'invalid-source:package-name' };
  }
  if (typeof manifest.main !== 'string' || manifest.main.length === 0) {
    return { ok: false, error: 'missing-source:main' };
  }
  const entries = new Set([manifest.main.startsWith('./') ? manifest.main.slice(2) : manifest.main]);
  collectLocalEntries(manifest.exports, entries);
  const root = path.resolve(sourceDir);
  for (const entry of entries) {
    const absolute = path.resolve(root, entry);
    if (!entry || absolute === root || !absolute.startsWith(`${root}${path.sep}`)) {
      return { ok: false, error: `invalid-source:entry:${entry || '<empty>'}` };
    }
    try {
      if (!fs.statSync(absolute).isFile()) return { ok: false, error: `missing-source:entry:${entry}` };
    } catch {
      return { ok: false, error: `missing-source:entry:${entry}` };
    }
  }
  return { ok: true };
}

function profileListsBundle(profileDir) {
  const file = path.join(profileDir, 'package.json');
  if (!fs.existsSync(file)) {
    return false;
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const bundles = manifest.rlh?.profile?.bundles;
    return Array.isArray(bundles) && bundles.includes(RLHBOT_PACKAGE);
  } catch {
    return false;
  }
}

function linkIntoProfileModules(destDir, profileDir) {
  const linked = path.join(profileDir, 'node_modules', RLHBOT_PACKAGE);
  if (fs.existsSync(linked) && !fs.lstatSync(linked).isSymbolicLink()) {
    return;
  }
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  if (fs.existsSync(linked)) {
    fs.unlinkSync(linked);
  }
  fs.symlinkSync(destDir, linked, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Remove only state this installer owns; a pnpm-installed directory is never touched. */
function removeManagedInstall(profileDir, presetDir, removePreset = true) {
  const destDir = path.join(profileDir, 'desktop-plugins', RLHBOT_PACKAGE);
  const linked = path.join(profileDir, 'node_modules', RLHBOT_PACKAGE);
  let linkedStat;
  try {
    linkedStat = fs.lstatSync(linked);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    // An absent link is already clean.
  }
  if (linkedStat?.isSymbolicLink()) {
    const target = path.resolve(path.dirname(linked), fs.readlinkSync(linked));
    if (target === path.resolve(destDir)) fs.unlinkSync(linked);
  }
  fs.rmSync(destDir, { recursive: true, force: true });
  stripBlockFromFile(path.join(profileDir, 'cordis.patch.yml'), RLHBOT_BEGIN, RLHBOT_END);
  if (removePreset) fs.rmSync(presetDir, { recursive: true, force: true });
}

/** Return the fail-closed product state after removing an older managed copy. */
function unavailable(profileDir, presetDir, error) {
  removeManagedInstall(profileDir, presetDir);
  return { ok: false, added: false, disabled: true, error };
}

function copyRoomPreset(sourceDir, presetDir) {
  const from = path.join(sourceDir, 'presets', ROOM_PRESET_ID);
  if (!fs.existsSync(path.join(from, 'agent.cordis.yml'))) {
    return { ok: false, error: 'missing-source:preset' };
  }
  fs.mkdirSync(presetDir, { recursive: true });
  fs.cpSync(from, presetDir, { recursive: true, force: true });
  return { ok: true, presetDir };
}

/**
 * Admit a complete bundled rlhbot package, copy it into the web profile,
 * register it through a managed cordis.patch.yml insert, and install the room
 * agent preset. Incomplete sources remove older installer-owned state.
 * @param {{ sourceDir?: string, profileDir?: string, presetDir?: string }} [options]
 */
function ensureRlhbotPlugin(options = {}) {
  const sourceDir = options.sourceDir || defaultSourceDir();
  const profileDir = options.profileDir || webProfileDir();
  const presetDir = options.presetDir || defaultPresetDir(profileDir);
  if (profileListsBundle(profileDir)) {
    removeManagedInstall(profileDir, presetDir, false);
    return { ok: true, added: false, managed: false };
  }
  const source = validateSourcePackage(sourceDir);
  if (!source.ok) return unavailable(profileDir, presetDir, source.error);
  const presetSource = path.join(sourceDir, 'presets', ROOM_PRESET_ID, 'agent.cordis.yml');
  if (!fs.existsSync(presetSource)) return unavailable(profileDir, presetDir, 'missing-source:preset');
  const destDir = path.join(profileDir, 'desktop-plugins', RLHBOT_PACKAGE);
  const existed = fs.existsSync(path.join(destDir, 'package.json'));
  try {
    // Replacement, not merge: a removed source entry must not survive from an
    // older managed copy and make the destination look complete.
    fs.rmSync(destDir, { recursive: true, force: true });
    fs.cpSync(sourceDir, destDir, { recursive: true, force: true });
    linkIntoProfileModules(destDir, profileDir);
    const preset = copyRoomPreset(sourceDir, presetDir);
    if (!preset.ok) return unavailable(profileDir, presetDir, preset.error);
    const patchFile = path.join(profileDir, 'cordis.patch.yml');
    const body = [
      '- insert:',
      '    - id: rlh-bot',
      `      name: ${JSON.stringify(RLHBOT_PACKAGE)}`,
    ].join('\n');
    upsertManagedBlock(patchFile, RLHBOT_BEGIN, RLHBOT_END, body);
    return {
      ok: true,
      added: !existed,
      destDir,
      patchFile,
      presetDir: preset.presetDir,
    };
  } catch {
    return unavailable(profileDir, presetDir, 'managed-install-failed');
  }
}

module.exports = {
  RLHBOT_BEGIN,
  RLHBOT_END,
  ensureRlhbotPlugin,
};
