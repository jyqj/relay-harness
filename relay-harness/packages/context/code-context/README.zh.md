# `@relay-harness/rlh-code-context`

[English](README.md) | 中文

主动启用的代码索引召回上下文。当插件条目携带 config 小节时，本包注册一个 context-engine 步骤上下文 contributor（`code-index-recall`，经 `ctx.inject(['contextEngine'])` 延迟绑定，因此引擎保持可选）。对每个被认领的步骤，它把直接用户消息的 text block 拼接为一个检索 query——同一文本中每个去重后的 `@file` 提及作为显式 `paths` 范围传入——并对可选的 `ctx.codeIndex` seam 执行一次排序检索。

带命中的健康答案贡献一条 `code-index` 召回消息与每条注入命中一条修订绑定的 evidence 记录，并填充预留的 `coverage` 字段（由 contributor 记录；读取它的引擎侧表面是 context-engine 的后续工作）。零命中答案改为贡献一条简短的 bounded 负向消息而不是沉默。降级答案（seam 报告 `degraded` 或逐 lane 的 `readErrors`）与失败的检索不贡献任何内容：记录为结构化 warning，绝不渲染成合法的"无结果"消息，因此派生上下文不会伪装成新证据。直接用户文本低于 `minQueryChars` 的步骤、或完全没有直接用户文本的步骤，不贡献任何内容。

`form: 'recall'` 的 source 记录使该投影不进入派生消费方：session-query 语料抽取跳过 recall 形态的消息，memory 抽取只收集 `kind: 'user'` 的消息。注入严格 opt-in：不带 config 小节的 Loader 条目会构造 `ctx.codeContext` service，但不注册 contributor；本包也不进入任何组合包。

## Configuration

| 键 | 默认值 | 约束 |
|---|---:|---|
| `maxChars` | `65536` | 一条召回消息中注入的命中行码点数上限。 |
| `maxHits` | `8` | 每步骤注入的命中条数上限。 |
| `minQueryChars` | `8` | 触发检索所需的直接用户文本最小修剪长度。 |

`maxChars` 与 `maxHits` 必须为正安全整数；`minQueryChars` 必须为非负安全整数。预算按排序顺序生效且以 Unicode 码点为计量单位（一个增补平面字符计 1）：渲染后无法完整放入的命中行按码点边界截断并记录为 `truncated`，超出预算的命中被丢弃且不产生 evidence。只要预算截断过列表或裁剪过某行，消息尾部都会附上候选数说明。

## Model Experience

### 注入的代码索引召回

#### What the model sees

在步骤的被认领用户消息之后，一条以 `## Code-index recall` 开头的 user 角色召回消息。它先把条目声明为不可信的检索输出，再在 `code-index-recall` 围栏块内按命中逐行给出 `path:start-end score reasons`；零命中步骤收到一条简短消息，说明索引中没有相关内容且这不构成"不存在"的证明。持久 source 记录在 query 与 epoch pair 旁列出每条注入命中的 `chunkId`、文件路径、行界、分数与截断标记。

#### Token effect

有条件且有上限：只有直接用户文本达到 `minQueryChars` 的步骤才会收到该消息，其大小受 `maxHits` 与 `maxChars` 约束。低于门槛的步骤不增加任何 token。

#### KV Cache effect

召回消息位于步骤被认领用户消息之后，不进入任何稳定前缀；预算或 query 变化只影响该步骤的尾部。索引 epoch 不变时排序是确定性的，同一 query 在同一 epoch 下逐字节复现该消息。

## Known Limitations and Deferred Work

- **epoch 粒度的 evidence 修订** — 检索 seam 不暴露逐 chunk 的内容哈希，因此每条 evidence 的 `revision` 只能绑定全索引的 `indexEpoch`；任何索引提交都会让所有未消费记录失效，而不是仅失效变更的 chunk。
- **不参与 compaction 固定** — 召回消息是普通 user 轮次；compaction 可能丢弃它们，本包既不固定也不重新注入其内容。
- **缺失 `ctx.codeIndex` 时每个 turn 以 error 收场** — 部署注册了 contributor 却没有 code-index provider 时，每个贡献步骤都以错误结束而不是贡献沉默（沿用 `file-reference-local` 的 fails-loud 先例）。
- **compaction checkpoint 可能重新索引 recall 衍生文本** — checkpoint 摘要是带 plugin source 的模型创作 `user/message`，可能复述 recall 衍生文本并进入 session-query 语料；`form: 'recall'` 的抽取跳过只覆盖 recall 消息本身（ADR 0006 第 6 条边界止于系统注入上下文，checkpoint 摘要位于 assistant 回复一侧）。
- **原文即 query** — query 是逐字取用的直接用户文本，没有改写或抽取步骤；检索质量取决于 seam 对自然语言的容忍度，超长轮次也不做缩短。
