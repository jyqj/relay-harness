const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { syncVendorInstalls } = require('./vendor-installs.js');

const repoRoot = path.join(__dirname, '..');

// The marketplace plugin mounts from vendor/, which needs its install present.
// Without one the shell still starts and reports the plugin as unavailable.
try {
  syncVendorInstalls({ log: (message) => console.log(message) });
} catch (error) {
  console.warn(`未能安装内置插件依赖，市场插件将不可用：${error.message}`);
}

function candidates() {
  const list = [];
  if (process.env.ELECTRON_PATH) {
    list.push(process.env.ELECTRON_PATH);
  }
  list.push(
    path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron.exe'),
    path.join(repoRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    path.join(repoRoot, 'node_modules', 'electron', 'dist', 'electron'),
  );
  return list;
}

const electronBin = candidates().find((item) => item && fs.existsSync(item));
if (!electronBin) {
  console.error('未找到本机 Electron。设置环境变量 ELECTRON_PATH 指向 electron.exe，或把已有的 dist 目录放到 node_modules/electron/dist。');
  process.exit(1);
}

const child = spawn(electronBin, ['.'], {
  cwd: repoRoot,
  stdio: 'inherit',
  windowsHide: false,
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
