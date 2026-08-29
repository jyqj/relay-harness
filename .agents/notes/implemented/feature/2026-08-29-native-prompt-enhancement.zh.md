# Agent Note：基于共享 Context Engine 的原生 Prompt Enhancement

Status: implemented

[English](2026-08-29-native-prompt-enhancement.md) | 中文

## 问题

Relay 文档把 Prompt Enhancement 作为核心用户入口，但没有交付运行时符号、Host 能力、Remote 或 composer 控件。把它实现为私有 Prompt composer 会复制已归属 Context Engine 的文件、Memory、代码、预算、Evidence 与 trace 决策。把增强路由进 AgentLoop，则会让一项唯一合法输出只是可编辑未提交草稿的操作接触工具与 turn 副作用。如果浏览器不把原草稿作为 compare-and-set 前提，延迟结果还会覆盖用户的新编辑。

## 决策

Prompt Enhancement 是一条拥有清晰职责的完整能力路径：

- `rlh-prompt-enhancement` 拥有一个增强提供方注册位、一个 Context Engine 适配器注册位、生成的 `promptEnhancement.enhance` Remote、取消，以及在每个失败分支携带精确原草稿的结果 union。
- `rlh-prompt-enhancement-context-engine` 使用一等 `prompt_enhancement` purpose、精确草稿、工作区与取消信号调用目标 Agent 既有的 `ctx.contextEngine.prepareStep()`。它转交已选择消息，并把既有 contribution、Evidence 和 coverage 值投影成不透明 JSON；不拥有检索逻辑或平行 Evidence 类型。
- `rlh-prompt-enhancement-llm` 执行一次独立 `ctx.llm` 调用。它不提供工具，在 AgentLoop 外运行，在 dispatch 前记录精确请求，限制完整输入与原始输出流，并只接受包含建议草稿、assumptions 与 open questions 的严格 JSON。
- `rlh-client-ui-prompt-enhancement` 在不修改 InputBar 的情况下占用 `conversation.input.right`。它在 Simple 和 Developer 模式下都保持可见，在卸载时取消，并展示带 assumptions 和 open questions 的原文/增强 diff。它安全读取不透明 trace，并展示已接纳的文件、代码、Memory、History 与 MCP Evidence，以及资源 key、provider 自有的选择原因、新鲜度和验证状态；未知 trace 记录保持隐藏，而不会获得猜测的来源。只有显式 Accept 才能应用建议，而且草稿值与单调 revision 必须仍等于记录尝试；写入通过普通输入事务进行，因此既有撤销和显式 revision-guarded 撤销都会恢复原文。忙碌点击会穿过 Remote 取消请求，Session 切换／移除会取消陈旧工作。它绝不提交。

已发布 Web 组合使用真实 Context Engine 适配器。Base 层提供 purpose-specific Session History contributor，因此已完成 exchange 与已批准 compaction checkpoint 会进入同一次 preparation pass，而不产生 Prompt-owned 历史 composer。`rlh-prompt-enhancement-context-none` 只保留为显式测试或部署适配器，不能静默替代缺失引擎。上下文或增强提供方缺失时会明确失败并保留草稿。

## 持久化与模型请求语义

辅助模型请求携带 provider-neutral 的 `purpose: 'prompt-enhancement'` 元数据，并省略 `GenerateOptions.tools`。增加 purpose 本身不改变 provider wire；适配器可以有意采用 purpose-specific 策略。`prompt-enhancement/llm-request` 记录 route、稳定指令、精确的已准备消息和 framing 草稿、输出上限，以及可选 Context Engine trace。该事件只写日志，不进入 `deriveMessages()`。接受建议只改变浏览器草稿状态；用户随后提交时才开始普通对话持久化。

## 结果

默认 Web 路径是 Host 服务 → 共享 Context Engine → 无工具 LLM 提供方 → 生成 Remote → composer 控件。提供方失败或取消不能丢失原文，与新编辑竞争的结果不能覆盖它。上下文质量仍受共享引擎及其已组合 contributor 限制，因此改进检索会同时改进 Agent step 和增强，而无需第二套集成。

建议对话框把完整新旧草稿渲染为 removed 与 added block，而不计算 word-level inline diff。来源解释只是既有 Context Engine trace 字段的客户端投影，不会建立第二套 provenance 类型或重新解释 provider Evidence。结构化结果携带两份草稿、assumptions、open questions 和 trace，因此更丰富的展示不需要另一套 Host 协议。组装浏览器测试会驱动一轮已完成历史、真实生成 Remote 与辅助 replay provider、建议审阅、接受、输入事务、撤销、取消，并验证增强没有触发任何 turn 提交。

## 备选方案

- **独立 `EnhancerContextComposer`**——否决，因为它会复制来源选择、Evidence、预算、权限、freshness 与 trace 策略，并与 Agent 上下文漂移。
- **用 Prompt 文案禁用工具的 AgentLoop turn**——否决，因为 Prompt 文案不是执行强制，turn 仍会改变持久对话生命周期，而 LLM 服务已支持独立辅助请求。
- **Context Engine 缺失时回退纯草稿**——已发布 Web 路径否决，因为这会让错误组合看似成功。独立 context-none 包让真正需要它的部署显式选择。
- **自动提交或无条件应用延迟结果**——否决，因为增强是编辑建议。提交仍是用户动作，替换前比较会保留请求运行期间发生的新编辑。
