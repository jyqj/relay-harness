# Context Engine（本地上下文引擎）

本文是 Relay 上下文管理的权威设计：如何从多个本地来源检索、验证、打包上下文并注入模型请求。决策依据见 [ADR-0006](../adr/0006-local-context-engine.md)；File Context 的产品边界见 [work-and-files.md](work-and-files.md)；Prompt Enhancing 的管线见 [prompt-enhancing-context-pipeline.md](prompt-enhancing-context-pipeline.md)。

## 1. 核心结论

Relay 不新建检索单体。已有五个本地领域引擎——session-query、memory、LSP、CodeCortex（代码索引）、code-runtime——各自持有自己的索引与治理纪律。Context Engine 是加在它们之上的**薄控制面**，只负责四件事：

1. 统一 Source / Resource / Revision 协议；
2. 按任务编排并行检索（planning + capability 路由）；
3. 把检索结果准入为绑定 revision 的 Evidence，做 hydration 与机械验证；
4. 在预算内打包为不可变的 ContextView，随单次请求投递。

索引、检索、排序、打包全部在本机完成；云端只承担模型推理。

```text
Local Source Registry（本地文件、Session、Memory、附件、Web 快照）
        ↓
本地 Knowledge Providers（各自持有索引，全部可重建）
  ├─ CodeCortex adapter    code.search / graph / impact / tests / routes
  ├─ LSP bridge            definition / references / implementation / hover（read-through）
  ├─ session-query         会话检索与 lineage
  ├─ memory                记忆召回（trust 状态机）
  └─ web / attachment      read-through
        ↓
Context Control Plane（packages/context-engine，新增）
  ContextRequest → 并行检索 → 准入/hydration/机械验证 → Packer → 冻结 ContextView
        ↓
AgentLoop spine seam（preStep 内、systemPrompt.assemble 之前）
```

## 2. 现状盘点（已具备能力）

| 能力 | 现状 | 位置 |
|---|---|---|
| Session 检索 | live-preferred corpus、surface fold 验证、lineage 追溯、FTS 抽象方法、分页 cursor | `relay-harness/packages/session-query/` |
| 防递归索引 | recall 形式消息不产生 semantic document，派生内容不能再索引自己 | 同上 |
| Memory 治理 | append-only revision、trust 状态机、prepare/commit/abort、自动提取 | `relay-harness/packages/memory/` |
| LSP seam | 四个语义操作，无 JSON-RPC 逃生舱 | `relay-harness/packages/lsp/` |
| 代码索引 | FTS5+grep+图 多 lane RRF、双 epoch、脏闭包降级状态机、14 MCP 工具 | `codecortex-rust_副本/`（独立仓，纳管方式见第 9 节） |
| 显式文件上下文 | File Context 条目含 fingerprint/stale 语义 | 本节之上由 work-and-files.md 权威定义 |
| 请求前上下文插件 | 时间、tmux、agent 指令等运行时事实注入 | `relay-harness/packages/context/` |

缺口：统一协议、Evidence 层、capability 路由、Coverage 协议、AgentLoop seam、检索轨迹与评测。`file-reference` 目前只是 prompt 约定，不读取内容、不绑 revision。

## 3. 协议

### 3.1 Source 与 Resource

```yaml
source_descriptor:
  source_id: string
  kind: string            # 开放命名空间：file_tree / session_corpus / memory_scope / attachment / web_snapshot
  authority: local
  versioning:             # revision 对控制面 opaque
    strategy: content_hash | sequence | git_commit | etag | snapshot
  access:
    read_scopes: [string]
  trust: { tier: string, instructions_allowed: false }
```

Resource 由 `source_id + opaque key + revision + locator` 寻址，不使用裸 `path:startLine-endLine`。File Context 条目天然映射为 file_tree source 的显式 Resource 引用。

### 3.2 Evidence

检索命中是 `EvidenceCandidate`；经准入后才成为 Evidence：

```yaml
evidence:
  evidence_id: string
  resource: { source_id, key, revision }
  locator: {}                    # 领域自定义：行区间 / 事件 seq / 记忆 revision
  content: { inline | content_ref, digest, truncated }
  provenance: { provider_id, acquired_at, query_leg_id }
  quality:
    freshness: current | possibly_stale | stale | unknown
    verification: verified | partially_verified | unverified | contradicted | unavailable
  domain: {}                     # 领域负载：代码图信息 / 布局 / trust 等
```

状态机：`Candidate → Admitted → Hydrated → Verified → Selected → Packed`；任何环节失败转为显式 degraded 状态，不静默丢弃。

### 3.3 验证分两档

| 档 | 机制 | 成本 | 策略 |
|---|---|---|---|
| 机械验证 | hydration digest 与索引 fingerprint 比对、revision 一致性、locator 有效性 | 近零 | 无条件开启，属于准入管线 |
| 语义验证 | evidence 是否支持结论、反证检测 | 模型调用 | 仅在显式 obligation 下开启，不进热路径 |

### 3.4 ContextRequest 分两层

```yaml
context_request:
  deterministic_envelope:        # 零成本、永远可用
    working_set: [resource_ref]  # File Context 显式条目
    explicit_references: [resource_ref]
    source_scope: {}
    budget: { input_tokens, latency_ms }
  intent_layer:                  # 仅 investigate/research 级任务由模型填充
    goal: string
    questions: [string]
    obligations: { exhaustive_within_scope, verify_primary_claims }
```

Work 模式的显式文件引入即 deterministic envelope 的来源，不需要模型参与请求构造——这是"无项目心智 + 文件即显式上下文"产品形态的直接红利。lookup/gather 级检索永远不触碰 intent layer。

### 3.5 ContextView

冻结后对单次请求不可变；请求 header 记录 `view_id / pack_hash / content_ref`，保证 event-sourced session 的可重放性。ContextView 以 sourced message 桥接进入请求；被注入的 context 消息不得产生 semantic document（沿用 session-query 的 recall 语义，推广到全部 context 注入）。

## 4. Capability 路由（CodeCortex 与 LSP 的合并）

| 查询 | 路由 | 理由 |
|---|---|---|
| 已知 symbol 的定义/引用/实现 | LSP 优先，CodeCortex 兜底 | LSP read-through 永远新鲜 |
| 全局搜索、调用图、impact、相关测试 | CodeCortex | LSP 无全局图 |
| 索引 degraded（`DirtyPropagationStatus != Normal` 或 epoch 落后） | LSP + grep 降级路径 | 读失败不得静默变空 |

两者输出同一 `CodeEvidence` 协议（含 revision 与 provider 标记），Agent 感知不到差别。

## 5. AgentLoop 接入

spine seam 插在 claim inbox 之后、`systemPrompt.assemble` 之前（`packages/core/agent-loop/src/agent.ts` `preStep()`）：

```text
claim inbox
→ ctx.contextEngine.prepareStep(claimed, scope, working_set, budget)
→ freeze ContextView
→ capture tool snapshot
→ systemPrompt.assemble(view 元数据)
→ agent/pre-step
→ build request
```

留在 `systemPrompt.context()` 的只有小型确定性运行时事实（时间、cwd、tmux）。AgentLoop 只负责在正确时序调用该 seam；检索、路由、打包全部在 context-engine Provider 内部。

## 6. Retrieval Agent 与完成契约

检索默认是 service；仅当需要策略循环（query 迭代改写、多跳追图、穷尽枚举、高置信否定结论）时升级为 Retrieval Agent：

- 只读白名单：`code.search` / grep / read / `lsp`；
- typed finish：scope、negative findings（必须附 Coverage：searched / not_searched / completeness 分级）、open questions；
- 零命中不得直接形成否定结论，必须扩域（去目录限制、替代拼写、sibling 位置）；
- Search Log 由 Runtime 从工具历史生成，Agent 不得自证覆盖；
- snippet 是 pointer，交接时 hydration；
- finish 经 Runtime Completion Gate 验证后立即停止 child；未 finish 不回退到最后一条自由文本，而是 `failed: missing_completion_contract` 或 runtime 基于已有 evidence 形成 `partial`。

## 7. 本地资源治理

- 索引文件数上限（CodeCortex 默认 50k）、磁盘占用对用户可见，提供开关；
- watcher 与 Agent 的 CPU 竞争通过 jobs 后台调度与 backpressure 控制；
- 索引构建不使用隐藏模型调用；
- 索引属于缓存：可随时删除重建，删除后检索降级为 LSP + grep 路径而非失效。

## 8. 分阶段落地

| 阶段 | 内容 | 验收 |
|---|---|---|
| Phase 0 | 本 ADR 与本文；`SourceRef / EvidenceId / Evidence header` 协议草案；升级 `file-reference`：显式引用读取内容、绑定 revision、随请求注入 | 显式引用文件不再依赖模型自行 read；引用内容带 revision 可追溯 |
| Phase 1 | spine seam（可空实现）；session-query adapter；deterministic packer；ContextRun trace | 一次会话检索经 packer 进入请求，trace 可重放 |
| Phase 2 | CodeCortex adapter（capability 面 + ProviderHealth：脏闭包状态与双 epoch 上翻）；LSP bridge 与路由；Coverage 协议 | 代码调查任务经统一 Evidence 协议产出；degraded 状态可见 |
| Phase 3 | bounded Retrieval Agent + enforced finish gate；eval corpus（以本仓真实任务为种子） | 否定结论带 Coverage；评测有召回/精度基线 |
| Phase 4 [待决策] | 本地嵌入 lane（经 memory 已预留的 provider seam；模型与向量库留本机）；Context 来源面板 UI | 由 Phase 3 评测结果触发 |

## 9. 待决策项

- [待决策] 语义检索 lane：是否引入本地嵌入模型，取决于 Phase 3 评测中词法+图信号的召回缺口大小。
- [待决策] ContextView 与 compaction 的交互：跨 turn 复用已打包 evidence 的策略（当前结论：不显式 pin 则不复用）。
- [待决策] CodeCortex 的纳管方式（独立仓 + 版本化依赖，或并入 monorepo）。
