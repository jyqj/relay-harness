# Agent Note：治理 Embedding Generation 与检索评测

状态：已实现

[English](2026-08-29-code-index-embedding-generations-and-eval.md) | 中文

## 问题

初版向量层以 model 字符串作为 job/vector 身份，只为变更文件的 chunk 入队，每个 job 各发一次 endpoint 请求和 SQLite 事务，并让向量写入推进 `evidenceEpoch`。这隐含了三个错误假设：model 名可唯一标识嵌入管线、未变化 chunk 不需要 reconciliation、派生向量属于运行时证据。已有索引后来开启 Embedding 或切换 endpoint/model 会留下永久覆盖洞；同名模型端点可能混用不兼容向量；batch 配置没有转化成 worker 吞吐；没有摄入运行时证据的系统却宣称 evidence 时钟前进。检索改动也只有 fixture 测试，没有可复用的 Recall@5/MRR corpus runner。

## 决策

Schema v8 新增 `embedding_generations`。Generation 的 SHA-256 身份覆盖 provider id、去凭据后的规范 endpoint 身份、model、配置维度或显式 `provider-default` 模式、归一化版本、量化器版本与 chunker 版本。Job/vector 携带 `generation_id`；语义键分别为 `(chunk_id, generation_id, content_hash)` 与 `(chunk_id, generation_id)`。Model 仅为诊断和旧直接存储调用方保留反规范化列，provider 检索绝不再以它作选择器。

Provider 打开时及每次刷新提交后，coverage reconciler 都计算“当前 chunks 减去配置 generation 已有向量”。该差集不依赖 mtime 或此前 changed paths。启用 Embedding、改变 endpoint/model/dimensions、或打开已有 store 都会回填未变化 chunk；旧 generation 会共存到派生 store 重建。

Worker 在一个租约事务中领取有界 job 批次，批量读取 chunk 正文，经一个 client 调用嵌入全部输入，量化所有返回向量，在一个事务写入向量行，再逐 job 结算。Provider 聚合 usage 按估算输入 token 比例确定性分配，整数余数按稳定顺序补齐；分配总和恒等于 provider usage。每次成功向量事务只推进一次 `embeddingEpoch`。`evidenceEpoch` 是独立播种、当前无人写入的运行时证据时钟；`indexEpoch` 仍是源码/索引内容时钟。缓存键观察完整返回时钟快照。

`evaluateRetrieval()` 仅通过公开 `search` seam 执行确定性相关性判断，报告文件级 Recall@5、MRR 与逐 case 排名。测试覆盖确定性 corpus、以已 checkout 的 `code-index-local` 包作为真实工作区、以及单文件定域增量 admission。Pass 进入扫描后才到达的刷新范围也会保留并合并为一个分离的后续 generation，关闭 watcher 事件丢失窗口，同时不破坏扫描前的并发折叠。

Embedding reconciliation 在 refresh 于活跃 worker 期间提交时保留一次排干后观察位，关闭最终空 claim 的丢失唤醒窗口；有界精确 vector recall 触及扫描上限时会报告 degraded 的部分覆盖，而不会把候选集伪装成穷尽结果。

## 考虑过的替代方案

- **以 `(model, dimensions)` 作为身份**——否决；endpoint、归一化、量化器和 chunker 变化都会使向量不兼容。
- **只在切换模型时回填**——否决；启用该层和修复缺失向量本质上是同一个集合差问题。
- **向量推进 `indexEpoch`**——否决；源码/索引内容没有变化，专用派生物化时钟更精确。
- **继续使用 `evidenceEpoch`**——否决；向量生成没有摄入运行时观察或已验证执行证据。
- **只 benchmark 私有 engine 方法**——否决；绿色 engine benchmark 会漏掉 provider mapping、lazy refresh、持久化和 seam 输出回归。

## 后果

Schema 失配会原地重建派生 store，因此 v6 数据库重新索引而非迁移。固定维度配置拥有精确 generation 身份。缺省维度使用显式 `provider-default` 模式，client 在运行期锁定首个回复；需要防止 endpoint 跨重启静默改变默认维度的部署应配置 `dimensions`。Coverage reconciliation 对当前 chunk 精确；当前内容的终态失败会获得一次持久化有界重置。scanner/stat/hash/parse 阶段现使用确定性有界并发，BuildExplain 报告构建生命周期。Eval harness 现门禁 TypeScript/Python/Go fixture、真实工作区、Recall@5、MRR 与增量 p95。量化仍在 Node 线程，因为本机典型 16x1536 批次 p95 低于 0.5 ms，小于 worker 交接成本。
