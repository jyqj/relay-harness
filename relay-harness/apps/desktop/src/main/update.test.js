const assert = require('node:assert/strict');
const { test, afterEach } = require('node:test');
const { generateKeyPairSync, sign, createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createUpdater, trustedUrl, compareVersions } = require('./update');
const { MANIFEST_NAME, SIGNATURE_NAME, assetUrl, resolveTrust, verifyManifest } = require('./update-protocol');

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function fixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlhd-update-test-'));
  roots.push(root);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const metadata = {
    build: { appId: 'test.relay.desktop', nsis: { artifactName: 'Relay-Desktop-Setup-${version}.${ext}' } },
    desktopUpdate: { schemaVersion: 1, productId: 'test.relay.desktop', repository: 'fixture-owner/fixture-repo', publicKey: publicKey.export({ format: 'pem', type: 'spki' }) },
  };
  const state = { now: Date.UTC(2026, 8, 5), version: '1.0.0', requests: [], launches: [], quitCalls: 0, downloads: 0 };
  const payload = Buffer.from('non-executable signed test fixture');
  const manifest = {
    schemaVersion: 1, productId: metadata.build.appId, version: '1.1.0', tag: 'desktop-v1.1.0',
    expiresAt: new Date(state.now + 60_000).toISOString(),
    artifacts: [{ platform: 'win32', arch: 'x64', kind: 'nsis', name: 'Relay-Desktop-Setup-1.1.0.exe', size: payload.length, sha256: createHash('sha256').update(payload).digest('hex') }],
  };
  options.manifest?.(manifest);
  const trust = resolveTrust(metadata);
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const signature = Buffer.from(sign(null, manifestBytes, privateKey).toString('base64'));
  if (options.badSignature) signature[0] = signature[0] === 65 ? 66 : 65;
  const release = {
    tag_name: manifest.tag,
    assets: [MANIFEST_NAME, SIGNATURE_NAME, manifest.artifacts[0].name].map(name => ({ name, browser_download_url: assetUrl(trust, manifest.tag, name) })),
  };
  const app = {
    isPackaged: options.isPackaged ?? true,
    getVersion: () => state.version,
    getPath: () => root,
    quit: () => { state.quitCalls += 1; },
  };
  const updater = createUpdater({
    metadata: options.metadata === undefined ? metadata : options.metadata,
    app, platform: options.platform ?? 'win32', arch: options.arch ?? 'x64', now: () => state.now,
    receive: async (url, limit, onChunk) => {
      state.requests.push(url);
      let body;
      if (url === trust.apiUrl) body = Buffer.from(JSON.stringify(release));
      else if (url === assetUrl(trust, manifest.tag, MANIFEST_NAME)) body = options.manifestBytes ?? manifestBytes;
      else if (url === assetUrl(trust, manifest.tag, SIGNATURE_NAME)) body = signature;
      else {
        state.downloads += 1;
        await options.beforeDownload?.(state);
        if (options.downloadError) throw new Error('download interrupted');
        body = options.payload ?? payload;
      }
      if (body.length > limit) throw new Error('size bound');
      onChunk(body);
      return body.length;
    },
    launch: async (file) => {
      if (options.launchError) throw new Error('installer spawn failed');
      assert.deepEqual(fs.readFileSync(file), payload);
      state.launches.push(file);
    },
  });
  return { root, state, updater, trust, manifest, manifestBytes, signature };
}

function noExecutables(root) {
  const entries = fs.existsSync(path.join(root, 'updates')) ? fs.readdirSync(path.join(root, 'updates')) : [];
  assert.deepEqual(entries, []);
}

test('missing build signing authority is unavailable and never downloads or executes', async () => {
  const { updater, state } = fixture({ metadata: {} });
  assert.equal((await updater.checkUpdate()).status, 'unavailable');
  assert.equal((await updater.installUpdate()).launched, false);
  assert.deepEqual(state.requests, []);
  assert.deepEqual(state.launches, []);
});

for (const options of [{ platform: 'darwin' }, { arch: 'arm64' }, { isPackaged: false }]) {
  test(`unsupported runtime is unavailable: ${JSON.stringify(options)}`, async () => {
    const { updater, state } = fixture(options);
    assert.equal((await updater.installUpdate()).status, 'unavailable');
    assert.deepEqual(state.requests, []);
  });
}

test('checks signed release, rechecks at install, verifies digest, and launches exactly once', async () => {
  const { updater, state } = fixture();
  assert.equal((await updater.checkUpdate()).status, 'available');
  const [a, b] = await Promise.all([updater.installUpdate(), updater.installUpdate()]);
  assert.equal(a.launched, true);
  assert.equal(b.installer, a.installer);
  assert.equal(state.downloads, 1);
  assert.equal(state.launches.length, 1);
  assert.equal((await updater.installUpdate()).status, 'unavailable');
  assert.equal(state.launches.length, 1);
});

for (const version of ['1.1.0', '2.0.0']) {
  test(`never downloads or launches an equal or older version than ${version}`, async () => {
    const { updater, state } = fixture();
    state.version = version;
    const result = await updater.installUpdate();
    assert.equal(result.status, 'current');
    assert.equal(result.launched, false);
    assert.equal(state.downloads, 0);
  });
}

for (const [name, options] of [
  ['publisher signature', { badSignature: true }],
  ['product identity', { manifest: m => { m.productId = 'another.product'; } }],
  ['artifact identity', { manifest: m => { m.artifacts[0].name = 'Other-Setup.exe'; } }],
  ['platform binding', { manifest: m => { m.artifacts[0].platform = 'darwin'; } }],
  ['architecture binding', { manifest: m => { m.artifacts[0].arch = 'arm64'; } }],
  ['expiration', { manifest: m => { m.expiresAt = '2020-01-01T00:00:00Z'; } }],
  ['signature before parsing invalid JSON', { manifestBytes: Buffer.from('{broken unsigned json') }],
]) {
  test(`rejects invalid ${name} before installer download`, async () => {
    const { updater, state, root } = fixture(options);
    const result = await updater.installUpdate();
    assert.equal(result.launched, false);
    assert.equal(state.downloads, 0);
    assert.equal(state.launches.length, 0);
    noExecutables(root);
  });
}

for (const [name, options] of [
  ['digest', { payload: Buffer.from('X'.repeat(Buffer.byteLength('non-executable signed test fixture'))) }],
  ['size', { payload: Buffer.from('short') }],
  ['download interruption', { downloadError: true }],
  ['launch error', { launchError: true }],
  ['expiry during download', { beforeDownload: state => { state.now += 120_000; } }],
  ['version change during download', { beforeDownload: state => { state.version = '2.0.0'; } }],
]) {
  test(`rejects ${name} and removes all partial/executable files`, async () => {
    const { updater, state, root } = fixture(options);
    const result = await updater.installUpdate();
    assert.equal(result.launched, false);
    assert.equal(state.launches.length, 0);
    noExecutables(root);
  });
}

test('strict version parser rejects ambiguous and prerelease versions', () => {
  for (const bad of ['1.2', 'v1.2.3', '01.2.3', '1.2.3-beta', '1.2.3+build', '1.2.NaN']) assert.throws(() => compareVersions(bad, '1.0.0'));
  assert.equal(compareVersions('1.10.0', '1.2.0'), 1);
});

test('download URL policy rejects untrusted redirects, credentials, HTTP, and foreign ports', () => {
  for (const bad of ['http://github.com/x', 'https://evil.example/x', 'https://github.com:444/x', 'https://user:pass@github.com/x', 'https://github.com.evil.example/x']) assert.throws(() => trustedUrl(bad));
  assert.equal(trustedUrl('https://release-assets.githubusercontent.com/fixture').protocol, 'https:');
});

test('signature verifier binds the release tag to the signed manifest', () => {
  const { trust, manifestBytes, signature, state } = fixture();
  assert.throws(() => verifyManifest(manifestBytes, signature, trust, { current: '1.0.0', platform: 'win32', arch: 'x64', now: state.now, tag: 'wrong-tag' }));
});

function mockHttps(t, routes) {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const visited = [];
  const requests = [];
  const responses = [];
  t.mock.method(https, 'get', (url, _options, callback) => {
    visited.push(url.href);
    const request = new EventEmitter();
    request.destroyed = false;
    request.destroy = () => {
      if (request.destroyed) return;
      request.destroyed = true;
      if (route?.destroyError) request.emit('error', new Error('retired request closed'));
    };
    requests.push(request);
    const route = routes[visited.length - 1];
    if (route?.stall) return request;
    const deliver = () => {
      const response = new EventEmitter();
      responses.push(response);
      response.statusCode = route?.status ?? 200;
      response.headers = route?.headers ?? {};
      response.destroyed = false;
      response.resume = () => {};
      response.destroy = () => { response.destroyed = true; };
      callback(response);
      if (response.destroyed || response.statusCode !== 200) return;
      for (const chunk of route?.chunks ?? []) response.emit('data', Buffer.from(chunk));
      if (route?.abort) response.emit('aborted');
      else response.emit('end');
    };
    if (route?.delay) setTimeout(deliver, route.delay);
    else queueMicrotask(deliver);
    return request;
  });
  return { visited, requests, responses };
}

test('receive follows a bounded trusted redirect and rejects an untrusted target before requesting it', async (t) => {
  const { receive } = require('./update');
  const mocked = mockHttps(t, [
    { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file' } },
    { chunks: ['signed', 'bytes'] },
    { status: 302, headers: { location: 'http://private.example/evil' } },
  ]);
  const chunks = [];
  assert.equal(await receive('https://github.com/fixture/file', 20, chunk => { chunks.push(chunk); }), 11);
  assert.equal(Buffer.concat(chunks).toString(), 'signedbytes');
  await assert.rejects(receive('https://github.com/fixture/other', 20, () => {}), /Untrusted/);
  assert.equal(mocked.visited.length, 3);
});

for (const [name, route] of [
  ['declared size', { headers: { 'content-length': '99' } }],
  ['streamed size', { chunks: ['1234'] }],
  ['interrupted body', { chunks: ['1'], abort: true }],
  ['HTTP failure', { status: 503 }],
  ['malformed redirect', { status: 302, headers: { location: 'https://[' } }],
]) {
  test(`receive rejects ${name} and destroys its active request`, async (t) => {
    const { receive } = require('./update');
    const mocked = mockHttps(t, [route]);
    await assert.rejects(receive('https://github.com/fixture/file', 3, () => {}));
    assert.equal(mocked.requests[0].destroyed, true);
  });
}

test('receive applies one overall timeout, including a stalled response', async (t) => {
  const { receive } = require('./update');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mocked = mockHttps(t, [{ stall: true }]);
  const pending = assert.rejects(receive('https://github.com/fixture/file', 3, () => {}), /timed out/);
  t.mock.timers.tick(30_001);
  await pending;
  assert.equal(mocked.requests[0].destroyed, true);
});

test('receive bounds redirect loops', async (t) => {
  const { receive } = require('./update');
  const mocked = mockHttps(t, Array.from({ length: 6 }, () => ({ status: 302, headers: { location: 'https://github.com/loop' } })));
  await assert.rejects(receive('https://github.com/loop', 3, () => {}), /Too many/);
  assert.equal(mocked.visited.length, 6);
});


test('receive destroys redirect responses instead of leaving their bodies draining', async (t) => {
  const { receive } = require('./update');
  const mocked = mockHttps(t, [
    { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file' } },
    { chunks: ['ok'] },
  ]);
  await receive('https://github.com/fixture/file', 20, () => {});
  assert.equal(mocked.responses[0].destroyed, true);
  assert.equal(mocked.requests[0].destroyed, true);
});

test('receive refuses a redirect callback delivered after its overall timeout', async (t) => {
  const { receive } = require('./update');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const mocked = mockHttps(t, [
    { delay: 40_000, status: 302, headers: { location: 'https://release-assets.githubusercontent.com/late' } },
    { chunks: ['unwanted'] },
  ]);
  const pending = assert.rejects(receive('https://github.com/fixture/file', 20, () => {}), /timed out/);
  t.mock.timers.tick(30_001);
  await pending;
  t.mock.timers.tick(10_000);
  await Promise.resolve();
  assert.equal(mocked.visited.length, 1);
  assert.equal(mocked.responses[0].destroyed, true);
});


test('receive does not let a retired redirect request cancel its successor', async (t) => {
  const { receive } = require('./update');
  const mocked = mockHttps(t, [
    { destroyError: true, status: 302, headers: { location: 'https://release-assets.githubusercontent.com/file' } },
    { chunks: ['valid'] },
  ]);
  const chunks = [];
  assert.equal(await receive('https://github.com/fixture/file', 20, chunk => { chunks.push(chunk); }), 5);
  assert.equal(Buffer.concat(chunks).toString(), 'valid');
  assert.equal(mocked.requests[0].destroyed, true);
  assert.equal(mocked.requests[1].destroyed, false);
});
