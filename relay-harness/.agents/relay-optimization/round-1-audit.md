# Round 1 — 整体遍历分片审计（2026-09-03）

Multiagent 审计：11 个分片（core-runtime / host / session-storage / client-web-core / client-ui-conversation / client-ui-settings-family / apps / sdk-api-python / infra-tools / build-tests-config / lyra-alignment）+ 1 个汇总。基线：`pnpm run typecheck` 通过（exit 0）。

- 完整结构化结果：`round-1-audit.json`（104 findings + TOP-25 backlog，按 R3/R5/R7/R8/R9 轮次映射）
- 三大主题：
  1. **无界保留/生命周期泄漏**：host FrameQueue（SSE 订阅者无上限）、SDK runtime 每次 `run()` 泄漏一个 agent、jobs-local 终态记录永不驱逐、客户端 session 事件窗口、desktop relay pending 表。
  2. **契约重复/执法不对称**：`window.shell` bridge 手工声明 11 次、TS/Python SDK "design twins" 漂移、agent-preset 写入绕过 settings revision fencing、core「包含式 emit」复制 6 份。
  3. **热路径 O(n) 重扫与门禁漏洞**：SQLite session-query 每次搜索全量重指纹、memory-center 全语料扫描、`currentAgentPreset` 每步回扫日志；knip 漏 .tsx、apps/web 测试清单手工维护漏网。

TOP-25 中分配：R3×4、R5×12、R7×4、R8×6、R9×2（多项跨轮）。
