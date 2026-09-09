# Round 7 — 串联优化实施（2026-09-03）

依据 `round-6-wiring-audit.json` 的 8 切片，按依赖序 4 阶段执行（R7-A → 5 并行 → R7-C → R7-H）。

## 落地

- **R7-A（回归调查）**：wire 捕获证明 `details-session-lifecycle` e2e 失败与 R5-B 串行化无关——失败点击零 RPC，串行槽只见一次初始准入；「4/4 确定性红」实为陈旧构建产物（`tsc -b` 跳过最后一次保存）。未改 src（收窄方案会翻转已钉住的 TOCTOU 行为）。产出：判别性 pin 测试（变异验证红/绿）+ 误归因 Agent Note。残留：客户端侧 ~15-20% flake，根因在 client switch 流（后续 slice，诊断方法已写入 note）。
- **R7-B 重连基线缝**：`session/subscribed` 分支补尾检查，激活 repairGap 补拉（failing-first 3 用例）；修正 3 处方向相反的注释。120 tests passed。
- **R7-C session.prompt 缝**：删除死的 command 槽/command-error/unknown-command 错误码（schema 反转断言红→绿）；'/' 逐字入模明文化；接通 carrier signal 的提交点前取消 + per-session rpcId 幂等去重（32 槽窗口）。apiproxy 全量 22 files / 404 passed；Python 85 passed。
- **R7-D 发送管线自洽**：SubmitAttempt 在 enter 时刻同时快照 draft + occurrence 表，sinkSerialized 读 attempt 携带的表。
- **R7-E SDK closeSession 顺序**：record 存活至 dispose 完成，pipelined prompt 链在 dispose 后建 fresh session；并发 close 双 settle。
- **R7-F SDK close 真实 wire 覆盖**：TS snapshot + Python smoke 新增 close-auto/close-named/close-mid-turn 三场景；两套快照钉住 finishReason/finish_reason；重录 fixtures。vitest.snapshot 7 passed、uv smoke 通过、pytest 85 passed。
- **R7-G Python close-vs-start 竞态**：`_starting` 标志 + Condition，close 等 in-flight spawn 落定后取消或收割，不再孤儿化子进程。两个确定性红测试。pytest 85 passed。
- **R7-H 投影帧卫生**：`sessionListMetadata`（与 imageLimits 声明性）改 baseline-only，停止零消费帧广播；failing-first 红→绿。

## 父轮统一验证

`pnpm run typecheck` exit 0；`pnpm run build` exit 0。

## 遗留（移交 R8/R10）

1. R7-F 发现的两个真实缺陷（探针就绪）：close 后同 id re-prompt 触发持久化 id-collision（静默丢 durability）；pending 模型请求期 close 无 turn/end 事件。
2. R1 #12 空 enter 搁置输入、#16 CircuitBreaker half-open 记账（R5 延期项）。
3. details-session-lifecycle 客户端侧 flake。
4. golden 重录决策（~106 预存漂移，属用户可见契约，留 R10 汇报）+ `built-boot.snapshot.ts` viewBox 死断言。
