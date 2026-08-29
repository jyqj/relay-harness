# @relay-harness/rlh-memory-outcome-reconciler

[English](README.md) | 中文

Host reconciler 会从 live-preferred logical Session corpus 派生幂等 Memory outcome，且不会 resume Agent。它扫描 `context/prepared` 中已准入的 Memory Evidence，观察所属 Assistant message 与 `turn/end`，读取 durable message-feedback sidecar，并把显式 `goal/change` complete/block transition 关联到最近一次此前发生的 recalled turn。每次 Session reconciliation 都会原子替换该 Session 的 outcome set，因此 feedback rating 变更和删除会撤回旧 observation。Feedback sidecar 不可用时会中止替换并保留上一份 durable set；失败的全量扫描可以重试，不会永久 memoize。

只有显式正／负 message rating 与 durable Work completion 会影响有界 ranking。普通 retrieval、injection、completed turn、failed turn 和 blocked Work 都保持 neutral 且可检查；它们绝不会被改名为 useful。初始 persisted scan 以有界并发在后台运行，live Session event 与 `message-feedback/changed` 会调度单 Session refresh。

## 模型体验

### 不直接发起模型请求

#### 模型看到什么

什么也看不到。本包读取 `context/prepared`、Session outcome 与 message feedback，并写入 provider-neutral Memory outcome observation；它不组装模型内容。

#### Token 影响

直接影响为零 token。后续 `memory-agent` search 可能按 canonical provider 的有界 outcome adjustment 对候选重新排序。

#### KV Cache 影响

这里不改变请求或 prefix。后续非 prefix Memory Context contribution 可能包含不同的排序结果。

## 已知限制与暂缓事项

- Work completion 会关联到最近一次此前准入 Memory Evidence 的 turn；它是显式正向结果 Evidence，不证明某一条记忆单独导致完成。
- `goal/change` block 和普通 turn outcome 保持 neutral，因为没有建立失败因果关系。
- 默认不捆绑 semantic conflict provider；optional seam 由部署拥有。
