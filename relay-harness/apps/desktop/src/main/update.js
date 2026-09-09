// @ts-check
'use strict';
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const {
  MANIFEST_NAME, SIGNATURE_NAME, MAX_MANIFEST_BYTES,
  UpdateUnavailable, record, compareVersions, resolveTrust, assetUrl, verifyManifest,
} = require('./update-protocol');

const DOWNLOAD_HOSTS = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const REQUEST_TIMEOUT_MS = 30_000;
const INSTALLER_TIMEOUT_MS = 10 * 60_000;

/** @param {string} input */
function trustedUrl(input) {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
    || !DOWNLOAD_HOSTS.has(url.hostname)) throw new Error('Untrusted update download URL');
  return url;
}

/** Bounded HTTPS transfer; one timeout covers all redirects and the response body. @param {string} url @param {number} maxBytes @param {(chunk: Buffer) => void} onChunk @param {number} [timeoutMs] @returns {Promise<number>} */
function receive(url, maxBytes, onChunk, timeoutMs = REQUEST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    /** @type {import('node:http').ClientRequest | undefined} */
    let request;
    /** @type {import('node:http').IncomingMessage | undefined} */
    let activeResponse;
    let generation = 0;
    let settled = false;
    let received = 0;
    const timer = setTimeout(() => fail(new Error('Update download timed out')), timeoutMs);
    /** @param {Error} error */
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      activeResponse?.destroy();
      request?.destroy();
      reject(error);
    }
    /** @param {string} target @param {number} hops */
    function visit(target, hops) {
      if (settled) return;
      if (hops > 5) { fail(new Error('Too many update redirects')); return; }
      const current = ++generation;
      /** @param {Error} error */
      const failCurrent = (error) => { if (current === generation) fail(error); };
      try {
        request = https.get(trustedUrl(target), { headers: { 'User-Agent': 'Relay-Harness-Desktop-Updater', Accept: 'application/octet-stream' } }, (response) => {
          response.on('error', failCurrent);
          if (settled || current !== generation) { response.destroy(); return; }
          activeResponse = response;
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            try {
              const next = new URL(response.headers.location, target).href;
              generation += 1;
              response.destroy();
              request?.destroy();
              activeResponse = undefined;
              visit(next, hops + 1);
            }
            catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
            return;
          }
          if (response.statusCode !== 200) { response.resume(); fail(new Error(`Update download HTTP ${response.statusCode}`)); return; }
          const declared = Number(response.headers['content-length']);
          if (Number.isFinite(declared) && declared > maxBytes) { response.destroy(); fail(new Error('Update download exceeds size bound')); return; }
          response.on('aborted', () => failCurrent(new Error('Update download was interrupted')));
          response.on('data', (chunk) => {
            if (settled || current !== generation) return;
            const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            received += bytes.length;
            if (received > maxBytes) { response.destroy(); fail(new Error('Update download exceeds size bound')); return; }
            try { onChunk(bytes); } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
          });
          response.on('end', () => {
            if (settled || current !== generation) return;
            settled = true;
            clearTimeout(timer);
            resolve(received);
          });
        });
        request.on('error', failCurrent);
      } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
    }
    visit(url, 0);
  });
}

/** @param {string} file @returns {Promise<void>} */
function launchInstaller(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: false });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

/** @typedef {{getVersion(): string, getPath(name: 'userData'): string, isPackaged: boolean, quit(): void}} UpdateApp */
/** @typedef {{status: 'available'|'current'|'unavailable'|'error', current: string, latest: string, repo: string, repoUrl: string, releasesUrl: string, htmlUrl: string, assetName: string, assetUrl: string, message?: string, notes?: string}} UpdateInfo */

/** Testable process-owned updater; no dependency or trust settings cross the renderer IPC. @param {{metadata: unknown, app: UpdateApp, platform?: string, arch?: string, now?: () => number, receive?: typeof receive, launch?: typeof launchInstaller}} options */
function createUpdater(options) {
  const app = options.app;
  const transfer = options.receive ?? receive;
  const launch = options.launch ?? launchInstaller;
  const now = options.now ?? Date.now;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  let launched = false;
  /** @type {Promise<UpdateInfo & {launched: boolean, openedPage: boolean, installer?: string}> | undefined} */
  let installing;
  /** @param {UpdateInfo['status']} status @param {Partial<UpdateInfo>} [extra] @returns {UpdateInfo} */
  function snapshot(status, extra = {}) {
    return { status, current: app.getVersion(), latest: '', repo: '', repoUrl: '', releasesUrl: '', htmlUrl: '', assetName: '', assetUrl: '', ...extra };
  }
  /** @param {string} url @param {number} limit */
  async function bytes(url, limit) {
    /** @type {Buffer[]} */
    const chunks = [];
    await transfer(url, limit, chunk => { chunks.push(chunk); });
    return Buffer.concat(chunks);
  }
  async function inspect() {
    if (!app.isPackaged) throw new UpdateUnavailable('Automatic updates require an installed packaged build');
    if (platform !== 'win32' || arch !== 'x64') throw new UpdateUnavailable('No verified installer protocol for this platform');
    const trust = resolveTrust(options.metadata);
    compareVersions(app.getVersion(), app.getVersion());
    const release = record(JSON.parse((await bytes(trust.apiUrl, 1024 * 1024)).toString('utf8')));
    if (typeof release.tag_name !== 'string' || release.draft === true || release.prerelease === true || !Array.isArray(release.assets)) throw new Error('Invalid stable update release');
    const tag = release.tag_name;
    /** @param {string} name */
    const locate = (name) => {
      const found = /** @type {unknown[]} */ (release.assets).map(record).filter(asset => asset.name === name);
      const expected = assetUrl(trust, tag, name);
      if (found.length !== 1 || found[0].browser_download_url !== expected) throw new Error('Missing or untrusted update release asset');
      return expected;
    };
    const [manifest, signature] = await Promise.all([bytes(locate(MANIFEST_NAME), MAX_MANIFEST_BYTES), bytes(locate(SIGNATURE_NAME), 1024)]);
    const artifact = verifyManifest(manifest, signature, trust, { current: app.getVersion(), platform, arch, now: now(), tag });
    locate(artifact.name);
    const info = snapshot(artifact.newer ? 'available' : 'current', {
      latest: artifact.version, repo: trust.repository, repoUrl: trust.repoUrl, releasesUrl: trust.releasesUrl,
      htmlUrl: `${trust.releasesUrl}/tag/${encodeURIComponent(tag)}`, assetName: artifact.name, assetUrl: artifact.url, notes: artifact.notes,
    });
    return { info, artifact, manifest, signature, trust, tag };
  }
  /** @param {unknown} error */
  function failure(error) {
    return snapshot(error instanceof UpdateUnavailable ? 'unavailable' : 'error', { message: error instanceof Error ? error.message : 'Update verification failed' });
  }
  async function checkUpdate() {
    try { return (await inspect()).info; } catch (error) { return failure(error); }
  }
  /** @param {(progress: {phase: string, percent: number}) => void} [onProgress] */
  async function install(onProgress) {
    let directory;
    let fd;
    try {
      if (launched) throw new UpdateUnavailable('An installer has already been launched by this process');
      const checked = await inspect();
      if (checked.info.status !== 'available') return { ...checked.info, launched: false, openedPage: false };
      const root = path.join(app.getPath('userData'), 'updates');
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      directory = fs.mkdtempSync(path.join(root, 'verified-'));
      const partial = path.join(directory, 'payload.part');
      fd = fs.openSync(partial, 'wx', 0o600);
      const output = fd;
      const hash = createHash('sha256');
      let count = 0;
      onProgress?.({ phase: 'download', percent: 0 });
      await transfer(checked.artifact.url, checked.artifact.size, (chunk) => {
        count += chunk.length;
        if (count > checked.artifact.size) throw new Error('Update installer exceeds signed size');
        let offset = 0;
        while (offset < chunk.length) {
          const written = fs.writeSync(output, chunk, offset, chunk.length - offset);
          if (written === 0) throw new Error('Update installer write made no progress');
          offset += written;
        }
        hash.update(chunk);
        onProgress?.({ phase: 'download', percent: Math.min(99, Math.floor(count * 100 / checked.artifact.size)) });
      }, INSTALLER_TIMEOUT_MS);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      if (count !== checked.artifact.size || hash.digest('hex') !== checked.artifact.sha256) throw new Error('Update installer digest or size verification failed');
      const final = verifyManifest(checked.manifest, checked.signature, checked.trust, { current: app.getVersion(), platform, arch, now: now(), tag: checked.tag });
      if (!final.newer || !app.isPackaged) throw new UpdateUnavailable('Update is no longer installable');
      const installer = path.join(directory, checked.artifact.name);
      fs.renameSync(partial, installer);
      onProgress?.({ phase: 'install', percent: 100 });
      await launch(installer);
      launched = true;
      setTimeout(() => app.quit(), 800).unref();
      return { ...checked.info, launched: true, openedPage: false, installer };
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if (directory !== undefined) fs.rmSync(directory, { recursive: true, force: true });
      return { ...failure(error), launched: false, openedPage: false };
    }
  }
  /** @param {(progress: {phase: string, percent: number}) => void} [onProgress] */
  function installUpdate(onProgress) {
    installing ??= install(onProgress).finally(() => { installing = undefined; });
    return installing;
  }
  return { checkUpdate, installUpdate };
}

const metadata = require('../../package.json');
function currentVersion() { return require('electron').app.getVersion(); }
let singleton;
function updater() {
  singleton ??= createUpdater({ metadata, app: require('electron').app });
  return singleton;
}
function configuredLinks() {
  try { const trust = resolveTrust(metadata); return { repo: trust.repoUrl, releases: trust.releasesUrl }; }
  catch { return { repo: '', releases: '' }; }
}
const links = configuredLinks();
module.exports = {
  REPO_URL: links.repo, RELEASES_PAGE: links.releases, currentVersion,
  checkUpdate: () => updater().checkUpdate(),
  installUpdate: (onProgress) => updater().installUpdate(onProgress),
  createUpdater, receive, trustedUrl, compareVersions,
};
