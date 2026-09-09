# Round 6 — 业务逻辑串联审计（2026-09-03）

4 个跨层维度审计（wire-events / input-send-path / sdk-loop-parity / snapshot-e2e），12 findings + R7 计划（8 切片）。完整数据：`round-6-wiring-audit.json`。

## 关键发现

1. **R5-B 回归（high，已被 e2e 证实）**：per-session 串行化链导致 served web app 点击 runtime-seeded 会话后种子行消失、会话不挂载——`details-session-lifecycle.e2e` 4/4 fail。经 HEAD 基线 worktree 对照 + apiproxy 单 hunk 二分确认：罪魁是 R5-B apiproxy 串行化（非 R3、非 mux buffer）。→ R7-A。
2. **重连基线缝死代码（high）**：`resync()` 先置 `subscribedLastSeq=null`，订阅帧 gap 补拉分支在重连路径永不触发；R5-B FrameQueue 强制断流窗口内丢失的尾部事件无守卫。两条注释方向还写反了。→ R7-B。
3. **session.prompt 契约 vs 实现相悖（high）**：Service Definition 承诺 host 侧 slash 分发（command 槽/2 个错误码）但实现完全没有；客户端 30s 强截止 + abort 而 handler 丢弃 carrier signal（R5-B 串行槽拉长 admission）。→ R7-C。
4. **发送管线拼接错位（medium）**：sinkSerialized 用 live occurrence 表拼接 attempt 冻结的 draftSnapshot。→ R7-D。
5. **SDK closeSession 顺序**：先 delete 再 dispose，pipelined prompt 命中 'unknown session'/'already registered'。→ R7-E。
6. **session/close 零 wire 覆盖 + 两套 SDK 快照都不记录 finishReason**。→ R7-F。
7. **Python close-vs-start 竞态孤儿化 runtime 子进程**（TS 无此窗口）。→ R7-G。
8. **投影帧卫生（low）**：`sessionListMetadata` 每次变更广播给全部订阅者但客户端零消费。→ R7-H。
9. **快照基线修正**：pre-existing golden 漂移方向与 memory 记录相反——committed goldens（ceb277f）含 Trajectory/Select-model 旧 chrome，是当前 served client 渲染 Focus chrome；`built-boot.snapshot.ts:45` 断言的 brand SVG viewBox 已不存在于 HEAD 源码。→ R8/R9 处理（重录 golden + 修 memory）。

## 干净面（已证）

帧词汇/字段两侧一致；R3-D 身份守卫逐字段核对无丢失；FrameQueue END → WS close → 全量 re-baseline 主链路成立；`composer-draft-scroll`/`approval-composer` e2e 通过（R3-C 快照安全）；`frame-queue.spec`/`api-proxy-mux.spec` 6/6 绿。
