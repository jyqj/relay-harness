# Round 3 — 前端优化实施（2026-09-03）

依据 `round-2-frontend-audit.json` 的 6 切片计划，6 个实施 agent 并行落地。

## 已落地（5/6）

- **R3-B locale 收敛**：`ChatView` 的 "Deep diving..."、`ToolRow` 的 "Inspect"、`ContextInspectorAction` 的 badge/tracePrepared/truncated 全部收进 locale 字典（zh/en），aria `role="status"` 节点结构不变；3 个 spec 同步更新（103 tests passed）。
- **R3-C 输入壳生命周期**：image-only 直发的 AbortController 归 shell 持有、dispose 时 abort（附带：dispose 后 shell 不再发起新直发）；`ComposerBlocks.forget` 接入 InputHub scope teardown，per-session block store 不再全 app 泄漏。machine.ts / apply.ts 零触碰。新增 3 个用例（15 passed）。
- **R3-D projectList 身份守卫**（Lyra identity-guarded writes 采纳）：无变化帧复用快照引用、短路 store 通知；单行变化只换该行对象。掐断跨会话重渲染风暴。新增 3 用例；`packages/client/runtime/tests` 全量 24 files / 365 tests passed。
- **R3-E ChatView 渲染窗口**（Lyra visible-run window 采纳）：tail-window（WINDOW_STEP=80）+「显示更早 N 行」扩窗 + sessionId 切换重置 + loadOlder 联动扩窗；纯 head-prepend，不触碰锚点/follow/seat 订阅/折叠。新增 5 用例；ui-conversation 全量 36 files / 515 tests passed。
- **R3-F motion 词汇表收敛**：退役旧 `--rl-transition-duration-*`/`--rl-ease-in-out`/`--rl-motion-duration-*`，收敛到 `--rlw-motion-*` + `--rlw-ease-standard` 单词汇表；reduced-motion 降级集中到 motion.css 并为 4 处无降级消费点补局部 guard；修正畸形 accent token 名；`docs/web-styling.md`(+zh) Motion 段改写。新增负向断言防回潮。30 files / 561 CSS 契约测试 passed。

## 放弃（1/6，证据充分）

- **R3-A fixture 懒加载**：探针实测 tsdown 动态 import 产出的相对 chunk require 在 module-table 单文件 CJS 工厂通道（`makeRequire`/`serveBundle`）不可达——vitest 全绿但真实 served 应用 `?fixture` 装配即抛。三条可行路径均需扩切片边界；推荐并入 README 既定的 InProcessApiClient 迁移（届时 fixture.ts 整体删除）。零改动落地。

## 验证

- `pnpm run build` exit 0（统一执行；修复了 2 个新 spec 的 strict TS 错误：`noUncheckedIndexedAccess` 非空断言、`mockImplementation` 签名 cast）。
- 修复后复跑受影响 spec：2 files / 18 tests passed。
