# Agent Note：受治理 Memory Center 产品闭环

状态：已实现

[English](2026-08-29-governed-memory-center.md) | 中文

## 问题

长期 Memory 已有 append-only 治理 provider 和共享 Context contributor，但用户无法检查 candidate、批准或拒绝 extraction、修订 active fact、查看 Evidence 或 expiry、移除记忆、比较 supersession，也无法理解某条记忆为何进入模型请求。Recall 在产品中只是隐藏的模型上下文。

## 决策

provider-neutral Memory seam 新增了 canonical current-entry view 上的分页 `list` read。它不同于 recall search，可以返回所有治理状态与已过期条目，且不增加 retrieval accounting。SQLite 在 `memory_entries` 上实现该读取，同时保留 append-only `memory_revisions` 权威。

Web Host 挂载 `memoryCenter`；每次 list/search/read 都要求已连接 Session，并先用其权威 cwd-or-global Scope 校验 Client workspace，再绑定配置的 user/agent identity。治理 mutation 还携带页面展示的 revision，追加 `memory/governance-requested`，要求 Session durability barrier 参与，并在 Provider 写入前重新检查 revision，再把同一个 compare-and-set guard 传入 Provider。Approve 只把 candidate/disputed memory 提升为 active user-stated fact；reject/delete 追加 tombstone；revise 保留既有 Evidence，并追加用户的精确治理事实。详情读取暴露来源 Evidence、`validUntil` freshness、显式 supersession 链，以及仅在已准入 `context/prepared` contribution 携带该 Memory Evidence 时成立的 why-used occurrence；每次 occurrence 会标识 current、historical 或 unknown revision。

Web Settings Memory Center 新增 exact-scope list/detail cache、status/search filter、分页、Evidence 与 why-used 视图、candidate 审核、revision 和必须填写原因的 tombstone。connection reset 与每次 mutation 都会推进 cache generation，因此更早的在途读取不能重新写入失效状态。没有虚构 retention/deletion policy：过期 row 仍可见，delete 始终是 可审计 tombstone。

## 考虑过的替代方案

- **把 recall FTS 当作管理列表**——否决，因为 FTS 有意排除 tombstoned/superseded 与过期 row， 并且默认增加 useful-access accounting。
- **允许浏览器为 mutation 发送任意 user/agent/workspace Scope**——否决，因为已连接 Session header 才是权威 workspace，同时能提供 durable 用户 Evidence。
- **把 candidate 批准当作静默 status update**——否决，因为 active `user-stated` trust 必须有 可检查的用户动作。
- **推断语义冲突**——否决，因为 provider 当前只拥有显式 supersession 事实；UI 不应虚构矛盾 确定性。

## 结果

Memory 现在完成默认 Contract → Provider → Composition → Remote → Client cache → UI 纵切面。用户 可以治理所有 canonical state，并检查 provenance/freshness。why-used 保持真实，但限定在所选已连接 Session。后续[跨 Session outcome 与 conflict Note](2026-08-29-memory-outcome-conflict-and-cross-session-governance.md)已经闭合跨 Session 聚合、canonical review signal、确定性／optional conflict detection 与显式 outcome-backed ranking。
