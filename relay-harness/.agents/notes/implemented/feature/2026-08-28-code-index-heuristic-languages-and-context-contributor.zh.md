# Agent Note: Code-index heuristic languages, SFC extraction, and the opt-in code-context recall contributor

Status: implemented

[English](2026-08-28-code-index-heuristic-languages-and-context-contributor.md) | 中文

## Problem

Phase 2 的解析器只覆盖十个语法解析语言名。C#、PHP、Ruby、Swift、Kotlin、Dart、Scala、Lua 全部落到 generic 行窗档——没有 symbol、没有 import、没有调用边——Vue/Svelte 单文件组件则被当成不透明文本切片，图层对相当一部分真实工作区的回答因此静默缺席。消费者一侧，seam 只有一种消费者形态：模型必须自己想起调用 `search_code_index`；没有一条通道能把排序后的索引召回推进到模型正在处理的 step 里。

## Decision

用参考实现自己的回退策略扩展语言覆盖，并为 seam 增加第一个上下文侧消费者：

- **spec-driven 抽取**（`code-index-parser/src/languages/spec-driven/`）。八个无语法语言经移植自参考实现 `spec_driven.rs` 的逐语言正则表解析——class 与 function 声明模式、每语言一条 import 模式、以 `CALL_SITE_RE` 匹配同文件调用点并共享 `CALL_KEYWORD_BLOCKLIST`——`heuristic` 置信度 0.5。声明结尾向前扫描至多 200 行寻找收尾符，找不到则回退 30 行。spec-driven 语言不抽取字面量。参考实现的 C# `Environment.GetEnvironmentVariable` 数据流边与其 resolution-tier 边字段（callee uid、resolution kind/strategy）明确不在本阶段记录词汇内。
- **SFC 抽取**（`code-index-parser/src/languages/sfc.ts`）。`vue` / `svelte` 复用 JS/TS 语法处理每个组件抽取出的 `<script>` 块——不需要专属 wasm，解析复用已存在的语法二进制。分档为 `heuristic` 并钉住 0.78：参考实现 `parse_sfc` 在其结果上硬编码该置信度，是对启发式默认 0.5 的具名偏离。`event_emitter` dispatch 类别为 SFC 模板事件边预留，目前没有 walker 发射它。
- **分档矩阵。** 二十个受支持语言名——十九种实际语言，`jsx` 共享 JavaScript 语法——分四档：JS/TS 家族、Python 与 Rust 为 `semantic`（0.85）；Go、Java 与 C/C++ 为 `tree-sitter`（0.7）；两个 SFC 名为 heuristic-0.78；八个 spec-driven 名为 heuristic-0.5。`tierForLanguage` 对其余返回 `null`，未知扩展名仍走 generic 切片器。
- **code-context contributor**（`packages/context/code-context`）。注册严格 opt-in：带 config section 的 Loader 条目经 `ctx.inject(['contextEngine'])` 后期绑定注册一个 step-context contributor（`code-index-recall`）；没有 config section 的条目只构造 `ctx.codeContext`、不注册任何东西，且该包不进任何 bundle。对每个被认领的 step，contributor 把 direct user 消息的文本块拼成一个 query——同文本的多处 `@file` 提及作为显式 `paths` 范围随行——对 seam 执行一次排序检索，执行期经 `ctx.get('codeIndex')` 读取，因此索引保持可选。健康答案贡献一条不可信的 `## Code-index recall` 消息（fenced 块内的 hit 行，预算按排名顺序施加：`maxChars` 65536、`maxHits` 8、`minQueryChars` 8，按 code-point 边界裁剪并记 `truncated`），外加每条注入 hit 一条 `revision` 为答案 `indexEpoch` 的证据记录与一条有界覆盖记录。无命中的 step 贡献一条简短的有界否定消息而不是沉默；degraded 或失败的检索除结构化警告外不贡献任何内容，派生上下文由此永远无法伪装成合法的"无结果"。反递归是结构性的：query 只读 direct user 消息——注入的 recall 文本绝不成为下一次 query 的输入——且 `form: 'recall'` 的源记录被 session-query 语料抽取跳过，把 recall 挡在派生消费者之外。

## Consequences

语言覆盖从十个名字到二十个（十九种语言）；generic 档现在是真正未知扩展名的回退，而不是八个常见语言的日常档。正则启发携带参考实现的黑名单与置信度钉值，不是语法级精度——这笔取舍记在子系统文档的限制清单里。contributor 与工具消费者并肩而不竞争：[工具消费者](../architecture/2026-08-27-code-index-tools.md)回答模型主动提出的问题；contributor 召回模型没有要求但正在处理的上下文，有界且标注为不可信。两者都沿用[seam 脚手架](../architecture/2026-08-27-local-code-index-seam.md)的后期绑定解析模式。与本 Phase 同批收口的 DSL 与分析 op 归[分析 op note](../architecture/2026-08-28-code-index-analysis-ops-and-dsl.md) 所有；其下的向量层归[向量核心 note](2026-08-28-code-index-vector-core.md) 所有。

## Alternatives considered

- **为 spec-driven 语言再 vendor 八个语法 WASM**——否决：八个语法产物（下载钉定、字节大小锁、每次 release 的 web-tree-sitter 兼容审查）换来的声明级抽取精度提升，抵不过参考实现自己的正则表；参考实现出于同样的理由让这些语言走 spec 驱动。
- **用专属 Vue 语法解析 SFC**——否决：`<script>` 块复用让 JS 家族内容只有一条语法谱系；专属 wasm 会与它重复的 JavaScript 语法漂移，并为 JS 语法本就可解析的内容增加一个 release 钉定产物。
- **默认启用 recall contributor**——否决：无论部署是否想要召回，每个 step 都要付一次排序检索的延迟与输出预算；config section 的有无就是开关，这让没有要求的部署保持逐字节不变的默认。
- **用全部 step 消息（含 assistant 与上下文）构建 query**——否决：assistant 轮次包含 contributor 自己注入的 recall 文本，query 会在自己的输出上递归并漂离用户意图；direct user 文本是每步意图的忠实信号，`form: 'recall'` 投影规则则封掉经派生消费者的第二条递归路径。
