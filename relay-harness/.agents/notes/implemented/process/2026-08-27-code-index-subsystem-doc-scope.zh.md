# Agent Note: The code-index subsystem page owns the whole five-package capability

Status: implemented

[English](2026-08-27-code-index-subsystem-doc-scope.md) | 中文

## 问题

`docs/subsystems/code-index.md` 仍停留在脚手架状态：只覆盖 seam 包，正文写着 provider、存储、引擎与工具包"在后续增量交付"。五个包此后全部落地，参考页不再匹配它所拥有的子系统，那个时代留下的陈旧表述也出现在包 README 里——`rlh-tool-code-index` 的 Known Limitations 断言"尚未发布任何 provider"，而 `rlh-code-index-local` 恰恰就是那个 provider。经子系统页进入的读者没有任何单一位置能描述横跨五个包的管线。

## 决定

`docs/subsystems/code-index.md`（及其中文对应版）现在是整能力参考：带各包接线的包角色表、从 scan 到出口信封的数据流、epoch、仓库规模分档表（含存储侧缓存容量列）、带 lane/融合/rerank 常量的检索管线、六表存储布局及其 FTS 维护纪律、provider 管线（排除层、diff、切片、存储路径推导）、三个失效触发入口、带出口预算与截断信封的工具面、model 可见行为，以及集中的一节 Known Limitations。subsystems README 的索引行同步描述该页的新范围。陈旧的 README 表述在其属主处修正：`rlh-code-index` 的导语现在陈述三个角色均已发布，`rlh-tool-code-index` 删除"尚无 provider"限制。已登记的 `SearchRequest` type-equiv 块与生成的 cordis-surface 区域原样未动。

## 已考虑的替代方案

- **只依赖五个包 README** —— 否决：每个 README 都是单包契约，跨包管线（一个 pass、一次 epoch 递增、一个出口上限）没有归属，而 subsystems 层存在的意义正是每个子系统一页。
- **改为更新落地 note** —— 否决：五篇 `2026-08-27-code-index-*` note 记录的是落地决定，不是 subsystems 层的文档范围；改写它们会把决定记录变成参考散文。

## 后果

该页成为所有跨包 code-index 事实的入口，后续增量（P2 符号/图、P3 向量/证据）扩展其集中的限制一节，而不是留下脚手架时代的散文。四个被编辑配对的 pairing 记录已重新记录，type-equiv 门禁对未改动块依然通过。
