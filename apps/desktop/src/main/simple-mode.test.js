'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    app: { name: 'Relay-Harness-Desktop', isPackaged: false, getPath: () => '/tmp' },
    Menu: { setApplicationMenu() {}, buildFromTemplate: (template) => template },
    Tray: class {},
    nativeImage: { createEmpty: () => ({ isEmpty: () => true }) },
    shell: { openPath() {}, openExternal() {} },
  },
};

const { isAdvancedEntry, isSimpleMode, shellMenuEntries } = require('./simple-mode');
const { menuTemplate } = require('./menu');
const { trayTemplate } = require('./tray');

const noop = () => {};

function labels(entries) {
  return entries.map((entry) => entry.label ?? entry.type);
}

function fileSubmenu(simpleMode) {
  const template = shellMenuEntries(
    menuTemplate({ isMac: false, onOpenWorkspace: noop, onRestart: noop, onReload: noop }),
    simpleMode,
  );
  return labels(template.find((entry) => entry.label === '文件').submenu);
}

test('simple mode is off unless the config turns it on', () => {
  assert.equal(isSimpleMode(null), false);
  assert.equal(isSimpleMode({}), false);
  assert.equal(isSimpleMode({ simpleMode: 'yes' }), false);
  assert.equal(isSimpleMode({ simpleMode: true }), true);
});

test('an entry is advanced only when it says so', () => {
  assert.equal(isAdvancedEntry({ label: '设置…' }), false);
  assert.equal(isAdvancedEntry({ label: '插件市场…', advanced: true }), true);
});

test('the full surface keeps every entry and drops the marker', () => {
  const entries = shellMenuEntries([
    { label: 'Open' },
    { label: 'Market', advanced: true },
  ], false);
  assert.deepEqual(entries, [{ label: 'Open' }, { label: 'Market' }]);
});

test('removing an entry never leaves a stray separator behind', () => {
  const entries = shellMenuEntries([
    { type: 'separator' },
    { label: 'Open' },
    { type: 'separator' },
    { label: 'Market', advanced: true },
    { type: 'separator' },
    { label: 'Quit' },
    { type: 'separator' },
  ], true);
  assert.deepEqual(labels(entries), ['Open', 'separator', 'Quit']);
});

test('simple mode hides the market, MCP and skills from the File menu', () => {
  const full = fileSubmenu(false);
  assert.ok(full.includes('插件市场…'));
  assert.ok(full.includes('MCP…'));
  assert.ok(full.includes('技能…'));

  const simple = fileSubmenu(true);
  assert.equal(simple.includes('插件市场…'), false);
  assert.equal(simple.includes('MCP…'), false);
  assert.equal(simple.includes('技能…'), false);
  assert.ok(simple.includes('设置…'));
  assert.ok(simple.includes('打开工作区…'));
});

test('simple mode hides the market from the tray', () => {
  const full = labels(shellMenuEntries(trayTemplate({ onRestart: noop, onQuit: noop }), false));
  const simple = labels(shellMenuEntries(trayTemplate({ onRestart: noop, onQuit: noop }), true));
  assert.ok(full.includes('插件市场'));
  assert.equal(simple.includes('插件市场'), false);
  assert.deepEqual(simple, ['显示窗口', '设置…', '重启 Harness', 'separator', '退出']);
});
