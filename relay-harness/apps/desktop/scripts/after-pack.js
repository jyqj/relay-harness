const { prepareRuntimeDeploy, assembleRuntimeDeploy } = require('./runtime-deploy');
const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { LOCKED_INSTALL_ARGS, readPluginLock, matchesLockedInstall } = require('./vendor-lock');
const { missingRuntimeFiles } = require('../src/main/plugin-runtime-files');
const {
  ensureGhosttyAssetsInHarness,
  harnessHasGhosttyAssets,
  missingGhosttyAssetPaths,
} = require('../src/shared/ghostty-assets');

function harnessSourceRoot(projectDir) {
  return path.resolve(projectDir, '..', '..');
}

function missingPluginDependencies(packageDir) {
  return missingRuntimeFiles(packageDir);
}

function defaultNpmInstall(packageDir) {
  readPluginLock(packageDir);
  const nm = path.join(packageDir, 'node_modules');
  if (fs.existsSync(nm)) {
    fs.rmSync(nm, { recursive: true, force: true });
  }
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = [...LOCKED_INSTALL_ARGS];
  const result = spawnSync(npmCmd, args, {
    cwd: packageDir,
    stdio: 'inherit',
    env: process.env,
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    throw new Error(`${npmCmd} ${args.join(' ')} failed in ${packageDir} (status ${result.status})`);
  }
}

/**
 * extraResources from a plugin directory drops that directory's node_modules.
 * Copy vendor/<name>/node_modules into the packaged tree when a declared
 * dependency or its export file is still missing.
 */
function restoreVendoredPluginNodeModules(projectDir, resources, packageName) {
  const srcNm = path.join(projectDir, 'vendor', packageName, 'node_modules');
  const destPkg = path.join(resources, 'vendor', packageName);
  if (!fs.existsSync(path.join(destPkg, 'package.json'))) {
    return { restored: false, reason: 'missing-dest-package' };
  }
  if (!fs.existsSync(srcNm)) {
    return { restored: false, reason: 'missing-source-node-modules' };
  }
  const missing = missingPluginDependencies(destPkg);
  if (missing.length === 0) {
    return { restored: false, reason: 'already-present' };
  }
  fs.cpSync(srcNm, path.join(destPkg, 'node_modules'), { recursive: true, force: true });
  return { restored: true, missing };
}

/**
 * Git-tracked plugin node_modules can omit export files (repo dist/ ignore).
 * Wipe and install with npm ci from a verified lock when the packaged tree is incomplete.
 * @param {string} packageDir
 * @param {{ run?: (dir: string) => void, skipIfComplete?: boolean }} [options]
 */
function installPluginRuntimeDeps(packageDir, options = {}) {
  if (!fs.existsSync(path.join(packageDir, 'package.json'))) {
    return { installed: false, reason: 'missing-package' };
  }
  readPluginLock(packageDir);
  const missing = missingPluginDependencies(packageDir);
  if (options.skipIfComplete && missing.length === 0 && matchesLockedInstall(packageDir)) {
    return { installed: false, reason: 'already-present' };
  }
  const run = options.run || defaultNpmInstall;
  run(packageDir);
  return { installed: true, missing };
}

function assertVendoredPluginRuntimeDeps(resources, packageName) {
  const destPkg = path.join(resources, 'vendor', packageName);
  const missing = missingPluginDependencies(destPkg);
  if (missing.length) {
    throw new Error(`packaged ${packageName} is missing node_modules: ${missing.join(', ')}`);
  }
}

function longPath(target) {
  const abs = path.resolve(target);
  if (process.platform !== 'win32' || abs.length < 240) {
    return abs;
  }
  if (abs.startsWith('\\\\?\\')) {
    return abs;
  }
  if (abs.startsWith('\\\\')) {
    return `\\\\?\\UNC\\${abs.slice(2)}`;
  }
  return `\\\\?\\${abs}`;
}

function resolveResourcesDir(context) {
  if (context?.packager && typeof context.packager.getResourcesDir === 'function') {
    return context.packager.getResourcesDir(context.appOutDir);
  }
  if (context?.electronPlatformName === 'darwin') {
    const product = context.packager?.appInfo?.productFilename || 'Relay-Harness-Desktop';
    return path.join(context.appOutDir, `${product}.app`, 'Contents', 'Resources');
  }
  return path.join(context.appOutDir, 'resources');
}

function copyBundledNode(destDir) {
  const src = [
    process.env.NODE_BINARY,
    process.execPath,
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
  ].find((candidate) => candidate && fs.existsSync(candidate) && !/electron/i.test(candidate));
  if (!src) {
    throw new Error('打包时未找到 Node.js 可执行文件，安装包将无法启动官方 Web UI');
  }
  const dest = path.join(destDir, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.copyFileSync(src, dest);
  if (process.platform !== 'win32') {
    fs.chmodSync(dest, 0o755);
  }
  return dest;
}

function copyBundledPnpm(projectDir, destDir) {
  const src = path.join(projectDir, 'node_modules', 'pnpm');
  if (!fs.existsSync(path.join(src, 'bin', 'pnpm.cjs'))) {
    throw new Error('打包时未找到 pnpm，请先 npm install');
  }
  const dest = path.join(destDir, 'pnpm');
  fs.cpSync(src, dest, { recursive: true, dereference: true });
  return dest;
}

function resolveDeployDir(deployEnv) {
  if (!deployEnv || deployEnv === 'off') {
    return null;
  }
  return path.resolve(deployEnv);
}

function nodePtyPrebuildRelative(platform = process.platform, arch = process.arch) {
  const folder = `${platform}-${arch}`;
  if (platform === 'win32') {
    return path.join('prebuilds', folder, 'conpty.node');
  }
  return path.join('prebuilds', folder, 'pty.node');
}

function resolveNodePtyRoot(harnessDest) {
  const direct = path.join(harnessDest, 'node_modules', 'node-pty');
  if (fs.existsSync(path.join(direct, 'package.json'))) {
    return direct;
  }
  throw new Error('安装包缺少 node-pty');
}

function assertHarnessVersions(harnessDest, pin) {
  if (!pin || typeof pin.npm !== 'string' || pin.npm.trim() === '') {
    throw new Error('assertHarnessRuntime requires pin.npm');
  }
  const rootPkg = JSON.parse(fs.readFileSync(path.join(harnessDest, 'package.json'), 'utf8'));
  const cliPkg = JSON.parse(fs.readFileSync(path.join(harnessDest, 'apps', 'cli', 'package.json'), 'utf8'));
  if (rootPkg.version !== pin.npm || cliPkg.version !== pin.npm) {
    throw new Error(
      `安装包 Harness 版本 ${rootPkg.version}/${cliPkg.version} 与 pin.npm ${pin.npm} 不一致`,
    );
  }
}

function assertNodePtyPrebuild(harnessDest, platform = process.platform, arch = process.arch) {
  const relative = nodePtyPrebuildRelative(platform, arch);
  const native = path.join(resolveNodePtyRoot(harnessDest), relative);
  if (!fs.existsSync(native)) {
    throw new Error(`安装包缺少 node-pty prebuild：${relative}`);
  }
}

function assertHarnessRuntime(harnessDest, pin) {
  const requiredFiles = [
    path.join('apps', 'cli', 'lib', 'bin.js'),
    path.join('apps', 'web', 'dist', 'index.html'),
    path.join('node_modules', '@relay-harness', 'rlh-app-boot', 'lib', 'features.js'),
    path.join('node_modules', '@relay-harness', 'rlh-client-modules', 'lib', 'index.js'),
    path.join('node_modules', '@relay-harness', 'rlh-client-ui-conversation', 'lib', 'client.js'),
    path.join('node_modules', '@relay-harness', 'rlh-mcp-servers-file', 'lib', 'index.js'),
    path.join('node_modules', '@relay-harness', 'rlh-host-mcp-servers', 'lib', 'index.js'),
    path.join('node_modules', '@relay-harness', 'rlh-host-skill-inventory', 'lib', 'index.js'),
    path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-mcp', 'lib', 'index.js'),
    path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-mcp', 'lib', 'client.js'),
    path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-skills', 'lib', 'index.js'),
    path.join('node_modules', '@relay-harness', 'rlh-client-ui-settings-skills', 'lib', 'client.js'),
  ];
  const missing = requiredFiles.filter((relative) => !fs.existsSync(path.join(harnessDest, relative)));
  if (missing.length > 0) {
    throw new Error(`安装包缺少 Harness 运行时产物：${missing.join(', ')}`);
  }

  // Root client tsdown does not run copy-ghostty-assets; fill lib/assets before the gate.
  ensureGhosttyAssetsInHarness(harnessDest);
  if (!harnessHasGhosttyAssets(harnessDest)) {
    throw new Error(
      `安装包缺少终端 Ghostty 资源（dirname(client.js)/assets）：${missingGhosttyAssetPaths(harnessDest).join(', ')}`,
    );
  }

  const features = fs.readFileSync(
    path.join(harnessDest, 'node_modules', '@relay-harness', 'rlh-app-boot', 'lib', 'features.js'),
    'utf8',
  );
  const modules = fs.readFileSync(
    path.join(harnessDest, 'node_modules', '@relay-harness', 'rlh-client-modules', 'lib', 'index.js'),
    'utf8',
  );
  const conversation = fs.readFileSync(
    path.join(harnessDest, 'node_modules', '@relay-harness', 'rlh-client-ui-conversation', 'lib', 'client.js'),
    'utf8',
  );
  const requiredFeatures = [
    'conversation.chat.user-actions',
    'session.fork.beforeSeq',
    'session.fork.blank',
  ];
  const missingFeatures = requiredFeatures.filter((feature) => !features.includes(feature));
  if (missingFeatures.length > 0) {
    throw new Error(`安装包的 Harness 缺少宿主能力：${missingFeatures.join(', ')}`);
  }
  const cliLib = path.join(harnessDest, 'apps', 'cli', 'lib');
  const cliGatePresent = fs.readdirSync(cliLib)
    .filter((name) => name.endsWith('.js'))
    .some((name) => {
      const code = fs.readFileSync(path.join(cliLib, name), 'utf8');
      return code.includes('missingHostFeatures') && code.includes('parseCompatibilityFeatures');
    });
  if (!cliGatePresent) {
    throw new Error('安装包的 rlh CLI 缺少插件兼容性门禁');
  }
  if (!modules.includes('missingHostFeatures') || !modules.includes('parseCompatibilityFeatures')) {
    throw new Error('安装包的 Browser 模块图缺少插件兼容性门禁');
  }
  if (!conversation.includes('conversation.chat.user-actions')) {
    throw new Error('安装包的会话 UI 缺少用户消息 action slot');
  }
  assertHarnessVersions(harnessDest, pin);
  assertNodePtyPrebuild(harnessDest);
}

/** Reject cross-target builds before any install, copy, or output cleanup.
 * The archive bundles this runner's Node executable and production native deps.
 * Electron's numeric Arch enum is authoritative; universal needs a distinct
 * multi-architecture assembly strategy rather than relabelling this runtime.
 */
function assertNativeRuntimeTarget(context, runner = process) {
  const { Arch } = require('electron-builder');
  const targetArch = typeof context.arch === 'number' ? Arch[context.arch] : undefined;
  const runnerArch = runner.arch === 'arm' ? 'armv7l' : runner.arch;
  if (context.electronPlatformName !== runner.platform || targetArch !== runnerArch) {
    throw new Error(`Desktop runtime assembly requires its native platform and architecture runner (target ${context.electronPlatformName}/${targetArch}, runner ${runner.platform}/${runnerArch})`);
  }
}

module.exports = async function afterPack(context) {
  assertNativeRuntimeTarget(context);
  const projectDir = context.packager.projectDir;
  const resources = resolveResourcesDir(context);
  readPluginLock(path.join(resources, 'vendor', 'rlhmarket'));
  restoreVendoredPluginNodeModules(projectDir, resources, 'rlhmarket');
  installPluginRuntimeDeps(path.join(resources, 'vendor', 'rlhmarket'));
  assertVendoredPluginRuntimeDeps(resources, 'rlhmarket');
  const harnessDest = path.join(resources, 'vendor', 'relay-harness');
  const deployDir = resolveDeployDir(process.env.RLH_DEPLOY_DIR);
  const started = Date.now();

  const prepared = deployDir ? null : prepareRuntimeDeploy(projectDir);
  let copied;
  try {
    fs.rmSync(harnessDest, { recursive: true, force: true });
    copied = assembleRuntimeDeploy(harnessSourceRoot(projectDir), deployDir || prepared.root, harnessDest);
  } finally {
    if (prepared) fs.rmSync(prepared.root, { recursive: true, force: true });
  }

  const nodeDest = copyBundledNode(resources);
  const pnpmDest = copyBundledPnpm(projectDir, resources);
  const pin = JSON.parse(fs.readFileSync(path.join(projectDir, 'vendor', 'harness-upstream.json'), 'utf8'));
  fs.mkdirSync(path.join(resources, 'vendor'), { recursive: true });
  fs.writeFileSync(
    path.join(resources, 'vendor', 'harness-upstream.json'),
    `${JSON.stringify(pin, null, 2)}\n`,
  );
  assertHarnessRuntime(harnessDest, pin);
  execFileSync(nodeDest, [path.join(harnessDest, 'apps/cli/lib/bin.js'), '--help'], {
    cwd: harnessDest, timeout: 15_000, stdio: 'pipe',
    env: { ...process.env, RLH_TELEMETRY_DISABLED: '1' },
  });

  const archive = path.join(resources, 'vendor', 'relay-harness.tar');
  console.log('打包运行时为单个 tar，减少 NSIS 解压文件数…');
  execFileSync('tar', ['-cf', path.basename(archive), '-C', path.basename(harnessDest), '.'], {
    cwd: path.dirname(harnessDest),
    stdio: 'inherit',
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  if (!fs.existsSync(archive) || fs.statSync(archive).size < 1024) {
    throw new Error('运行时 tar 生成失败');
  }
  fs.rmSync(longPath(harnessDest), { recursive: true, force: true });

  console.log(`已复制 ${copied} 个文件，写入 ${nodeDest} 与 ${pnpmDest}`);
  console.log(`运行时归档 ${((fs.statSync(archive).size / 1048576).toFixed(1))} MB`);
  console.log(`afterPack 完成 ${((Date.now() - started) / 1000).toFixed(1)}s`);
};

module.exports.resolveDeployDir = resolveDeployDir;
module.exports.resolveResourcesDir = resolveResourcesDir;
module.exports.assertHarnessRuntime = assertHarnessRuntime;
module.exports.assertHarnessVersions = assertHarnessVersions;
module.exports.assertNodePtyPrebuild = assertNodePtyPrebuild;
module.exports.assertVendoredPluginRuntimeDeps = assertVendoredPluginRuntimeDeps;
module.exports.installPluginRuntimeDeps = installPluginRuntimeDeps;
module.exports.nodePtyPrebuildRelative = nodePtyPrebuildRelative;
module.exports.restoreVendoredPluginNodeModules = restoreVendoredPluginNodeModules;
module.exports.ensureGhosttyAssetsInHarness = ensureGhosttyAssetsInHarness;

module.exports.assertNativeRuntimeTarget = assertNativeRuntimeTarget;
