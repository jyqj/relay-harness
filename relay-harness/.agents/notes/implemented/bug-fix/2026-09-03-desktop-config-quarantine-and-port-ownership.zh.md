# Agent Note: Desktop 配置隔离与端口击杀所有权

Status: implemented

[English](2026-09-03-desktop-config-quarantine-and-port-ownership.md) | 中文

## Problem

desktop 主进程有两处会销毁不属于自己所有权范围的用户数据。`apps/desktop/src/main/config.js` 的 `readJson` 对一切读取失败做同样处理：损坏的 `config.json` 或 `credentials.json` 会把受影响字段静默重置为默认值，而下一次 `saveConfig` 会把重新生成的文件覆盖到损坏的原件上，用户的原始字节不可恢复。另外，`ensureOwnedPort` 对目标端口（默认 3080）的 HTTP 200 探测做出反应，用 `taskkill /T /F`（Windows）或组信号（POSIX）击杀该端口上所有 `node`/`rlh` 镜像的监听进程，`_doStop` 还在每次 stop 时无条件重复这一清扫。用户无关的 node dev server 可能只因启动或停止桌面应用就连同整个进程树被杀。

## Decision

`readJson` 现在按错误分支：文件缺失（`ENOENT`）仍静默回退——这是正常的首次启动状态；其余任何失败会向 stderr 记录文件名与原因，把原件 best-effort 隔离为旁边的 `<file>.corrupt-<timestamp>`（rename 失败只记录日志、绝不阻塞启动），然后再回退。隔离是关键半边：没有它，仅回退仍会在下一次保存时丢失原始字节。

端口处理现在要求所有权证明。`ensureOwnedPort` 只杀 `rlhd-web.pid` 记录的 pid，且仅在 `isSafeToKill` 接受时；端口上的任何其他监听者一律走既有的跳端口路径。`httpReady` 探测分支、`listeningPids`/`killOwnedListeners` 清扫以及 `RlhManager` 的 `killOwnedListeners` 依赖全部删除。`spawnHarness` 在 POSIX 上传 `detached: true`，让子进程自 lead 进程组，`killTree` 的负 pid 信号才能覆盖整棵后代树；Windows 维持 `taskkill /T /F`。

## Alternatives considered

**保留清扫但收窄镜像名匹配。** 未采用，因为按镜像名匹配不是所有权证明：缺陷本质是击杀桌面应用无法归属的进程，任何宽到能命中"丢失 pid 文件的残留 rlh"的匹配器，也同样宽到能命中用户的 dev server。pid 文件已覆盖现实的崩溃残留场景。

**损坏文件直接自动删除而非隔离。** 未采用，因为删除正是本次修复要消除的损失。`.corrupt-<timestamp>` 旁文件在罕见路径上零成本，并保留现场证据。

**把击杀端口范围或镜像名单做成 Config 字段。** 未采用，因为该决策是移除自由裁量的击杀面而非调优它；所有权证明不需要随部署变化的参数。

## Consequences

损坏的 config 或 credentials 文件仍以默认值启动应用，但事件在 stderr 上响亮可见，原始字节保留供手动恢复；罕见损坏路径会在 `userData` 中留下 `.corrupt-<timestamp>` 文件。此前依赖桌面应用清走 3080 端口上杂散 node 进程的用户，现在看到的是跳端口——那种依赖本身就是缺陷。停止桌面应用不再触碰外来监听者。由于 POSIX 上子进程现在自 lead 进程组，组击杀覆盖全部后代进程，子进程也不再接收发给桌面进程组的信号（Electron GUI 主进程没有控制终端，子进程生命周期仍由显式 `kill`/`killTree` 管理）。测试注入 `ensureOwnedPort` 的进程 seam（`probePort`、`readPidFile`、`processAlive`、`killTree`、`findFreePort`、`clearPidFile`），并通过 `process.kill(-pid, 0)` 钉住进程组契约，而非已被移除的清扫。
