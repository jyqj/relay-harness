# Agent Note：跨 Session Memory 治理与结果排序

状态：已实现

[English](2026-08-29-memory-outcome-conflict-and-cross-session-governance.md) | 中文

## 问题

第一版 Memory Center 把 why-used 限定在一个已连接 Session，不暴露 canonical signal 或 outcome，并且只比较显式 supersession 链。SQLite 的 legacy accounting 仍把每个 retrieval hit 称为“useful”，但没有结果 Evidence 支持该解释。历史 message feedback 与 Work completion 无法影响 recall ranking。

## 决策

Memory Center 现在以有界并发扫描同工作区完整 live-preferred Session Query corpus。`readSession()` 会验证 persisted history，但不会创建或 resume Agent。只有已准入 `context/prepared` contribution 才计入 why-used，coverage 会以 complete、partial 或 unavailable 报告扫描／失败数量。

canonical seam 会暴露 signal history、确定性 conflict lookup、按 Session 原子 outcome reconciliation 和 outcome read。SQLite version 4 持久化 outcome observation，并且只用 positive/negative impact 形成有界 ±0.1 search adjustment。Turn completion/failure、injection、candidate hit 与 blocked Work 保持 neutral 或 legacy accounting；它们绝不会只因发生 retrieval 就提升 ranking。Governance revision 会原子追加与精确 durable governance event 绑定的 `user_confirmed` 或 `user_rejected` signal。

Candidate review 总是先运行 canonical kind 加 normalized-content/summary 检测。optional `memoryConflictDetector` seam 可以增加带 provider attribution 的 `semantic-conflict` candidate；Memory Center 会验证 Scope 与 attribution，并展示 reason/score/detector，而不是把推断矛盾断言为事实。

`memory-outcome-reconciler` 会执行后台 persisted scan，并响应相关 live Session event 与 Host-local `message-feedback/changed`。它替换每个 Session 的 derived outcome set，因此 rating 变更／删除会撤回旧 observation。Feedback 读取失败会中止替换并保留上一份 durable set；全量扫描失败则清除 memoized attempt，允许后续检查重试。显式正／负 Assistant rating 影响 ranking；durable Goal completion 为 positive；普通 turn 与 Goal block 为 neutral。Memory Center 投影 signal、跨 Session usage、conflict candidate、outcome history 和精确 ranking adjustment。

## 考虑过的替代方案

- **每次 recall 都增加 usefulness**——否决，因为准入与成功完成不证明 relevance。
- **从自由文本 `/feedback` 推断 sentiment**——否决，因为确定性治理不能猜测 polarity。
- **为了检查历史而 resume Session**——否决，因为管理读取不得获取 Agent ownership 或产生 effect。
- **发现 semantic candidate 后阻止批准**——否决，因为 optional detector 提供 review Evidence，而不是凌驾用户决定的 authority。

## 结果

此前显式 Memory 产品缺口已经闭合，且没有虚构 retention 或 causal certainty。跨 Session 聚合要么完整，要么明确标为 partial；review signal 进入 canonical；feedback 删除可以撤回；ranking 只使用显式 outcome impact。部署可以增加更丰富的 conflict detector，而发行的确定性路径保持本地且可复现。
