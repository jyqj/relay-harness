# @relay-harness/rlh-hooks-codex

[English](README.md) | 中文

一个 Cordis 插件，在 harness 的规范拦截点上运行用户现有 **Codex** hook 配置的受支持子集。它是 hooks 子系统中采用 **Codex 方言** 的一侧。方言无关原语来自 [`@relay-harness/rlh-hook-protocol`](../hook-protocol/README.md)；该桥接负责处理 Codex 形状的 payload、matcher 模式和决策映射。

该桥接实现 Codex 当前 hook 协议的一个有意选取的子集：

- **10 个 hook 点中的 5 个：** `PreToolUse`、`PostToolUse`、`SessionStart`、`UserPromptSubmit` 和 `Stop`。
- **仅使用正则的 matcher**（没有字面量快速路径；matcher 始终是未锚定正则）。
- **snake_case stdin payload**，携带 `turn_id`／`model` 额外字段，写入时**不带**尾随换行符。
- **没有 Codex 插件 env 注入，也没有配置时 placeholder 替换**（命令仍会接收执行器环境，并通过其 shell 运行）。
- **没有工具前审批或改写路径**：hook 可以阻塞，但桥接不会预审批或替换工具输入。

原生 Cordis 插件可以完成此桥接的所有工作，并且功能更强；该桥接只是已映射 Codex 子集的兼容路径（见 [拦截扩展点 Agent Note](../../../.agents/notes/implemented/feature/2026-06-30-interception-extension-points.md)）。

## 配置

```ts
import type { Config } from '@relay-harness/rlh-hooks-codex'
const config: Config = {
  configPath: '/path/to/.codex/hooks.json', // required
  model: 'deepseek-v4',                      // optional: stamped on every payload (Codex includes `model`)
  defaultTimeoutMs: 600_000,                 // optional: per-hook timeout when a hook sets none
  stderrSummaryMaxChars: 500,                // optional: char cap on the hook/result event's persisted stderr summary
}
```

在 `cordis.yml` 中：

```yaml
- rlh-hooks-codex:
    configPath: ./.codex/hooks.json
    model: deepseek-v4
```

绝对 `configPath` 命名一个共享文件。相对路径会按会话独立发现：桥接从 `session.header.cwd` 开始，在每个祖先目录检查该路径，直至包含 `.git` 的最近目录，且不会越过该项目根；无 agent 调用从进程 cwd 开始。包含 `..` 的路径会被拒绝。已解析配置按绝对路径、文件系统身份、大小、mtime 与 ctime 缓存，因此不同工作区互相隔离，编辑会在下一个 hook 点生效。缺失文件表示没有 hook；发现或解析失败会被隔离并去重，直到路径或文件版本变化。无效正则会报告其 pattern 与事件。只运行同步 `type: 'command'` hook；非 command 或 `async: true` hook 会被解析并跳过，同时记录警告。hook 接受 `timeout` 或 `timeoutSec` alias；两者都未设置时，使用协议参考默认值 `DEFAULT_HOOK_TIMEOUT_MS`（来自 `rlh-hook-protocol`，10 分钟）。五个桥接支持点之外的事件会在解析时丢弃。

hook 本身会在 agent（智能体）的会话工作区中运行：对 agent scope 点，桥接会将会话 `cwd` 作为 hook 进程工作目录，因此 hook 作用于用户项目树，而非服务器启动目录。

## Hook 点 → 类型化 Decision

| Codex hook | Harness 点 | 映射 |
|---|---|---|
| `SessionStart` | `agent/session-start`（emit）+ 第一个非空 `agent/pre-step` | 在 emit 处记录来源，随后等待纯 stdout 或 JSON additionalContext，并把它折入第一个进入的请求 |
| `UserPromptSubmit` | `agent/pre-step`（waterfall，瀑布式事件） | `block`（退出码 2）→ `PreStepDecision.reject`；仅 additionalContext → 通过 `next()` 委托，再向下游 `enter` 决策追加一条单独标记来源的消息 |
| `PreToolUse` | `tools/pre-execute`（waterfall） | `block` → `PreToolDecision.deny`（没有 `allow`／`ask`） |
| `PostToolUse` | `tools/post-execute`（waterfall） | `block` → 带反馈的 `block`；仅 additionalContext → 通过 `next()` 委托，再将一个单独标记源的上下文前置到下游决策；Code Mode 将子调用上下文延迟到外层 `run_code` 结果 |
| `Stop` | `agent/turn-stopping`（serial） | 一个轮次中的首次阻塞会通过 `steer()` 送入原因；下一次检查报告 `stop_hook_active: true`，且不能再强制 continuation |

工具调用的 payload 携带真实 `tool_name`（matcher 测试的相同值）与 Codex `tool_input: { command }` 形状（存在 `command` arg 时使用该值，否则使用 `''`）。matcher subject 是工具名称（`PreToolUse`／`PostToolUse`）或会话源（`SessionStart`）；`UserPromptSubmit`／`Stop` 忽略 matcher。

每个 agent scope stdin payload 都携带 `session_id` 和 `transcript_path`。可用时，桥接通过 `ctx.sessionPersistence.locate(session.header)` 解析后者，否则发送 `null`，保留 Codex `string | null` 形状。查找不会创建或 flush 产物，因此在第一个轮次结束检查点之前，路径可能尚不存在，或其指向的 transcript（文本记录）可能尚未包含当前未结束的轮次。

`SessionStart` 在 emit 处只记录来源。第一个非空 pre-step 会在 `UserPromptSubmit` 前运行并等待它，因此其上下文会进入第一个模型请求。每个点都在调用方信号与桥接生命周期组合出的信号下运行并受到跟踪；对桥接执行 dispose（资源释放）会中止仍在运行的 hook 进程，并等待其运行链结算（`createDetachedRuns`，位于 `rlh-hook-protocol`）。

## 上下文源

注入上下文携带显式 `{ kind: 'plugin', plugin: 'hooks-codex' }` 来源，因此持久消息绝不会被误认为用户提示词。

## 模型体验

### Hook 提供的上下文

#### 模型看到的内容

`SessionStart`、已接受提示词和工具后 hook 可以添加带源归因的上下文消息；阻塞 `Stop` hook 将其原因添加为下一步 steering（中途引导）。

#### Token 影响

hook 不返回上下文时没有成本。Hook 文本取决于数据，会被记录，并重发直到压缩（compaction）。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 已阻塞提示词或工具结果

#### 模型看到的内容

提供方提供的原因逐字传递。缺失原因时，已阻塞提示词精确使用 `blocked by UserPromptSubmit hook`，已拒绝工具变为 `Error: blocked by PreToolUse hook`，已阻塞工具后反馈精确为 `blocked by PostToolUse hook`，阻塞 stop 则精确添加 steering `continue: blocked by Stop hook`。Codex `systemMessage` 不会呈现。

#### Token 影响

阻塞提示词不会产生该提示词对应的模型请求 token；拒绝或反馈会添加保留的回退或提供方文本；强制 continuation 需要另一个完整请求。

#### KV Cache 影响

已阻塞提示词不发送请求，不会导致失效。拒绝、反馈与强制 continuation 上下文会追加在可复用前缀之后，不改写前缀。

## 已知限制与暂缓事项

- **不支持的 hook 事件（Codex 当前 10 项中的 5 项）：** `PermissionRequest`、`PreCompact`、`PostCompact`、`SubagentStart` 和 `SubagentStop`。这些事件的配置会在解析期间静默丢弃。比较基线是 Codex [官方 hook 参考](https://learn.chatgpt.com/docs/hooks)。
- **`SessionStart` 只支持部分功能：** 纯 stdout 与 JSON `additionalContext` 会进入第一个请求，但不会强制执行 `systemMessage` 与 `{"continue": false}`。
- **`UserPromptSubmit` 只支持部分功能：** 支持阻塞加纯 stdout 或 JSON 上下文，但不会强制执行通用 `systemMessage` 和 `{"continue": false}` 控制。
- **`PreToolUse` 只支持部分功能：** 支持阻塞，但会忽略 `additionalContext`、`permissionDecision: "allow"` 和 `updatedInput`。每个工具都表示为 `tool_input: { command }`，因此非 shell 工具参数不会如实公开给 hook。
- **`PostToolUse` 只支持部分功能：** 支持阻塞反馈与 JSON `additionalContext`，但不会强制执行 `{"continue": false}`，非 shell 工具参数会缩减为 `{ command }`，结构化工具输出会在 `tool_response` 中展平为文本。
- **`Stop` 只支持部分功能：** 首次阻塞会强制再执行一个模型步骤，同一轮次中的后续检查会收到 `stop_hook_active: true`；第二次阻塞会关闭轮次，而不是继续循环。`last_assistant_message` 仍为 `null`，且不会强制执行 `{"continue": false}`。
- **通用 payload 与输出字段只支持部分功能：** 每个已映射事件都报告静态配置的 `model` 与 `permission_mode: "default"`，而非当前 Codex 运行时值。`systemMessage` 会被记录并触发警告，但不呈现，`{"continue": false}` 会被记录但不会应用 Codex 事件特定停止行为（`TODO(hook-continue-false)`）。
- **配置加载与执行只支持部分功能：** 绝对共享路径或相对的逐会话项目发现会选择一个 JSON 文件；尚未实现 Codex 合并的用户层、会话层、系统／托管层和插件层、信任控制与内联 `config.toml` hook 形式。只运行同步 `command` handler，忽略 `statusMessage` 与 `commandWindows` 等当前元数据，匹配 handler 串行运行，而非使用 Codex 的并发启动语义。
