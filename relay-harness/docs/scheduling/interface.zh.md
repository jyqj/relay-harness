# Agent ↔ 中转调度接口

[English](interface.md) | 中文

> 初始契约：`v1-draft`。传输采用 HTTP/JSON，请求结果通过 SSE 流式返回。

## 1. 创建调用

```http
POST /v1/routes
Content-Type: application/json
Accept: text/event-stream
Idempotency-Key: <opaque-id>
```

```yaml
route_request:
  contract_version: v1-draft
  request_id: string
  mode: chat|work|subagent|prompt_enhance
  conversation_semantics: chat|agent
  input:
    messages: [Message]|null
    tool_schemas: [object]
    prompt_enhance_context:
      current_draft: ContextNode
      history: [Exchange]
      retrieved_context: [ContextNode]
      rules: [Rule]
      guidelines: [Guideline]
      memory_context: [ContextNode]
    # mode=prompt_enhance 时必填；其他 mode 为 null
  signal_mode: pre_classify|provided
  routing_signal: RoutingSignal|null
  signal_vocabulary_version: string
  requested_strength_level_id: string|null
  constraints:
    max_charge: {amount: number, unit_id: string}|null
    deadline_ms: number|null
    excluded_capabilities: [string]
  metadata:
    locale: string|null
```

约束：

- 每次 chat 请求和每次 work 启动：`signal_mode=pre_classify` 且 `routing_signal=null`。
- Subagent：`signal_mode=provided`，完整信号必填，`source=parent_agent`。
- Prompt Enhancing 使用 `mode=prompt_enhance`；`conversation_semantics` 由 agent 的上下文管线根据历史结构给出，`signal_mode=pre_classify`。其结果只返回草稿，不触发工具。
- `request_id + Idempotency-Key` 保证重复提交不会创建两次计费调用。
- 不发送本地验证结果、checkpoint、权限审计或训练标签。

## 2. SSE 事件

每个事件包含：

```yaml
event:
  contract_version: v1-draft
  request_id: string
  sequence: integer
  type: string
  data: object
```

事件类型：

| type | data | 说明 |
|---|---|---|
| `route.started` | `{strength_level_id, pricing_version, price_preview}` | 已完成选型并开始调用 |
| `message.delta` | `{text}` | 文本增量 |
| `tool_call.delta` | `{call_id, name, arguments_delta}` | 工具调用增量 |
| `usage.updated` | `{input_units, output_units}` | 可选中间用量 |
| `route.completed` | `{usage, charge, billed_strength_level_id, pricing_version}` | 正常结束 |
| `route.failed` | `{error}` | 调用失败，流终止 |

同一 `request_id` 的 `sequence` 必须严格递增。`route.completed` 或 `route.failed` 之后不得再发送事件。

## 3. 取消

```http
DELETE /v1/routes/{request_id}
```

取消必须幂等。调度侧停止继续生成，并通过原 SSE 流返回终止事件或关闭连接；最终计费语义由计费方案定稿后补充。

## 4. 错误结构

```yaml
error:
  code: invalid_request|invalid_signal|unsupported_version|unauthorized|quota_exceeded|no_candidate|timeout|upstream_error|cancelled|internal
  message: string
  retryable: bool
  retry_after_ms: number|null
  field: string|null
```

错误消息必须可行动。契约不兼容、Subagent 信号缺失和侧重权重不为 `1.0` 时不得静默降级。

## 5. 版本化

- 新增可选字段走兼容版本；删除字段或改变语义必须升主版本。
- agent 与调度项目共同维护兼容矩阵。
- `signal_vocabulary_version` 与传输契约独立版本化。
- 正式开发前需把本草案固化为 OpenAPI + JSON Schema，并生成契约测试夹具。
