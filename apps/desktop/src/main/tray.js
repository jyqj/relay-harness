// @ts-check
const { Tray, Menu, nativeImage } = require('electron');
const { showMain, iconImage, openHarnessSettings, openMarketplace } = require('./window');
const { assetFile } = require('./paths');
const { loadConfig } = require('./config');
const { isSimpleMode, shellMenuEntries } = require('./simple-mode');

let tray = null;

function trayTemplate({ onRestart, onQuit }) {
  return [
    { label: '显示窗口', click: () => showMain() },
    { label: '设置…', click: () => { openHarnessSettings(); } },
    { label: '插件市场', advanced: true, click: () => { openMarketplace(); } },
    { label: '重启 Harness', click: () => onRestart() },
    { type: 'separator' },
    { label: '退出', click: () => onQuit() },
  ];
}

function createTray({ onRestart, onQuit }) {
  if (tray) {
    return tray;
  }

  let image = iconImage();
  if (!image || image.isEmpty()) {
    image = nativeImage.createFromPath(assetFile('icon.svg'));
  }
  if (process.platform === 'win32' && image && !image.isEmpty()) {
    image = image.resize({ width: 24, height: 24 });
  }

  tray = new Tray(image && !image.isEmpty() ? image : nativeImage.createEmpty());
  tray.setToolTip('Relay-Harness-Desktop');
  tray.setContextMenu(Menu.buildFromTemplate(
    shellMenuEntries(trayTemplate({ onRestart, onQuit }), isSimpleMode(loadConfig())),
  ));
  tray.on('click', () => showMain());
  return tray;
}

module.exports = {
  createTray,
  showMain,
  trayTemplate,
};
