# Agent Note：代码索引工具消费者——先于 provider 的模型侧界面

Status: implemented

[English](2026-08-27-code-index-tools.md) | 中文

## Problem

本地代码索引能力（[seam](2026-08-27-local-code-index-seam.md)、[检索引擎](2026-08-27-code-index-search-engine.md)、[SQLite 存储](2026-08-27-code-index-sqlite-store.md)）缺少模型可见的 Consumer，任何部署都无法端到端使用检索。工具还需要把参考实现的单出口输出预算（`output_budget.rs`）原生化移植，而不是重新散落到各 handler；同时要决定在 provider 插件尚未加载的组合里这些工具如何表现。

## Decision

在 `packages/index/` 下新增 `@relay-harness/rlh-tool-code-index`：`search_code_index`、`code_index_status`、`refresh_code_index` 三个工具。

- seam 保持可选。静态注入会让缺失 provider 阻塞整个组合；改为每次 execute 用 `ctx.get('codeIndex')` 解析，并以结构化错误 `INDEX_TOOL_UNAVAILABLE` 失败——这样缺插件被转化为最早可解析点（首次调用）上模型可读的普通错误，而不拖累无关工具。
- 出口预算是一个移植模块：`ExitPolicy` union 加 `applyExitPolicy`。search 按 `repoSizeTierMaxOutputChars(answer.tier)` 做字节封顶，档位在执行之后从答案自身读取；status 与 refresh 按构造天然有界走 passthrough。信封的 `partial` 在重解析失败时降级为有界的预览字符串——参考实现回填原始值的兜底被刻意舍弃，因为它会击穿自己的上限。
- 刷新在 seam 折叠语义之上叠加工具侧忙碌守卫：本插件仍在等待一次 pass 时，后续调用立即得到 `INDEX_TOOL_REFRESH_IN_PROGRESS`，而不是排队等提交后的重复第二次摘要。

Prompt 指引是一条固定 section（`tool:code-index`，order 107），逐字说明何时以索引检索替代 grep/glob，以及通过 epoch 处理过期结果。

## Alternatives considered

- **由 provider 拒绝重复刷新** —— 现阶段不采纳：seam 契约已经折叠并发，再在其内建第二条队列要么与本守卫重复、要么与之矛盾；工具层守卫让面向模型的语义停留在模型可读的位置。
- **注册时以 seam 是否存在作为门控** —— 不采纳：这会让无关部署能否加载其余工具绑死在一个可选能力上，正是 `ctx.get` 约定要避免的失败模式。

## Consequences

目录接线沿用既有清单：带拒绝式 stub provider 的 `TOOL_PACKAGES` 启动配方供 schema 收割；README 链接生成的 `relay-harnessrlh-tool-code-index` 锚点。与参考实现的两处偏差需要保持可见：字节预算度量的是 UTF-8 字节而档位常量名为 "chars"；提示性字段 `includeGrep` 先于 seam 类型扩展挂到出站请求。
