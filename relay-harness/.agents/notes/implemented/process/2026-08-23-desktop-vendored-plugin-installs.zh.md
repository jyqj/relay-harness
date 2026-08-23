# Agent Note: Install the desktop's vendored plugin dependencies instead of committing them

Status: implemented

[English](2026-08-23-desktop-vendored-plugin-installs.md) | 中文

## Problem

`apps/desktop/vendor/` 放着桌面外壳要打进安装包的两个插件：市场插件 `rlhmarket` 与侧边栏机器人插件 `rlhbot`。electron-builder 通过 `extraResources` 整目录复制，因此插件运行时需要的一切都必须在打包那一刻就在磁盘上——装好的应用没有机会事后再去取。

这棵树此前靠提交 `rlhmarket/node_modules` 来满足该要求：`argparse`、`js-yaml`、`undici` 共 249 个文件，逐条在仓库级 `node_modules/` 与 `dist/` 忽略规则之外点名放行。要求是满足了，但也把一份第三方安装结果变成了需要评审的源码。没有任何检查把这些提交的文件与旁边的锁文件对照，于是手工改动、复制不全、或与 `package-lock.json` 不再一致的版本都看不出来；实际上 vendored 的 `js-yaml` 就已经丢掉了 npm 给 `bin` 入口设置的可执行位。评审一份依赖升级 diff 的人，得去读压缩过的 vendor 产物，才能判断改动是不是那次升级带来的。

## Decision

vendored 插件的依赖是安装出来的，不是提交进来的。在 `apps/desktop` 执行 `pnpm run vendor:sync`，会对每个带 `package-lock.json` 的 vendored 插件运行 `npm ci --omit=dev --ignore-scripts`；当各处安装已与锁文件一致时直接返回。这段逻辑在 `scripts/vendor-installs.js`；`scripts/run-electron-builder.cjs` 与 `scripts/run-electron.js` 会调用它，因此打包与 `pnpm start` 不依赖开发者记得手动跑。

registry 不是打包正确性的前置条件，只影响速度。`scripts/after-pack.js` 本就会把插件的安装结果还原进打包目录、在打包副本不全时按锁文件安装、并在结果仍不完整时抛错。现在这条兜底路径承担了离线场景：在够不到 registry 的机器上打包，会点名缺失依赖并失败，而不是发出一个装不起来的插件。

vendored 插件的**编译产物**那一半仍然提交。`rlhmarket/lib` 与 `rlhbot/lib` 是构建输出，这棵树里没有对应源码，`rlhbot` 更没有已发布的 tarball，任何安装都无法重新生成；`apps/desktop/.gitignore` 逐条点名放行。

`vendor/vendor-plugins.test.js` 为规则的两半把关。当 git 跟踪的 `vendor/` 下任一路径落在某个 `node_modules` 目录内、当已存在的安装与其锁文件不一致、当锁文件解析不出插件声明的某个依赖时，它都会失败——最后一条能在不真正执行安装的前提下，抓住一个会装出无法挂载插件的锁文件。工作副本尚未同步时，安装相关的检查会跳过，这正是只跑测试的全新克隆的常态。

## Alternatives considered

**继续提交安装结果。** 这是原先的做法，也是唯一在打包时完全不需要网络的选项。但打包本就需要联网安装——electron 与 electron-builder 自身也没有提交——所以这次提交换来的离线打包能力其实从未真正具备，代价却是每次触及这些文件的 diff 里都夹着无法评审的第三方内容。

**继续提交，但加一道锁文件一致性门禁。** 这堵上了漂移这个具体危害，打包行为也完全不变。但 vendored 文件仍留在评审里，而且改依赖仍有第二条路——直接改文件、再重录——门禁只能事后发现。

**只在打包目录里安装，去掉项目级安装。** `after-pack.js` 能独立完成全部工作，`vendor:sync` 对打包而言是冗余的。保留项目级安装，是为了让 `pnpm start` 挂载的插件与打包产物里的那一份一致，也为了不让复制路径——安装包真正走的那条——退化成只有够不到 registry 时才执行的死代码。

**把 vendored 插件改成 workspace 包。** 那样 pnpm 会像管理其他包一样管理它们的依赖。但这些插件的 `node_modules` 布局必须能被整体复制到任意安装目录后仍可用，而 pnpm workspace 的符号链接 store 做不到；况且 `rlhbot` 在这里没有源码可构建。

## Consequences

现在，改动 vendored 插件的依赖就是一份锁文件 diff。克隆仓库不再直接得到一个可用的市场插件，但需要它的路径都会自行安装；而且 `ensureRlhMarketPlugin` 本就会把缺失的安装报成 `missing-source:node_modules:<names>` 并让插件不挂载，而不是让 Harness 启动失败。

`vendor/plugins.json` 仍记录每次落地未携带的子树及其原因，`rlhbot/lib` 依旧列在其中：它早于忽略规则的修复，无法重新取回，侧边栏机器人与群聊房间套件会依据该记录持续跳过，直到它被恢复。
