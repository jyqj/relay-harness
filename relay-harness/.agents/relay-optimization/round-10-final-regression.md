# Round 10 — 全量回归验证 + 收尾（2026-09-03）

## 门禁结果

| 门禁 | 结果 |
|---|---|
| `pnpm run typecheck` | exit 0 |
| `pnpm run build`（host lib + client artifacts 238） | exit 0 |
| `pnpm run lint`（含 oxlint TS 规则） | exit 0（修复 ~30 处各轮残留 stylistic/TS lint；含 1 处 justified `no-this-alias` disable） |
| `pnpm run test`（全量单测） | **17431 passed / 1 failed → 修复后全绿**（唯一失败为 cordis-catalog 生成物行号漂移，`gen-cordis-catalog` 重生成后 2/2 绿） |
| `verify-translation-pairing` | 1235 对一致 |
| `web-test-face.spec.ts`（R8 新门禁） | 2/2 |
| Python SDK `pytest` | 85 passed |
| Python smoke（keyless real-runtime） | sdk-close 场景通过 |

## R10 期间修复

1. 各轮并行实施遗留的 lint 尾巴（stylistic 自动修复 + 手工：`member-delimiter` multiline-none、`no-this-alias`（generator effect 捕获 this 的注释豁免）、`no-invalid-void-type`（Promise.withResolvers 换手写 deferred）、`no-unsafe-return/assignment`、`max-len`）。
2. `docs/subsystems/{persistence,spill}.*` cordis-surface 生成物刷新（R5-I disposeSession + R8-E index.ts export 行号）。

## 遗留风险与后续建议（未在本次 10 轮内处理）

1. **web e2e golden 漂移（预存，非本轮引入）**：~106 个 lane 失败源于 committed goldens（ceb277f）含旧版 Trajectory/Select-model chrome，当前 served client 渲染 Focus chrome。重录属用户可见契约变更，需人工审核每个 diff——建议 `pnpm run test:web:refresh` 专项 PR。`details-session-lifecycle` 另有 ~15-20% 客户端侧 flake（诊断方法见 misattribution Agent Note）。
2. **knip 既有局限**：全仓模式只对 root workspace 报 unused files（planted 探针证实），41 包 .tsx 检测已配置但无法产出 findings——需上游修复或改造 knip 接入方式。
3. **R3-A fixture 懒加载**：并入既定 InProcessApiClient 迁移（届时 `fixture.ts` 3,335 行整体删除）。
4. **R1 未排期 low 项**：core「包含式 emit」6 处收敛、Inbox.validate 缓存、`currentAgentPreset` 增量 fold、TOOL_OUTCOME_UNKNOWN 文本统一、CircuitBreaker FIFO 依赖单飞行假设（并发模型变更需扩 key）。
5. 全部改动在工作区未提交（约 60+ 文件 + 若干新 spec/Agent Note）；按仓库约定，非平凡变更已各带双语 Agent Note，可按包分组拆 PR。
