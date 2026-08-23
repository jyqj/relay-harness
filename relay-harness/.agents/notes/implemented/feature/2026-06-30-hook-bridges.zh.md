# Agent Note: rlh-hooks-claude-code + rlh-hooks-codex —— Claude Code / Codex 钩子桥接插件

Status: implemented

[English](2026-06-30-hook-bridges.md) | 中文

## 问题

harness 的扩展面是其类型化拦截点（见[拦截扩展点 Agent Note](2026-06-30-interception-extension-points.md)）：所谓「原生钩子」不过是一个普通的 Cordis 插件，订阅 `agent/session-start`、`agent/pre-step`、`tools/pre-execute`、`tools/post-execute`、`agent/turn-stopping`、`subagent/start` 或 `subagent/end`。但用户带着**既有的** Claude Code（CC）和 Codex 钩子配置到来，一个 `hooks.json`（或 settings 文件中的 `hooks` 键）里满是 shell 命令钩子，并希望它们原样运行。本 Agent Note 引入两个**桥接插件**，将外部 shell 钩子协议翻译到类型化扩展点上，构建于共享的协议格式（wire format）库之上（见 [hook-protocol-lib Agent Note](2026-06-30-hook-protocol-lib.md)）。

核心规则是：**桥接是兼容性适配器，不是高级工具。** 桥接能做的事（阻止工具、注入上下文、强制继续、观察 subagent），原生 Cordis 插件都能做得更强——类型化返回值、完整 `ctx`、无序列化边界。桥接存在的理由是运行外部 CC/Codex 命令钩子中被明确支持的子集。这使每个桥接保持精简：解析配置、选择匹配模式、构建每事件的 payload、调用共享库的 `runHook` + `mergeHookOutputs`，再将中性结果映射为类型化 Decision。各包的 README 维护着当前不支持的事件和部分支持的字段的完整清单，以官方协议为参照。

## 决策

`packages/hooks/` 组下两个独立插件，各为 function/namespace 插件（`name`/`inject`/`Config`/`apply`，无 default export——见[事故复盘（postmortem）0001](../../../../docs/postmortem/0001-acp-default-export-drops-inject.md)），仅注入 `bash`：

- **`rlh-hooks-claude-code`**——CC 方言。Claude Code 当前钩子点中的七个：`SessionStart`、`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`、`SubagentStart` 和 `SubagentStop`。负责构建 CC 形态的逐事件 stdin payload（基础字段 `session_id`/`transcript_path`/`cwd`/`hook_event_name` 加每事件字段）、`CLAUDE_PROJECT_DIR` 环境变量加 `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PROJECT_DIR}` 替换，以及字面量或正则的匹配模式。`transcript_path` 是持久化定位器结果或 `''`；stdin 带有**尾部换行**。
- **`rlh-hooks-codex`**——Codex 当前钩子点中的五个：`PreToolUse`、`PostToolUse`、`SessionStart`、`UserPromptSubmit` 和 `Stop`。它使用始终按正则解释的 matcher，输出 Codex 形态的 snake_case payload（含 `turn_id`/`model`/`permission_mode` 额外字段）且写入时不带尾部换行，不注入 Codex 插件环境变量，不做配置时占位符替换，也没有 pre-tool 审批或重写路径。`transcript_path` 是同一定位器结果或 `null`；工具 payload 在精简后的 `tool_input: { command }` 形态中携带真实的 `tool_name`。

### Outcome → Decision 映射

每个桥接将共享库返回的中性 `MergedHookOutcome` 映射到各扩展点的类型化 Decision：

| 扩展点 | CC | Codex |
|---|---|---|
| `agent/session-start`（emit） | additionalContext → `agent.inject()` | 记录来源；第一个非空 `agent/pre-step` 等待上下文并将其折入 `enter` |
| `agent/pre-step` | `deny`→`reject`；仅上下文→委托并折叠到 `enter` | `block`→`reject`；仅上下文→委托并折叠到 `enter` |
| `tools/pre-execute` | `deny`→`deny`；`ask`→`ask` | `block`→`deny`（无 allow/ask） |
| `tools/post-execute` | `deny`→`block`+反馈；仅上下文→委托并折叠 | 同上 |
| `agent/turn-stopping` | 阻塞的 Stop → 下一步 steering（中途引导） | 首次阻塞只 steering 一次；后续检查收到 `stop_hook_active: true`，再次阻塞时关闭轮次 |
| `subagent/start`（emit） | additionalContext → 注入到存活的进程内 subagent；远程 subagent 无本地注入目标 | 本桥接不支持 |
| `subagent/end`（emit） | 仅观察 | 本桥接不支持 |

CC 桥接的 `ask` 结果是一条真正的权限路径，而非终态桥接决策：`rlh-tools` 通过可选的[审批 seam](2026-07-06-approval-seam.md) 来解析它。ACP（Agent Client Protocol）自动化客户端可以应答所属会话的一次性机器策略请求，`allowed-once` 后继续执行；如果没有 ApprovalService 或应答器，调用以 `deny` 安全关闭。

### 上下文来源始终是插件（误标签防护）

每个桥接的 `inject()` 和 additional-context 输入都显式传入 `{ kind: 'plugin', plugin: 'hooks-claude-code' | 'hooks-codex' }`。单元测试固定验证结果中的 `user/message.source` 为插件而非用户。

`UserPromptSubmit` 在 `turn/start` 之后的 pre-step 运行，因此每次调用都会写入轮次范围的 `hook/invoked` / `hook/result` 对。拒绝会使已领取的输入维持移除状态，将轮次关闭为已阻止状态且不包含步骤，并保留该钩子对作为持久决策证据。Codex payload 会收到这个已打开轮次的 `turn_id`。

### 添加上下文不是否决——先 delegate，再 prepend

仅附加 `additionalContext`（没有 block/deny）的钩子并不是桥接可以独自返回的决策：在 waterfall（瀑布式事件）监听器中不调用 `next()` 就返回 `enter`，会短路其后的每个 `agent/pre-step` / `tools/post-execute` 监听器，使注册在桥接之后的策略/沙箱插件看不到该提示词。因此，每个桥接都会先通过 `next()` 委托，再将自身上下文加入下游 enter 决策。桥接会保留所有下游消息；下游 pre-step reject 会丢弃整个已领取批次，因为步骤从未打开。工具后决策仍保留独立的有序 `additionalContexts` 语义，包括 Code Mode 通过外层 `run_code` 结果延迟上下文。只有钩子本身真正返回 `deny`/`block` 才会短路。测试断言：仅上下文钩子之后，较晚的监听器仍能 reject 提示词，且保留的提示词和工具后上下文仍彼此分离。

### CLAUDE_PROJECT_DIR 默认为会话工作区

Claude Code 始终导出 `CLAUDE_PROJECT_DIR`，常见的未修改钩子引用 `$CLAUDE_PROJECT_DIR` 来构造项目相对路径。显式的 `config.projectDir` 优先；当它被省略时（默认 ACP 接线只配置 `configPath`），桥接将该环境变量按每次运行默认为 agent（智能体）的会话工作区——即钩子已经在其中运行的 `session.header.cwd`——而非留空。这样，一个标准的项目相对路径钩子在默认配置下即可正常工作。

### 隔离

CC 配置仍是进程级，并在加载时解析一次。Codex 会在 hook 点运行时解析已配置路径：绝对路径为共享配置，相对路径从每个会话 cwd 向上发现至最近 `.git` 根，并按绝对路径与文件版本缓存。缺失文件表示没有 hook；发现与解析失败会被隔离并去重，直到路径或版本变化。CC 桥接只运行 shell 形式的 `type: 'command'` 钩子；`http`、`mcp_tool`、`prompt` 和 `agent` 处理器被解析后跳过。Codex 桥接只运行同步命令处理器，跳过 `async: true` 或非命令条目。CC emit 监听器的上下文仍以 detached 方式运行并受到隔离。Codex 在 SessionStart emit 处记录来源，并在第一个非空 pre-step 内运行它；每个 Codex hook 运行都受桥接生命周期追踪，因此桥接 disposal 会中止其进程并等待结算。

### 钩子在哪里运行，配置从哪里来

hook 在 agent 的会话工作区中运行，因此相对命令指向用户项目。CC `configPath` 仍是进程级。相对 Codex `configPath` 属于会话本地，且不能越过最近 `.git` 根；绝对路径则有意应用于所有会话。

## 推迟的兼容性缺口

- **工具输入重写。** CC/Codex 的 `updatedInput` 被记录日志并发出警告，但不予执行——输入重写是一个推迟的一致性设计问题（见 [pre-tool-input-rewrite Agent Note](../../proposed/feature/2026-06-30-pre-tool-input-rewrite.md)），因为 pre-execution 参数被 `tool/call` 审计、`assistant/message` 历史和工具展示共同读取，诚实的重写是一个设计单元，而非一个字段。
- **钩子 `continue:false`（硬停止）。** 钩子可以请求终止整个运行（CC/Codex `continue:false`）；共享合并将其折叠为 `MergedHookOutcome.stop`/`stopReason`，但没有桥接对其采取行动（`TODO(hook-continue-false)`）——拦截点尚无「硬停止 agent」原语（Decision 阻塞/引导的是单个点，而非整个运行）。与循环防护工作一同推迟；轮中请求会将停止请求记录在 `hook/result` 中，钩子在此期间保留其逐点效果（决策/上下文）。
- **配置分层。** Codex 逐会话发现会选择一个显式 JSON 文件。完整合并的用户层、会话层、系统／托管层与插件层优先级模型、信任控制和内联 `config.toml` hook 仍在桥接范围之外。CC 继续使用其显式进程级文件。

## 曾考虑的替代方案

**每点钩子并发执行。** 参考引擎对一个点匹配到的钩子并发运行并折叠结果。本桥接**串行**运行（匹配循环内每个钩子 `await`），并以相同的最严格合并策略折叠。串行是刻意的：对轮次范围的拦截点，它使每个钩子的 `hook/invoked`/`hook/result` 对相邻且顺序确定，而折叠对决策是顺序无关的（`deny > ask > allow`），因此结果一致。代价是延迟（钩子 *N* 等待钩子 *N−1*）以及每钩子超时不重叠——对真实配置中的钩子数量可以接受；如果某配置的扇出大到影响总耗时，再重新评估。

## 后果

匹配语义、退出码处理和合并优先级位于 `rlh-hook-protocol`；每个桥接只负责解析配置、构建方言 payload 和映射结果。逐文件覆盖率包含配置分支以及通过真实循环、`rlh-bash-local` 和 shell 脚本的端到端映射，同时一个真实 Loader 冒烟测试守护包的导出形态。原生插件绕过协议格式，直接返回类型化决策。
