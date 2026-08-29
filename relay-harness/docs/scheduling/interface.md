# Agent ↔ Relay Scheduling Interface

English | [中文](interface.zh.md)

> Initial contract: `v1-draft`. Transport uses HTTP/JSON and streams request results through SSE.

## 1. Create a call

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

Constraints:

- Each Chat request and Work start uses `signal_mode=pre_classify` with `routing_signal=null`.
- A subagent uses `signal_mode=provided`, requires a complete signal, and sets `source=parent_agent`.
- Prompt Enhancement uses `mode=prompt_enhance`; the agent context pipeline sets `conversation_semantics` from history structure and uses `signal_mode=pre_classify`. Its result returns a draft only and triggers no tools.
- `request_id + Idempotency-Key` prevents duplicate submission from creating two billed calls.
- Local verification results, checkpoints, permission audits, and training labels are not sent.

## 2. SSE events

Every event contains:

```yaml
event:
  contract_version: v1-draft
  request_id: string
  sequence: integer
  type: string
  data: object
```

Event types:

| type | data | Meaning |
|---|---|---|
| `route.started` | `{strength_level_id, pricing_version, price_preview}` | Selection completed and the call started |
| `message.delta` | `{text}` | Text delta |
| `tool_call.delta` | `{call_id, name, arguments_delta}` | Tool-call delta |
| `usage.updated` | `{input_units, output_units}` | Optional intermediate usage |
| `route.completed` | `{usage, charge, billed_strength_level_id, pricing_version}` | Normal completion |
| `route.failed` | `{error}` | Call failed and the stream ends |

`sequence` increases strictly within one `request_id`. No event follows `route.completed` or `route.failed`.

## 3. Cancellation

```http
DELETE /v1/routes/{request_id}
```

Cancellation is idempotent. Scheduling stops generation and returns a terminal event on the original SSE stream or closes the connection; final billing semantics remain pending until pricing is decided.

## 4. Error structure

```yaml
error:
  code: invalid_request|invalid_signal|unsupported_version|unauthorized|quota_exceeded|no_candidate|timeout|upstream_error|cancelled|internal
  message: string
  retryable: bool
  retry_after_ms: number|null
  field: string|null
```

Errors are actionable. Contract incompatibility, missing subagent signals, and emphasis weights not summing to `1.0` cannot degrade silently.

## 5. Versioning

- Adding optional fields is compatible; deleting fields or changing semantics requires a major version.
- The agent and scheduling projects jointly maintain a compatibility matrix.
- `signal_vocabulary_version` versions independently from the transport contract.
- Before implementation, this draft becomes OpenAPI + JSON Schema with generated contract fixtures.
