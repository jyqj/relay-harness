# Agent Note：在 Pull Request 中要求原生内核与接近发行形态的桌面 smoke

Status: implemented

[English](2026-09-05-required-native-and-desktop-ci.md) | 中文

## 问题

Wine 和源码级测试不能证明原生 Windows 行为、真实 sandbox 约束或可执行桌面包。位于必需汇总之外的独立 job 可以失败而不阻止合并。新的桌面 runner 也不会仅因工作区 JavaScript 包和官方 Web／运行时产物已经构建，就拥有 Electron 可执行文件。

## 决策

[CI 汇总](../../../../../.github/workflows/ci.yml)在 Wine 之外要求原生 Windows，并调用可复用的 [sandbox](../../../../../.github/workflows/sandbox.yml) 和[桌面 smoke](../../../../../.github/workflows/desktop-smoke.yml)工作流。其 `always()` 判定明确拒绝失败、取消及跳过的依赖。被调用工作流使用不同的 concurrency 前缀，避免取消分组取消调用方。sandbox 证明步骤先传播测试进程退出状态，再检查摘要，并要求两个真实内核文件都运行；平台探针不可用不能算成功跳过。

桌面 smoke 在托管 macOS 和原生 Windows 上运行。它安装不可变工作区，显式运行锁定 Electron 包的安装器，构建官方运行时产物，执行源码应用，组装未打包分发目录，再执行其中的打包后可执行文件。普通工作区安装拒绝 Electron 自动下载二进制；桌面通道明确拥有这项开销。源码及打包后探针断言 UI 和 PTY 行为，并拒绝缺失结果文件或失败退出，而不只是检查产物存在。checkout token 不会持久保存，pnpm action 使用 runner 私有的临时安装位置。

## 考虑过的替代方案

- 让原生及打包 job 仅提供观察信息：即使受支持平台回归，其失败仍会让合并判定保持绿色。
- 把构建或未打包目录当作桌面证据：它不能证明 Electron、运行时入口、UI 启动和 PTY 能共同执行。
- 为每次工作区安装启用 Electron 下载：CLI 及纯运行时消费者会为不用的 GUI 二进制付出成本；显式桌面安装保留更窄的依赖策略。

## 影响

[工作流回归测试](../../../../scripts/ci-workflow.spec.ts)固定必需依赖、复用工作流路由、取消隔离、失败传播及先于 smoke／pack 的 Electron 安装。这些测试验证检入的配置；实际托管工作流结果仍是平台执行的权威证据。Pull Request 会消耗额外原生 runner 时间，并可能等待其容量。真实提供方测试仍单独需要密钥，这些无密钥 job 不会将其表示为已通过。
