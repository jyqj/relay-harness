# Agent Note：原生受治理长期记忆

Status: implemented

[English](2026-08-21-native-long-term-memory.md) | 中文

## 问题

Harness 已持久化精确模型历史、compaction 替换和可搜索 Session event，但没有第一方长期记忆决策记录。第三方 MCP 工具可以存储数据，然而 Agent loop 没有定义何时召回、如何重建面向模型的召回、失败轮次如何结算 Provider 工作，以及哪些 Session event 足以支撑 active 记忆。

把 Session 搜索当成记忆会让原始历史冒充当前事实库。把原始轮次复制到另一个数据库会形成两个相互竞争的 transcript 事实源。自动信任模型摘要会让一次推断或不受信任工具结果成为持久的跨会话输入。

## 决策

长期记忆是 `packages/memory` 下的能力 seam：`@deepseek-ai/dsh-memory` 定义 `ctx.longTermMemory` 与 `ctx.memoryExtractionQueue`；`memory-sqlite` 提供规范版本、检索与提取 job；`memory-agent` 在 Agent 轮次消费召回；`memory-extractor-llm` 捕获并提取已完成轮次；`tool-memory` 暴露受治理的模型操作。标准 preset 挂载召回和工具，base bundle 在 `$DSH_HOME/memory/memory.db` 拥有一个规范 Provider，并只对 standard 会话显式开启提取。

SessionEvent 仍是对话证据源。每个记忆版本引用一个 Session id 和更早的 event seq；规范记忆 journal 记录从这些证据作出的决策。当前行和 FTS 是物化视图。Tombstone 会取消召回资格，但不会删除早期版本或证据。

每个操作都绑定工作区、用户和稳定 Agent Scope。Session id 标识证据与 prepared turn，不决定长期可见性。标准 preset 使用会话 cwd、本地操作系统用户和 `deepseek-harness` Agent id，因此匹配会话共享记忆，不同工作区或用户相互隔离。

Kind 为 preference、fact、constraint、decision、procedure 和 lesson。实时任务状态留在记忆之外。状态为 candidate、active、disputed、superseded 或 tombstoned。Active 状态要求用户陈述或成功工具结果证据；Agent proposal 和外部观察无法在 Provider 操作中成为 active。Provider secret 扫描适用于所有 Consumer。

Agent Consumer 只在第一个 step 为直接用户文本准备召回。它把 active 候选装入受字符上限约束、具有独立来源的 `user/message`；固定警示把 JSON 标为不受信任、可能过期的证据。Agent loop 在派生请求前记录该消息，保持模型可见与日志等价。Session Query 从语义文档排除所有 recall-form 消息，阻止派生召回递归变成 episodic 证据。

Prepared turn 在最终 `turn/end` 结算。Completed 和 max-token 轮次提交真正进入模型的精确 memory id；其他结果全部 abort。Provider 失败对 Host 轮次采用 fail-open。Dispose 会等待活跃 Provider 调用，并终止剩余 prepared handle。

模型写入不只依赖提示词纪律。只有当精确引文能在直接用户消息或成功工具结果中找到时，`memory_remember` 和更改内容的 `memory_update` 才会激活；否则创建 candidate。`memory_forget` 要求精确的直接用户删除引文。Provider 会重复执行 status、trust、evidence、Scope 与 secret 强制检查。

自动提取同样留在 Agent loop 之外。Completed 与 max-token 轮次只投影直接用户消息和成功工具结果；派生 recall/plugin 消息、reasoning、失败、memory/session/skill 输出、默认的 subagent 以及含 secret 的来源会被排除。有界 snapshot 进入按 Scope、session、turn 与 source hash 幂等的 SQLite job。持久 attempts、过期 lease、retry schedule、最终 lease 结算与 terminal result hash 让中断和重启成为显式状态。

辅助 LLM 只返回提案，不产生权威写入。严格 JSON 解析与精确引文 grounding 只允许 user-stated 或 action-verified active memory；active 内容是持久引文而非模型改写。External 与无法 grounding 的提案保持 candidate。按规范化 kind/content 精确去重，使部分完成的 job 可安全重试，并晋升已有匹配 candidate 而不是分叉 identity。

## 考虑过的替代方案

**把一个第三方 Memory MCP 作为默认实现。** 拒绝：MCP 提供工具与传输，不提供 Host 轮次生命周期、持久召回来源或 Provider 无关治理。

**采用 ALTM 完整 L0-L4、Graph、Persona 与自治治理栈。** 默认实现拒绝：它的 prepare/commit/abort、Scope、证据、生命周期信号与排名融合值得吸收，但在第一方 seam 出现前强制 Python 服务、Graph 和 Persona pipeline 会增加独立事实和部署复杂度。

**采用 dsh-meow 的七张表与首消息前缀。** 核心契约拒绝：它的实际 Hook 与 transcript 披露启发了 Consumer，但固定表、sidecar seen 状态、首轮全量注入和模型直接修改不提供追加式证据治理。

**只在请求局部状态保存召回。** 拒绝：回放无法重建模型所见内容，违反 Session 日志不变式。

## 验证

Provider 测试覆盖追加式版本、Unicode／trigram 检索、Scope 隔离、active／candidate 资格、精确去重与晋升、prepare/commit/abort 幂等、tombstone、schema migration、提取 job 的 lease/retry/terminal 状态、持久化重开、证据校验与 secret 拒绝。工具测试通过真实 Tool Runtime 与 Provider 验证受支持激活、candidate fallback、搜索／读取、删除权限和 HMR dispose。Agent 测试覆盖 fail-open prepare、subagent 策略、最终结算与卸载 abort。Extractor 测试覆盖来源排除、伪造引文、external observation、精确成功工具激活、畸形输出重试、中断、最终 lease 过期、Provider 故障与重启恢复。

实际 Agent loop 测试证明同一条 recall 消息同时进入 Adapter 请求和 Session 日志，并由最终轮次结算更新访问计数。重启测试从一个已完成 Agent 会话提取，再由全新会话召回。随附 Web 组合测试启动真实 base bundle 与 standard／minimal preset，把规范数据库固定到临时路径，验证 standard 自动提取和跨会话召回，同时 minimal 保持无记忆能力。

## 后果

Harness 在不修改 Agent loop 的情况下获得一个可替换长期记忆 seam。本地使用不要求外部服务或 embedding。召回数据的信任明确低于当前用户意图和已验证工具输出，每次 active 写入都有可检查的持久证据。

当前实现使用词法 FTS、显式模型工具与持久的证据约束自动提取。精确 tokenizer 预算、语义 embedding Provider、用户审核 UI、导入／导出和 cited-use 反馈仍是独立 Consumer 或 Provider，可以扩展该 seam，而无需改变 Session 历史或已有记忆版本。
