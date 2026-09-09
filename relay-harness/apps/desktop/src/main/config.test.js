const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'rlh-config-test-'));
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: {
      isPackaged: false,
      getPath(name) {
        if (name === 'userData') return userData;
        if (name === 'documents') return userData;
        return userData;
      },
    },
  },
};

const {
  DEFAULTS,
  REMOTE_FEATURE_ENABLED,
  credentialsPath,
  loadConfig,
  publicConfig,
  saveConfig,
  normalizeHarnessRecovery,
  normalizeRendererConfigPatch,
  normalizeShellSurface,
} = require('./config');

test.after(() => {
  fs.rmSync(userData, { recursive: true, force: true });
});

test('Harness recovery defaults are bounded and enabled', () => {
  assert.equal(DEFAULTS.harnessAutoRestart, true);
  assert.equal(DEFAULTS.harnessRestartMaxAttempts, 3);
  assert.equal(DEFAULTS.harnessRestartBaseDelayMs, 1000);
  assert.deepEqual(normalizeHarnessRecovery({}), {
    harnessAutoRestart: true,
    harnessRestartMaxAttempts: 3,
    harnessRestartBaseDelayMs: 1000,
  });
});

test('invalid recovery settings fall back to safe defaults', () => {
  const invalid = normalizeHarnessRecovery({
    harnessAutoRestart: 'yes',
    harnessRestartMaxAttempts: 0,
    harnessRestartBaseDelayMs: 90_000,
  });
  assert.equal(invalid.harnessAutoRestart, true);
  assert.equal(invalid.harnessRestartMaxAttempts, 3);
  assert.equal(invalid.harnessRestartBaseDelayMs, 1000);

  assert.equal(normalizeHarnessRecovery({ harnessRestartMaxAttempts: 10 }).harnessRestartMaxAttempts, 10);
  assert.equal(normalizeHarnessRecovery({ harnessRestartBaseDelayMs: 500 }).harnessRestartBaseDelayMs, 500);
  assert.equal(normalizeHarnessRecovery({ harnessRestartBaseDelayMs: 30_000 }).harnessRestartBaseDelayMs, 30_000);
});

test('renderer config patch only accepts safe typed fields', () => {
  assert.deepEqual(normalizeRendererConfigPatch({
    closeToTray: false,
    locale: 'en',
    harnessRestartMaxAttempts: 4,
    githubToken: ' token ',
  }), {
    closeToTray: false,
    locale: 'en',
    harnessRestartMaxAttempts: 4,
    githubToken: 'token',
  });
  for (const patch of [
    { rlhBin: 'C:\\malware.cmd' },
    { nodeBin: 'C:\\malware.exe' },
    { workspace: 'C:\\' },
    { baseUrl: 'https://attacker.invalid' },
    { closeToTray: 'yes' },
    { simpleMode: 'on' },
    { harnessRestartMaxAttempts: 99 },
  ]) {
    assert.throws(() => normalizeRendererConfigPatch(patch));
  }
});

test('simple mode is on for fresh installs and an explicit choice survives a round trip', () => {
  assert.equal(DEFAULTS.simpleMode, true);
  assert.deepEqual(normalizeRendererConfigPatch({ simpleMode: true }), { simpleMode: true });
  assert.equal(normalizeShellSurface({}).simpleMode, false);
  assert.equal(normalizeShellSurface({ simpleMode: 'yes' }).simpleMode, false);

  try {
    assert.equal(saveConfig({ simpleMode: true }).simpleMode, true);
    assert.equal(loadConfig().simpleMode, true);
    assert.equal(publicConfig(loadConfig()).simpleMode, true);
  } finally {
    saveConfig({ simpleMode: false });
  }
  assert.equal(loadConfig().simpleMode, false);
});

test('Remote remains deferred and persisted requests cannot enable a network entry', () => {
  assert.equal(REMOTE_FEATURE_ENABLED, false);
  const httpRelay = saveConfig({
    remoteEnabled: true,
    remoteMode: 'relay',
    remoteRelayUrl: 'http://relay.example:8787/path',
    remoteRelayToken: 'a'.repeat(32),
  });
  assert.equal(httpRelay.remoteEnabled, false);
  assert.equal(httpRelay.remoteMode, 'lan');
  assert.equal(httpRelay.remoteRelayUrl, '');
  const httpsRelay = saveConfig({
    remoteEnabled: true,
    remoteMode: 'relay',
    remoteRelayUrl: 'https://relay.example/path',
    remoteRelayToken: 'a'.repeat(32),
  });
  assert.equal(httpsRelay.remoteEnabled, false);
  assert.equal(httpsRelay.remoteMode, 'lan');
  assert.equal(httpsRelay.remoteRelayUrl, '');
  assert.deepEqual(publicConfig({
    ...DEFAULTS,
    remoteEnabled: true,
    remoteMode: 'relay',
    remoteRelayUrl: 'https://relay.example',
  }), {
    ...DEFAULTS,
    apiKey: '',
    githubToken: '',
    hasApiKey: false,
    simpleMode: true,
    hasGithubToken: false,
    remoteEnabled: false,
    remoteAvailable: false,
    remoteMode: 'lan',
    remoteRelayUrl: '',
    remoteToken: '',
    remoteRelayToken: '',
    remoteDevices: [],
  });
});

test('saveConfig persists normalized recovery settings', () => {
  const saved = saveConfig({
    workspace: userData,
    harnessAutoRestart: false,
    harnessRestartMaxAttempts: 5,
    harnessRestartBaseDelayMs: 2000,
  });
  assert.equal(saved.harnessAutoRestart, false);
  assert.equal(saved.harnessRestartMaxAttempts, 5);
  assert.equal(saved.harnessRestartBaseDelayMs, 2000);

  const loaded = loadConfig();
  assert.equal(loaded.harnessAutoRestart, false);
  assert.equal(loaded.harnessRestartMaxAttempts, 5);
  assert.equal(loaded.harnessRestartBaseDelayMs, 2000);
});

test('saveConfig rejects out-of-range recovery values before writing', () => {
  saveConfig({
    harnessRestartMaxAttempts: 11,
    harnessRestartBaseDelayMs: 499,
  });
  const loaded = loadConfig();
  assert.equal(loaded.harnessRestartMaxAttempts, DEFAULTS.harnessRestartMaxAttempts);
  assert.equal(loaded.harnessRestartBaseDelayMs, DEFAULTS.harnessRestartBaseDelayMs);
});

test('publicConfig masks credentials and only reports presence flags', () => {
  const file = credentialsPath();
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  fs.writeFileSync(file, `${JSON.stringify({
    apiKey: 'sk-test-secret',
    githubToken: 'ghp_test_secret',
    remoteToken: 'rt-test-secret',
  }, null, 2)}\n`, { mode: 0o600 });
  try {
    const view = publicConfig(loadConfig());
    assert.equal(view.apiKey, '********');
    assert.equal(view.githubToken, '********');
    assert.equal(view.remoteToken, '');
    assert.equal(view.hasApiKey, true);
    assert.equal(view.hasGithubToken, true);
  } finally {
    if (before === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, before, { mode: 0o600 });
  }
});

test('saveConfig never creates a new Desktop-owned API key', () => {
  const file = credentialsPath();
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  fs.rmSync(file, { force: true });
  try {
    saveConfig({ apiKey: 'must-live-behind-runtime-credentials' });
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(Object.hasOwn(stored, 'apiKey'), false);
    assert.equal(loadConfig().apiKey, '');
  } finally {
    if (before === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, before, { mode: 0o600 });
  }
});

test('corrupt config.json fails loud, is quarantined, and falls back to defaults', () => {
  const file = path.join(userData, 'config.json');
  fs.writeFileSync(file, '{ not valid json', 'utf8');
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  let loaded;
  try {
    loaded = loadConfig();
  } finally {
    console.error = originalError;
  }
  assert.equal(typeof loaded, 'object');
  assert.equal(loaded.port, DEFAULTS.port, '损坏文件应回退到默认值');
  assert.equal(loaded.host, DEFAULTS.host);
  assert.ok(
    errors.some((message) => message.includes('config.json') && message.includes('quarantined')),
    '应向 stderr 响亮报告隔离',
  );
  const quarantined = fs.readdirSync(userData).filter((name) => name.startsWith('config.json.corrupt-'));
  assert.equal(quarantined.length, 1, '原始字节必须被隔离保存，而不是被下一次 saveConfig 覆盖');
  assert.ok(fs.readFileSync(path.join(userData, quarantined[0]), 'utf8').includes('not valid json'));
});

test('corrupt credentials.json fails loud, is quarantined, and credential fields fall back', () => {
  const file = path.join(userData, 'credentials.json');
  fs.writeFileSync(file, ']] not json [[', 'utf8');
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(String(message));
  let loaded;
  try {
    loaded = loadConfig();
  } finally {
    console.error = originalError;
  }
  assert.equal(loaded.apiKey, '');
  assert.equal(loaded.githubToken, '');
  assert.ok(
    errors.some((message) => message.includes('credentials.json') && message.includes('quarantined')),
    '凭据文件损坏同样必须响亮报告隔离',
  );
  const quarantined = fs.readdirSync(userData).filter((name) => name.startsWith('credentials.json.corrupt-'));
  assert.equal(quarantined.length, 1, '损坏的凭据原件必须被隔离保存');
});
