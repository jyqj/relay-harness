# index/ — 本地代码索引能力系列

[English](README.md) | 中文

构建当前工作区的派生磁盘代码索引，并向模型暴露确定性混合检索的插件族。所有成员均为可选装配。

| 包 | 角色 | ctx key |
|---|---|---|
| [`code-index/`](code-index/README.md) | 检索 seam：抽象服务、词汇类型与仓库规模分档 | `ctx.codeIndex` |
| [`code-index-sqlite/`](code-index-sqlite/README.md) | SQLite 索引库：schema、fail-closed 打开与失配重建、chunk 文本编解码 | — |
| [`code-index-search/`](code-index-search/README.md) | 排序引擎：lane/preselect 注册表、lexical + grep 双 lane、RRF 融合、确定性 rerank | — |
| [`code-index-local/`](code-index-local/README.md) | 本地 provider：工作区扫描、`.gitignore` 叠加、增量 diff、80 行通用切片、tool-result 失效钩子 | — |
| [`tool-code-index/`](tool-code-index/README.md) | 面向模型的工具：`search_code_index`、`code_index_status`、`refresh_code_index`，带分档出口预算 | — |

检索受仓库规模分档（`tiny`/`small`/`medium`/`large`）约束，常量由 seam 统一持有；每个面向模型的出口都施加分档预算。结果携带 epoch 对；任何 `readErrors` 非空的结果都是降级结果，绝不可缓存。
