<!-- 英文源文件由 scripts/gen-doc-graphs.ts 生成；本中文文件是通过双语配对维护的经评审对侧。
     更新时先运行 `pnpm run gen-doc-graphs` 更新英文，再更新本文件并运行 `pnpm run verify-translation-pairing --write docs/tool-execution-pipeline.md` 重新记录配对。 -->

# 工具执行流水线

[English](tool-execution-pipeline.md) | 中文

此图展示策略、钩子、沙箱、资源协调、文件系统守卫、结果重写、最终结果观察和 UI 渲染在不改变循环的情况下何时运行。`tools/pre-execute` waterfall 与单调 guard 首先运行，`ToolDefinition.resourceIntents` 随后解析规范 claim，接着运行 `tools/execute` 与 `tools/post-execute` waterfall。由定义自身控制的 `finalizeContent` 与 `tools/result` 在此之后运行。

```mermaid
flowchart TD
  model["Assistant message contains tool-call block"]
  toolCall["Session event: <code>tool/call</code><br/>logged before execution"]
  presentCall["UI pending card<br/>presentCall(args)"]
  pre["<code>tools/pre-execute</code> waterfall<br/>hooks, permission, sandbox"]
  guards["Registered monotonic guards<br/>deny or abstain; identity protected"]
  resources["ToolDefinition.resourceIntents<br/>canonical read/write claims"]
  denied["denied or approval refused<br/>tool body skipped"]
  approval["<code>ctx.approval</code> one-shot prompt<br/>absent or unanswerable: deny"]
  around["<code>tools/execute</code> waterfall<br/>timeout, retry, metrics (around dispatch)"]
  locks["Fair resource locks<br/>same-key conflicts serialize"]
  toolBody["Registered tool execute() body"]
  fsGate["<code>fs/write-intent</code> or <code>fs/edit-intent</code><br/>tool-fs mutations only"]
  owned["Tool-owned session events<br/><code>todo/write</code>, <code>fs/observed</code>, <code>hook/invoked</code>, <code>hook/result</code>, <code>tool/code-dispatch</code>"]
  post["<code>tools/post-execute</code> waterfall<br/>accept, block, replace, add context"]
  normalized["Registry outer normalization<br/>pipeline/result snapshot throws become isError"]
  finalize["ToolDefinition.finalizeContent<br/>last content-only invariant"]
  final["<code>tools/result</code> synchronous notification<br/>frozen authoritative outcome"]
  context["Active-batch additionalContexts FIFO<br/>injected user/message after recorded tool results"]
  toolResult["Session event: <code>tool/result</code><br/>single model-facing outcome"]
  allResults["Tool batch settled<br/>recorded tool/result events complete"]
  presentResult["UI completed card<br/>presentResult(args, result)"]
  model --> toolCall
  toolCall --> presentCall
  toolCall --> pre
  pre -->|allow| guards
  guards -->|allow| resources
  guards -->|deny| denied
  guards -.->|throw| normalized
  resources --> around
  resources -.->|throw| post
  around --> locks
  locks --> toolBody
  pre -->|deny| denied
  pre -->|ask| approval
  approval -->|allowed-once| guards
  approval -->|rejected, cancelled, unavailable| denied
  approval -.->|throw| normalized
  denied --> post
  pre -.->|throw| normalized
  toolBody --> fsGate
  fsGate --> toolBody
  toolBody --> owned
  toolBody --> around
  around --> post
  around -.->|wrapper throws| normalized
  post -.->|throw| normalized
  post --> finalize
  normalized --> finalize
  finalize --> final
  final --> toolResult
  toolResult --> presentResult
  toolResult --> allResults
  allResults --> context
```

文件系统的先读后编辑检查位于 `tool-fs` 之下，通过 `fs/*` 事件实现。通用前置／后置 waterfall 承载 hook 与审批 policy；`ctx.approval` 在单调 guard 之前处理询问，而不得重新排序的所有者 policy 仍作为已注册 guard。资源 resolver 在 policy 后执行身份查找；资源获取发生在可重叠 dispatch 阶段内、紧邻主体之前，因此被某个 key 阻塞不会占据有序 prepare lane。超时等环绕分发关注点会通过 `tools/execute` 同时包装锁等待与主体。注册表会对候选结果进行无损快照；快照失败会先被规范化，之后再由可见定义中随快照固定的 `finalizeContent` 回调强制执行同步且仅限内容的不变式。随后，`tools/result` 观察不可变、可由 JSON 无损表示的结果。Code Mode 会让保留的 `run_code` 传输及其子调用经过同一快照、锁和流水线。

维护模式：英文源文件包含人工维护的 Mermaid 流程图，并由生成器写出；本中文文件作为经评审对侧通过双语配对维护。确切的工具 schema 与事件签名位于生成的目录中。
