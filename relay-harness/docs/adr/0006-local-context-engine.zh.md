# ADR-0006：本地 Context Engine（索引与检索永不上云）

[English](0006-local-context-engine.md) | 中文

- **状态**：已接受
- **日期**：2026-08-26

## Context

Relay 需要跨代码、会话、记忆、附件等多来源的深度上下文能力。参考对象 Auggie（ACE）采用云端拓扑：本地只做文件清点与哈希，索引、嵌入与重排全部在云端完成，本地仅保留 checkpoint 指针。该模式与 Relay 的既有原则冲突：ADR-0004 规定本地状态与最小权限，根仓 README 规定模型路由外置、文件是显式上下文而非隐式全盘扫描。

仓库已经具备本地领域能力：session-query（含防递归索引）、memory（含 revision 与 trust 治理）、LSP seam，以及提供确定性离线词法与图检索的本地代码索引。缺的不是领域引擎，而是连接这些引擎的控制面与共享 Evidence 协议。

## Decision

1. Relay 建设本地 Context Engine：Source 注册、检索编排、证据准入、打包与追踪全部在本机完成；云端只承担模型推理本身（遵循 ADR-0002 的外部路由）。
2. **Source 内容永不为索引、检索或排序目的离开本机**。离开本机的只有发往模型服务的请求内容，且用户可见。
3. 索引是可删除重建的派生缓存，永远不是事实源；事实源是本地文件、Session 日志、Memory revision 等本身。
4. 检索结果必须先成为绑定 revision 的 Evidence，再进入模型请求；裸搜索命中不得直接拼入 prompt。
5. 检索失败、索引降级或读取错误不得静默呈现为"无结果"。
6. 系统注入的上下文（recall / context 注入）不得被再次索引为新证据，防止派生内容递归污染索引。
7. 不同领域 Provider 的原始分数不做跨域直接比较；全局选择使用 provider-local rank 加校准策略。
8. 检索轨迹由 Runtime 记录，Agent 不得自证覆盖范围；否定结论必须附带 Coverage 记录。
9. Prompt 渲染发生在上下文打包之后；Source 内容不具指令权威。
10. 第一代不引入任何嵌入/向量依赖；语义检索 lane 是否增补，由本地评测结果触发 [待决策]，且模型与向量存储必须留在本机。

## 备选方案

- **云端索引（ACE 拓扑）**：检索质量可借云端算力，但违反 ADR-0004 本地边界，索引数据出机不可接受。否决。
- **在 `packages/context/` 上继续堆插件**：现有插件是请求前文本注入 seam，无 Source/Revision/Evidence 概念，堆叠无法长出控制面。否决。
- **只暴露 CodeCortex 搜索的薄 provider**：会抹平 graph、impact、test 与降级能力。否决；code-native capability 保持完整，并位于 transport-neutral 适配器之后。

## Consequences

- 隐私成为一等产品能力："索引起作用，但你的文件从未为索引离开电脑"。
- 排序质量依赖本地确定性信号（词法、图、结构、显式引用），没有云端 reranker 兜底；本地评测必须持续验收召回。
- 本地索引的资源治理（文件数上限、watcher 与 Agent 的 CPU 竞争、磁盘占用可见性）成为 Relay 的产品责任。
- `packages/context/` 现有插件中，运行时事实类（时间、tmux 等）保持原位；任务级检索与打包迁入新的 context-engine 控制面（见 [`../agent/context-engine.md`](../agent/context-engine.md)）。

## 澄清

**关于第 6 条——compaction checkpoint 的语料边界。** Recall 消息（`form: 'recall'`）的三道直接防线（session-query 语料抽取、memory 抽取、session-reference 投影）均已实证有效。遗留的间接通道是：recall 消息被 compaction 折叠后，checkpoint 摘要（`kind: 'plugin'`，无 recall 标记）可能复述其中的路径与片段，并随 checkpoint 进入 session-query 语料。裁定：**这不构成第 6 条违反**。checkpoint 摘要是整个对话区间（含 assistant 回复）的聚合派生物，与 assistant 回复在证据级别上同级——二者都会复述会话中出现过的事实；第 6 条所禁止的是"注入上下文被原样再索引为独立证据"的自放大回路，该回路的三个直接入口已被阻断。且 recall 内容源自用户本机代码索引（高信任源），聚合进会话叙事后不产生超越会话本身的信念。此边界判定已记录于 [`../subsystems/code-index.md`](../subsystems/code-index.md) 的 Known Limitations；若未来引入对 checkpoint 摘要的语料加权或跨会话提升机制，须重新开启本条裁决。

**关于第 10 条——语义 lane 的落地状态。** 第 10 条"第一代不引入任何嵌入/向量依赖"在第一、二期（词法/图检索、AST 符号图）中得到遵守。第三期已落地语义向量层，触发方式为本计划裁决时的设计审阅批准（而非本条预期的"本地评测结果"）——补记该偏差，评测验收（参照 `cc-eval` 模式）仍为后续义务。第 10 条"向量存储必须留在本机"得到遵守（int8 量化列存储于本机 SQLite 派生库）；"模型留在本机"按第 2 条的既有允许修订为：**embedding 模型经由 ADR-0002 的用户路由（中转调度侧）调用，chunk 文本作为模型服务请求内容出机**——与对话推理的出机边界同型，不新增出机类别；本地无 embedding 模型依赖，未配置路由端点时语义 lane 整体缺席、词法/图检索能力不受影响。
