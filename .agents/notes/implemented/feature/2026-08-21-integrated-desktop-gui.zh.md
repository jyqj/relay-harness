# Agent Note：集成桌面 GUI

Status: implemented

[English](2026-08-21-integrated-desktop-gui.md) | 中文

## 问题

Electron GUI 原本位于独立的 MIT 许可仓库 [Deepseek-Harness-Desktop](https://github.com/ChisaAlter/Deepseek-Harness-Desktop)，并携带一份完整的 Harness fork。开发 Agent 及其 GUI 时必须编辑两个 checkout，并同步重复的 `vendor/deepseek-harness` 源码树。

## 决定

将私有 Electron 壳作为 `deepseek-harness-desktop` workspace 导入 `apps/desktop/`。以双方共同的 `141eb6fef83422698aef7a981029e843e8161534` 为基线，把桌面 Harness fork 合并到 monorepo 正常的 `packages/`、`apps/web/`、文档和 composition 路径。源码启动时，Harness 根目录解析为 monorepo 根目录；打包构建仍在 `resources/vendor/deepseek-harness` 下组装并归档独立运行时。

删除原有的嵌套 Harness 同步命令。`apps/desktop/vendor/` 只保留桌面端内置插件和上游导入 pin。桌面开发、测试和分发由根脚本统一管理：

```sh
pnpm run dev:desktop
pnpm run test:desktop
pnpm run dist:desktop
pnpm run dist:desktop:mac
```

## Alternatives considered

**继续分开维护桌面仓库和嵌套 Harness fork。** 不予采用，因为每次共享 UI、Runtime 或协议变化仍需编辑两处并执行同步步骤，而同步结果可能同时偏离两个 Source。

**只把打包后的 Harness artifact 复制进 Electron 应用。** 不予采用，因为 packaged output 不是计划中桌面二开的可维护源码边界，source-mode 开发仍会测试与分发不同的源码树。

**迁入 monorepo 时重写 Electron 壳。** 不予采用，因为现有壳已经拥有可工作的桌面、手机远程、插件和分发行为。集成只改变仓库 Owner，不替换独立应用行为。

## 结果

标题栏、Files、Git、Diff、surfaces、preview、终端、MCP 设置和 Skills 设置等桌面 UI 包成为普通 Harness workspace，其测试和类型声明参与 Harness 的统一构建。Electron 独有的 main/preload/renderer 代码保留在 `apps/desktop/`；手机远程和内置 `dshmarket`/`dshbot` 资源仍由该应用负责。

## 测试

`pnpm run test:desktop` 覆盖 Electron 壳。聚焦 Vitest 用例覆盖合并后的会话与调度器行为。Host 和 client TypeScript project 构建、client bundle 构建、Web 生产构建及 `smoke:source` 共同证明源码桌面端能够启动组装后的 Web UI、连接真实临时 Git workspace、打开标题栏菜单、操作右栏，并通过真实 PTY 完成回显往返。
