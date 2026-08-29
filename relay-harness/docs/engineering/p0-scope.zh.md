# 当前工程基线与验收

[English](p0-scope.md) | 中文

## 状态

[ADR-0005](../adr/0005-adopt-ts-harness-runtime.md) 选择根目录 TypeScript monorepo 作为当前实现。本文件描述当前工程验收，不再规划 Rust workspace。

功能完成状态以 [`../feature-status.json`](../feature-status.json) 为权威。一个功能只有同时具备默认 composition、Remote/API、UI、e2e 和文档证据，才可标记为 `shipped`。

## 已交付基线

- agent loop、session 日志、恢复、checkpoint 与 subagent；
- CLI、Web、Desktop 共用 runtime 与 composition；
- `workspace-write + ask` 的普通用户安全默认值；
- Chat/Work/Library 产品壳与显式 Prompt Enhancement；
- 本地 Context Engine、Memory、Code Index；
- MCP tools/resources/prompts 与 skill inventory/import。

## 当前工程门

1. 根 `.github/workflows/` 是 GitHub 自动化的唯一入口，workflow 在根 monorepo 上运行。
2. `scripts/verify-feature-status.mjs` 校验功能声明和默认 composition 闭包。
3. 类型检查、定向测试、Web snapshot、`doc-sync` 与 release rehearsal 分别证明自己的边界；窄 PASS 不得表述成全仓 green。
4. 生成的 config、persistence、tool、Cordis 与 capability 目录必须随源码刷新。
5. 未实现的外部中转调度客户端和模型强度 UI 保持 `planned`，不得进入 shipped 文案。

## 下一验收目标

- 外部调度 HTTP/JSON + SSE 客户端与契约 fixture；
- 用户可见模型强度与计费说明；
- 根治理 commit 推送后的 GitHub workflow 远端发现与 required-check ruleset 验证。
