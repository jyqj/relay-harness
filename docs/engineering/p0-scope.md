# 当前工程基线与验收

## 状态

早期 Rust P0 蓝图已被 [ADR-0005](../adr/0005-adopt-ts-harness-runtime.md) 取代。当前实现是 [`relay-harness/`](../../relay-harness/README.md) TypeScript monorepo；本文件只描述当前工程门，不再规划 Rust workspace。

功能完成状态以 [`../feature-status.json`](../feature-status.json) 为权威。一个功能只有同时具备默认 composition、Remote/API、UI、E2E 和文档证据，才可标记为 `shipped`。

## 已交付基线

- Agent Loop、Session 日志、恢复、checkpoint 与 Subagent；
- CLI、Web、Desktop 共用 runtime 与 composition；
- workspace-write + ask 的普通用户安全默认值；
- Chat / Work / Library 产品壳与显式 Prompt Enhancement；
- 本地 Context Engine、Memory、Code Index；
- MCP tools/resources/prompts 与 Skills inventory/import。

## 当前工程门

1. 仓库根 `.github/workflows/` 是 GitHub 自动化的唯一入口，workflow 显式在 `relay-harness/` 执行。
2. `scripts/verify-feature-status.mjs` 校验功能声明和默认 composition 闭包。
3. `relay-harness` 的 `typecheck`、定向测试、Web snapshots、`doc-sync` 与 release rehearsal 分别证明自己的边界；窄 PASS 不得表述成全仓 green。
4. 生成的 config、persistence、tool、Cordis 与 capability 目录必须随源码刷新。
5. 未实现的外部中转调度客户端和模型强度 UI 保持 `planned`，不得进入 shipped 文案。

## 下一验收目标

- 外部调度 HTTP/JSON + SSE 客户端与契约夹具；
- 用户可见模型强度和计费说明；
- 在干净迁移窗口评估是否把 `relay-harness/` 物理 flatten 到仓库根。
