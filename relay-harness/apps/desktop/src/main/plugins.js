const fs = require('fs');
const { createRequire } = require('module');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const PROFILE = 'web';
const DROPPED = [
  '@dsh-external/dsh-genui',
  '@huanlin/rlh-plugin-yet-another-subagent',
];
const PATCH_BEGIN = '# --- rlhd-gui-plugin-toggles ---';
const PATCH_END = '# --- end rlhd-gui-plugin-toggles ---';
const DESKTOP_INSTALL_BEGIN = '# --- rlhd-gui-desktop-install ---';
const DESKTOP_INSTALL_END = '# --- end rlhd-gui-desktop-install ---';
const LEGACY_DESKTOP_INSTALL_BEGIN = '# --- rlh-gui-desktop-install ---';
const LEGACY_DESKTOP_INSTALL_END = '# --- end rlh-gui-desktop-install ---';
const DESKTOP_INSTALL_FILES = [
  'install-rlh-plugin.mjs',
  'install-rlh-plugin-client.js',
];
const OFFICIAL_TEMPLATE_BUNDLES = new Set([
  '@relay-harness/rlh-base',
  '@relay-harness/rlh-web-app',
]);

function rlhHome() {
  const fromEnv = process.env.RLH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim()) {
    return path.resolve(fromEnv.trim());
  }
  return path.join(os.homedir(), '.rlh');
}

function webProfileDir() {
  return path.join(rlhHome(), 'profiles', PROFILE);
}

function defaultInstallAnchor() {
  try {
    const { harnessRoot } = require('./paths');
    return path.join(harnessRoot(), 'apps', 'cli', 'package.json');
  } catch {
    return '';
  }
}

function packageDirFromAnchor(anchor, packageName) {
  if (!anchor || !fs.existsSync(anchor)) return '';
  try {
    const searchPaths = createRequire(anchor).resolve.paths(packageName) || [];
    for (const searchPath of searchPaths) {
      const candidate = path.join(searchPath, packageName);
      if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    }
  } catch {
    // Invalid anchors are treated as unresolved bundle names.
  }
  return '';
}

function bundleResolves(packageName, profileDir, installAnchor) {
  return [installAnchor, path.join(profileDir, 'package.json')]
    .filter(Boolean)
    .some((anchor) => Boolean(packageDirFromAnchor(anchor, packageName)));
}

/** Remove only user bundle names that the Loader cannot resolve. */
function healDanglingBundles(options = {}) {
  const profileDir = options.profileDir || webProfileDir();
  const file = path.join(profileDir, 'package.json');
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing-profile', changed: false };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { ok: false, reason: 'invalid-profile', changed: false };
  }
  const current = manifest.rlh?.profile?.bundles;
  if (!Array.isArray(current)) return { ok: true, changed: false, removed: [] };
  const installAnchor = options.installAnchor || defaultInstallAnchor();
  const removed = current.filter((name) => (
    typeof name === 'string'
    && !OFFICIAL_TEMPLATE_BUNDLES.has(name)
    && !bundleResolves(name, profileDir, installAnchor)
  ));
  if (removed.length === 0) return { ok: true, changed: false, removed: [] };
  const bundles = current.filter((name) => !removed.includes(name));
  manifest.rlh = {
    ...manifest.rlh,
    profile: { ...manifest.rlh.profile, bundles },
  };
  writeAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ok: true, changed: true, removed };
}

function manifestPath() {
  return path.join(webProfileDir(), 'package.json');
}

function patchPath() {
  return path.join(webProfileDir(), 'cordis.patch.yml');
}

function writeAtomic(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, file);
}

function replaceManagedBlock(text, begin, end, block) {
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start !== -1 && stop !== -1 && stop > start) {
    return `${text.slice(0, start)}${block}${text.slice(stop + end.length).replace(/^\r?\n/, '')}`;
  }
  // The shipped profile template is comments plus a lone `[]`. Appending a
  // second document after that array is invalid YAML and loadProfile fails.
  const withoutEmpty = text.replace(/(^|\r?\n)\[\s*\][ \t]*(\r?\n)*$/, '$1');
  const prefix = withoutEmpty.trimEnd();
  return prefix ? `${prefix}\n\n${block}` : block;
}

function upsertManagedBlock(file, begin, end, body) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const block = `${begin}\n${body.trimEnd()}\n${end}\n`;
  const next = replaceManagedBlock(existing, begin, end, block);
  if (next === existing) {
    return false;
  }
  writeAtomic(file, next);
  return true;
}

function stripNamedBlock(text, begin, end) {
  const start = text.indexOf(begin);
  const stop = text.indexOf(end);
  if (start === -1 || stop === -1 || stop < start) {
    return text;
  }
  return `${text.slice(0, start)}${text.slice(stop + end.length)}`.replace(/\n{3,}/g, '\n\n');
}

function stripBlockFromFile(file, begin, end) {
  if (!fs.existsSync(file)) {
    return false;
  }
  const text = fs.readFileSync(file, 'utf8');
  const next = stripNamedBlock(text, begin, end);
  if (next === text) {
    return false;
  }
  writeAtomic(file, next);
  return true;
}

function stripManagedPatch() {
  return stripBlockFromFile(patchPath(), PATCH_BEGIN, PATCH_END);
}

function hostPluginDir() {
  return path.join(__dirname, '..', 'host');
}

/**
 * Copy the desktop-only install_rlh_plugin Host plugin into the web profile
 * and keep a managed cordis.patch.yml insert pointing at the copy.
 * @param options - optional sourceDir / profileDir overrides for tests.
 */
function ensureDesktopInstallPlugin(options = {}) {
  const sourceDir = options.sourceDir || hostPluginDir();
  const profileDir = options.profileDir || webProfileDir();
  const destDir = path.join(profileDir, 'desktop-plugins', 'install-rlh-plugin');
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of DESKTOP_INSTALL_FILES) {
    const src = path.join(sourceDir, name);
    if (!fs.existsSync(src)) {
      return { ok: false, reason: `missing-source:${name}` };
    }
    fs.copyFileSync(src, path.join(destDir, name));
  }
  const entry = path.join(destDir, 'install-rlh-plugin.mjs');
  const href = pathToFileURL(entry).href;
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  const strippedLegacy = stripBlockFromFile(
    patchFile,
    LEGACY_DESKTOP_INSTALL_BEGIN,
    LEGACY_DESKTOP_INSTALL_END,
  );
  const body = [
    '- insert:',
    '    - id: rlhd-desktop-plugin-install',
    `      name: ${JSON.stringify(href)}`,
  ].join('\n');
  const patchChanged = upsertManagedBlock(
    patchFile,
    DESKTOP_INSTALL_BEGIN,
    DESKTOP_INSTALL_END,
    body,
  );
  return {
    ok: true,
    destDir,
    href,
    patchFile,
    patchChanged: patchChanged || strippedLegacy,
  };
}

/** Drop retired community plugins from the live web profile so they cannot boot. */
function stripDroppedPlugins() {
  const file = manifestPath();
  if (!fs.existsSync(file)) {
    return { ok: false, reason: 'missing-profile' };
  }
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  let changed = false;
  if (manifest.dependencies) {
    for (const name of DROPPED) {
      if (Object.prototype.hasOwnProperty.call(manifest.dependencies, name)) {
        delete manifest.dependencies[name];
        changed = true;
      }
    }
  }
  const current = manifest.rlh?.profile?.bundles;
  if (Array.isArray(current)) {
    const bundles = current.filter((name) => !DROPPED.includes(name));
    if (bundles.length !== current.length) {
      manifest.rlh = {
        ...manifest.rlh,
        profile: {
          ...manifest.rlh.profile,
          bundles,
        },
      };
      changed = true;
    }
  }
  if (changed) {
    writeAtomic(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const patchChanged = stripManagedPatch();
  return { ok: true, changed, patchChanged };
}

function listInstalledPlugins() {
  const file = manifestPath();
  if (!fs.existsSync(file)) {
    return { ok: true, profile: PROFILE, profileDir: webProfileDir(), plugins: [], bundles: [] };
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const dependencies = manifest.dependencies && typeof manifest.dependencies === 'object'
      ? manifest.dependencies
      : {};
    const bundles = Array.isArray(manifest.rlh?.profile?.bundles) ? manifest.rlh.profile.bundles : [];
    return {
      ok: true,
      profile: PROFILE,
      profileDir: webProfileDir(),
      plugins: Object.entries(dependencies).map(([name, spec]) => ({
        name,
        spec: String(spec || ''),
        bundle: bundles.includes(name),
        dropped: DROPPED.includes(name),
      })),
      bundles,
    };
  } catch {
    return { ok: false, profile: PROFILE, profileDir: webProfileDir(), plugins: [], bundles: [] };
  }
}

module.exports = {
  PROFILE,
  DROPPED,
  webProfileDir,
  stripDroppedPlugins,
  healDanglingBundles,
  listInstalledPlugins,
  ensureDesktopInstallPlugin,
  upsertManagedBlock,
  stripBlockFromFile,
  DESKTOP_INSTALL_BEGIN,
  DESKTOP_INSTALL_END,
  LEGACY_DESKTOP_INSTALL_BEGIN,
  LEGACY_DESKTOP_INSTALL_END,
};
