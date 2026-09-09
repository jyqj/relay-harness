# `@relay-harness/rlh-code-context`

[English](README.md) | 中文

主动启用的代码索引召回上下文。当插件条目携带 config 小节时，本包注册一个 context-engine 步骤上下文 contributor。对每个被认领的步骤，它先把 `ctx.codeIndex` 绑定到 `input.cwd`，再把直接用户消息的 text block 拼成 query，把去重后的 `@file` 提及作为显式 `paths` 范围，执行一次排序检索，并通过同一个不可变 Workspace face 批量 hydrate 被选中的候选。

带命中的健康答案贡献一条包含 source-verified fenced snippet 的 `code-index` 召回消息，并为每条接纳的 snippet 生成 evidence。evidence revision 是当前文件内容哈希，digest 覆盖实际注入的源码，`verification` 为 `verified`；parser 来源、score trace 与 search/hydration 两组 epoch 保留在 durable source/domain 记录中。过期、不可用或 revision 漂移的 hydration 会被省略并写入 warning 与 coverage。degraded/失败 search 或失败/空 hydration 不产生模型消息，而是抛出携带稳定阶段分类的 `ContextProviderError`，供引擎记录决策 trace；不产生 path-only fallback 或虚假的无结果声明。渲染预算耗尽记录显式 declined。诊断不包含原始 query 或 Provider 异常文本，部分 hydration 的 warning 只包含拒绝数量。健康且无命中的 search 仍贡献有范围限制的否定消息。

`form: 'recall'` 的 source 记录使该投影不进入派生消费方：session-query 语料抽取跳过 recall 形态的消息，memory 抽取只收集 `kind: 'user'` 的消息。注入严格 opt-in：不带 config 小节的 Loader 条目会构造 `ctx.codeContext` service，但不注册 contributor。默认 Web/Desktop 组合会在 Workspace router 上启用它。

## Configuration

| 键 | 默认值 | 约束 |
|---|---:|---|
| `maxChars` | `65536` | 一条召回消息中完整 snippet entry 的码点数上限。 |
| `maxHits` | `8` | 每步骤注入的命中条数上限。 |
| `minQueryChars` | `8` | 触发检索所需的直接用户文本最小修剪长度。 |

预算按排序顺序和 Unicode 码点计量。每个 entry 先为完整 path/revision/parser header 与比源码中任意反引号连续段更长的 Markdown fence 预留空间；只有源码正文允许裁剪。固定 framing 无法容纳时整条 entry 被丢弃且不生成 evidence；footer 报告候选截断与源验证 rejection。

## Model Experience

### 注入的代码索引召回

#### What the model sees

在步骤的被认领用户消息之后，一条以 `## Code-index recall` 开头的 user 角色召回消息。它把源码声明为不可信数据，再在 `code-index-recall` 块中为每个已重新验证的 chunk 渲染 revision/parser/ranking header 与 fenced source body；零命中消息仍说明 index miss 不是不存在证明。durable source 记录携带内容哈希、parser 来源、score trace、截断状态和两组 epoch，但不重复正文。

#### Token effect

有条件且有上限：只有直接用户文本达到 `minQueryChars` 的步骤才会收到该消息，其大小受 `maxHits` 与 `maxChars` 约束。低于门槛的步骤不增加任何 token。

#### KV Cache effect

召回消息位于步骤被认领用户消息之后，不进入任何稳定前缀；预算或 query 变化只影响该步骤的尾部。索引 epoch 不变时排序是确定性的，同一 query 在同一 epoch 下逐字节复现该消息。

## Known Limitations and Deferred Work

- **不参与 compaction 固定** — 召回消息是普通 user 轮次；compaction 可能丢弃它们，本包既不固定也不重新注入其内容。
- **缺失 `ctx.codeIndex` 时每个 turn 以 error 收场** — 部署注册了 contributor 却没有 code-index provider 时，每个贡献步骤都以错误结束而不是贡献沉默（沿用 `file-reference-local` 的 fails-loud 先例）。
- **compaction checkpoint 可能重新索引 recall 衍生文本** — checkpoint 摘要是带 plugin source 的模型创作 `user/message`，可能复述 recall 衍生文本并进入 session-query 语料；`form: 'recall'` 的抽取跳过只覆盖 recall 消息本身（ADR 0006 第 6 条边界止于系统注入上下文，checkpoint 摘要位于 assistant 回复一侧）。
- **原文即 query** — query 是逐字取用的直接用户文本，没有改写或抽取步骤；检索质量取决于 seam 对自然语言的容忍度，超长轮次也不做缩短。
