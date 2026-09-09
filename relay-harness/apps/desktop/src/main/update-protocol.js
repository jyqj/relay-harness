// @ts-check
'use strict';
const { createPublicKey, verify } = require('node:crypto');

const MANIFEST_NAME = 'relay-desktop-update.v1.json';
const SIGNATURE_NAME = `${MANIFEST_NAME}.sig`;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_INSTALLER_BYTES = 512 * 1024 * 1024;

class UpdateUnavailable extends Error {}

/** @param {unknown} value @returns {Record<string, unknown>} */
function record(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid update record');
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {unknown} value @returns {number[]} */
function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new UpdateUnavailable('Automatic updates require a stable three-part version');
  }
  const parts = value.split('.').map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new UpdateUnavailable('Invalid update version');
  return parts;
}

/** @param {string} left @param {string} right */
function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

/** Read trust only from installed build metadata, never renderer input. @param {unknown} metadata */
function resolveTrust(metadata) {
  try {
    const pkg = record(metadata);
    if (pkg.desktopUpdate === undefined) throw new UpdateUnavailable('This build has no configured update signing authority');
    const config = record(pkg.desktopUpdate);
    const build = record(pkg.build);
    if (config.schemaVersion !== 1 || typeof config.productId !== 'string' || !config.productId
      || config.productId !== build.appId || typeof config.repository !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(config.repository)
      || typeof config.publicKey !== 'string') throw new UpdateUnavailable('Invalid update build authority');
    const publicKey = createPublicKey(config.publicKey);
    if (publicKey.asymmetricKeyType !== 'ed25519') throw new UpdateUnavailable('Update authority must use Ed25519');
    const installerTemplate = record(build.nsis).artifactName;
    if (typeof installerTemplate !== 'string') throw new UpdateUnavailable('No NSIS artifact naming protocol configured');
    return {
      productId: config.productId, repository: config.repository, publicKey, installerTemplate,
      repoUrl: `https://github.com/${config.repository}`,
      releasesUrl: `https://github.com/${config.repository}/releases`,
      apiUrl: `https://api.github.com/repos/${config.repository}/releases/latest`,
    };
  } catch (error) {
    if (error instanceof UpdateUnavailable) throw error;
    throw new UpdateUnavailable('Invalid update build authority');
  }
}

/** @param {ReturnType<typeof resolveTrust>} trust @param {string} tag @param {string} name */
function assetUrl(trust, tag, name) {
  return `${trust.releasesUrl}/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

/** Verify the original signed bytes before JSON parsing. @param {Buffer} bytes @param {Buffer} signatureBytes @param {ReturnType<typeof resolveTrust>} trust @param {{ current: string, platform: string, arch: string, now: number, tag: string }} runtime */
function verifyManifest(bytes, signatureBytes, trust, runtime) {
  if (bytes.length > MAX_MANIFEST_BYTES) throw new Error('Update manifest is too large');
  const signature = signatureBytes.toString('utf8').trim();
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)
    || !verify(null, bytes, trust.publicKey, Buffer.from(signature, 'base64'))) throw new Error('Update publisher signature is invalid');
  const manifest = record(JSON.parse(bytes.toString('utf8')));
  if (manifest.schemaVersion !== 1 || manifest.productId !== trust.productId
    || typeof manifest.version !== 'string' || manifest.tag !== runtime.tag
    || typeof manifest.expiresAt !== 'string') throw new Error('Update manifest identity is invalid');
  const expiresAt = Date.parse(manifest.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= runtime.now) throw new Error('Update manifest has expired');
  if (runtime.platform !== 'win32' || runtime.arch !== 'x64') throw new UpdateUnavailable('No verified installer protocol for this platform');
  const newer = compareVersions(manifest.version, runtime.current) > 0;
  if (!Array.isArray(manifest.artifacts)) throw new Error('Update manifest has no artifact list');
  const artifacts = manifest.artifacts.map(record).filter(value => value.platform === runtime.platform && value.arch === runtime.arch);
  if (artifacts.length !== 1) throw new UpdateUnavailable('No unambiguous artifact for this platform and architecture');
  const artifact = artifacts[0];
  const expectedName = trust.installerTemplate.replaceAll('${version}', manifest.version).replaceAll('${ext}', 'exe').replaceAll('${arch}', runtime.arch);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.exe$/.test(expectedName) || artifact.kind !== 'nsis'
    || artifact.name !== expectedName || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(artifact.sha256)
    || typeof artifact.size !== 'number' || !Number.isSafeInteger(artifact.size) || artifact.size <= 0
    || artifact.size > MAX_INSTALLER_BYTES) throw new Error('Update artifact does not match this product build');
  return {
    version: manifest.version, newer, expiresAt, name: expectedName, size: artifact.size, sha256: artifact.sha256,
    url: assetUrl(trust, runtime.tag, expectedName), notes: typeof manifest.notes === 'string' ? manifest.notes : '',
  };
}

module.exports = { MANIFEST_NAME, SIGNATURE_NAME, MAX_MANIFEST_BYTES, UpdateUnavailable, record, compareVersions, resolveTrust, assetUrl, verifyManifest };
