# Relay Harness 历史优化记录 — 10 轮 Multiagent（2026-09-03）

[English](README.md) | 中文

本目录记录在 `feat/relay-focus-frontend` 工作区上执行的 10 轮 multiagent 优化（每轮 workflow 编排，总计 78 个 subagent）。轮次报告在本目录，完整结构化审计数据在对应 `.json`。以下测试结论只描述该历史轮次，不代表当前工作树或当前 CI 状态。

| 轮 | 主题 | 产出 |
|---|---|---|
| R1 | 整体遍历分片审计 | 11 分片 / 104 findings / TOP-25 backlog（`round-1-audit.{md,json}`） |
| R2 | 前端 × Lyra 深度审计 | Lyra 模式库 + R3 六切片计划（`round-2-frontend-audit.json`） |
| R3 | 前端优化实施 | locale 收敛 / 输入壳生命周期 / projectList 身份守卫 / ChatView 渲染窗口 / motion 单词汇表（R3-A 有证据放弃） |
| R4 | 后端对抗审计 | 15 verdicts（1 refuted）+ 3 维深挖 + R5 十切片计划 |
| R5 | 后端优化实施 | hooks 循环护栏 / FrameQueue 有界 / SDK 会话回收（TS+Python）/ jobs 保留 / SQLite 束 / 锁自愈 / persistence teardown / spill 降级 / desktop 配置隔离+端口所有权 |
| R6 | 串联审计 | 12 findings，含 R5-B 回归证实与误归因纠正 |
| R7 | 串联实施 | 重连补拉激活 / session.prompt 缝对齐（死契约删除+取消+幂等）/ 发送管线自洽 / SDK closeSession 顺序 / close wire 覆盖 / Python 竞态 / 投影帧卫生 |
| R8 | 测试补齐+缺陷修复 | readWebSocket 补测 / 空 enter 修复 / CircuitBreaker 记账 / 三清单一致性门禁 / knip .tsx / SDK re-prompt resume / 品牌死断言 |
| R9 | 文档群补齐 | 1235 双语对一致 / packages/client README 59/59 / R1 doc-gap 清零 |
| R10 | 全量回归 | 该轮报告 typecheck/lint/build/test 全绿（17431 tests） |

约束遵守：全程未提交（遵守"不擅自创建提交"）；不可动层（conversation-nodes 折叠、input machine 语义、slot registry 结构、wire 契约、aria 语义）零触碰——R3-A/R7-A/R8-E 三处计划的越界或前提错误均被实施 agent 以证据拒绝并记录 Agent Note。
