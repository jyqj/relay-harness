# Round 8 — 测试补齐 + 延期缺陷修复（2026-09-03）

6/6 切片落地（Wave1 并行 4 + Wave2 agent-loop + Wave3 SDK close 后续）。

- **R8-A WebApiClient.readWebSocket 补测**：新增 `web-api-client.client.spec.ts` 5 用例（畸形 JSON 存活、schema 无效帧丢弃、CONNECTING/OPEN 期 abort、open 前 close）。纯测试补齐。
- **R8-B 空 enter 搁置输入修复（R1 #12）**：agent.ts 空 enter 出口改 turnEnds+break 落到共享尾部（hasPending 重查/续转），2 行 diff；回归测试 failing-first 红→绿。`contract-regressions` 38/38、agent-loop+agent 全量 456/456。
- **R8-C CircuitBreaker half-open 记账修复（R1 #16）**：check() 时盖 admission state 戳，record() 按戳路由；closed 窗口样本数上限 drop-oldest；插件层 admission-stamp FIFO 接线（class-only 修复会被 plugin.spec 抓住的回归被测试网捕获并一并修复）。3 用例 failing-first。
- **R8-D 门禁补洞（R1 #10/#11）**：新建 `scripts/web-test-face.spec.ts` 断言三份手工清单一致——抓到真实漂移 `desktop-chrome.e2e.ts`（两个程序都不编译）并修 `tsconfig.host.json`；knip.json 补 41 个显式 per-package .tsx 键（fallback 通配会产生 931 hints 不可发布）。附带发现：knip 全仓模式只对 root workspace 报 unused files（planted 探针证实），属 knip 既有局限，记录待后续。
- **R8-E SDK close 后续**：缺陷 1（close 后同 id re-prompt 静默丢 durability）按 R7-F note 预留的 resume 路径修复——`createSession` 先 `agents.resume` 回落 `agents.create`，文档写明 resume-延续语义；快照 close-reprompt 探针红→绿。缺陷 2（pending close 无 turn/end）三层探测不成立，按回归覆盖交付（cancel.spec + close-pending 探针）。
- **R8-F 死品牌断言修复**：`built-boot.snapshot.ts` 断言更新为当前非 official profile 产物实际渲染的 RelayMark fallback（viewBox `0 0 40.6 28.2`）；记忆笔记方向错误已修正。

## 父轮统一验证

`pnpm run typecheck` exit 0（修复 R8-D 新门禁脚本一处 `noUncheckedIndexedAccess`）；`pnpm run build` exit 0；`web-test-face.spec.ts` 2/2 绿。
