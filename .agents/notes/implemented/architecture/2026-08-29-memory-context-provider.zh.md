# Agent Note：Memory 作为共享 Context Provider

状态：已实现

[English](2026-08-29-memory-context-provider.md) | 中文

## 问题

主动 Memory recall 通过 `agent/pre-step` 绕过 Context Engine。其模型可见消息虽然持久，但没有 Context Evidence 或 coverage 留存；Prompt Enhancement 无法复用相同检索策略；并且当后续 pre-step listener 移除或改写提议时，结算仍假定所有已渲染 id 都进入了请求。Context Engine 只存在于 Web，headless standard session 无法依赖它。

## 决策

Context Engine 成为所有 profile 的 Host-plane base service。`StepContextInput` 新增分离的 `StepContextCaller`：持久 session 与 Agent id、workspace partition、可选 owning turn／step、有效 preset（包括已记录的空会话 preset 切换）及 origin。AgentLoop 与 Prompt Enhancement adapter 从权威 Session 状态构造它。

`memory-agent` 是一个 Host-owned Context Contributor，发行配置使用 `standard` preset gate。在 Agent 轮次首个 step，它保留 Provider `prepare -> commit/abort` 语义，只打包 active 且未过期候选，并生成绑定 revision 的 Memory Evidence、trust／provenance domain data 与有界 coverage。在 `turn/end`，只有当 `context/prepared` 把原始 recall message 精确链接到已接纳的 `user/message` 时才提交 injected id；被移除或改写的提议提交空 injected set。错误、取消、缺少 Assistant 输出、替换与卸载都会 abort prepared handle。Provider prepare 之后、pending-map ownership 之前发生失败，也会 abort 该未托管 handle；Evidence digest 覆盖完整注入 item payload，而不只 content/summary。

对于 `prompt_enhancement`，同一 Contributor 搜索相同的精确 Scope，并返回相同的消息／Evidence／coverage 形态，但不调用 prepare／commit／abort。`SearchMemoryInput.recordAccess: false` 使辅助预览保持只读：不会改变 access counter、signal、turn row 或 Session event。

## 考虑过的替代方案

- **保留独立 pre-step 注入** —— 拒绝；它会保留两条上下文管线，无法支持共享 trace 或 Prompt Enhancement。
- **为 Prompt Enhancement 调用 `prepare()`** —— 拒绝；未发送草稿没有可结算的 Host turn，也不应影响 usage ranking。
- **结算时信任已渲染 id 列表** —— 拒绝；下游接纳可能移除或改写提议，持久 trace 才是精确权威。
- **把 Context Engine 留在 Web bundle** —— 拒绝；CLI／headless Agent session 会静默失去 Memory 及其他 Contributor。

## 后果

Agent recall、Prompt Enhancement recall、持久来源链与用户可见上下文检查现在共享一条路径。Provider 仍保持 fail-open，并保留既有字符和候选预算。自定义部署可允许所有 preset 或配置显式持久 preset list。后续[受治理 Memory Center Note](../feature/2026-08-29-governed-memory-center.md)已经闭合 candidate review、edit／tombstone、显式冲突对比、可见 freshness 与 attached-session“为何使用”；跨 Session 聚合及 outcome/relevance feedback 仍开放。
