# Agent Note: Runtime resource bounds for turns, Code Mode, and SDK transport

Status: implemented

English | [中文](2026-08-31-runtime-resource-bounds.zh.md)

## Problem

Three execution-local paths retained attacker- or workload-controlled data without a complete bound. A turn could keep starting model requests through tool calls or steering, Code Mode binding values bypassed the outer-output ledger, and the TypeScript SDK accepted an unterminated JSON-RPC frame plus arbitrarily many unsettled writes and subscription notifications. Final-result truncation did not protect these earlier commit points.

## Decision

The already-shipped token budget controller also enforces `maxStepsPerTurn` at `agent/pre-step`, defaulting to 64. It reconstructs the count from durable `step/start` events and throws before request 65, so resume cannot reset the hard cap; the existing in-memory continuation heuristic remains separate.

The worker-thread Code Runtime adds `maxBindingBytes`, defaulting to 64 MiB like its existing outer-output cap. The host measures each decoded argument before invoking a binding and each lossless resolution before encoding it back to the worker. Oversize values become typed binding rejections rather than structured-clone traffic or program-visible intermediate state.

`JsonRpcLineTransport` caps one inbound or outbound frame and aggregate unsettled output at 64 MiB by default. Partial input is byte-accounted before a newline arrives; output bytes remain charged until their stream callback settles. Resource failures close the logical transport and are observable by owners. The TypeScript SDK passes these limits through and bounds each subscription at 4096 queued notifications; overflow fails and detaches only the slow subscription while preserving its admitted prefix.

The independent Python SDK implements the same defaults natively rather than relying on the TypeScript client: byte-mode stdout framing rejects an oversized line or unterminated partial frame, synchronous stdio writers reserve their encoded bytes before waiting on the writer lock and loop until every byte is written, and each subscription uses a 4096-item queue. A raw write returning `0` or `None` fails closed before flush. Typed Python errors preserve the same three failure categories, and `RelayHarnessConfig` passes every limit to the low-level client. The runtime wheel's default Cordis composition pins the server-side frame and write limits explicitly.

The 64 MiB frame and binding defaults reuse the runtime's existing outer-output compatibility ceiling rather than adding a tighter undocumented payload limit. The 64-step default matches the shipped fixed Ralph round ceiling, and 4096 reuses the repository's established large collection ceiling while making retention finite.

## Alternatives considered

**Rely on process memory and Node stream backpressure.** Rejected because `Writable.write(false)` is advisory and JavaScript queues remain able to grow; process OOM is not a resource contract.

**Truncate binding values or notifications.** Rejected because both are canonical typed data. A bounded explicit failure preserves meaning; silent truncation would fabricate a valid-looking value or incomplete event stream.

**Put the turn cap inside AgentLoop.** Rejected because the existing lifecycle policy plugin already owns continuation budgets. Counting durable step events at the pre-step seam keeps the loop replaceable and lets custom compositions replace the policy deliberately.

**Use much smaller new defaults.** Rejected without workload evidence. Reusing current product ceilings closes unbounded growth without creating an unrelated compatibility break; deployments can lower every limit explicitly.

## Consequences

Ordinary shipped compositions have finite model requests per turn, Code Mode bindings cannot retain or clone an unbounded canonical value through the default worker Adapter, and both SDK clients have explicit transport/subscription failure points. Custom Agent compositions that remove the controller again own the missing turn policy. A hostile worker argument is measured after worker-to-host structured clone, so the worker heap limit remains the earlier backstop; a future wire-token preflight can move that rejection earlier without changing the public contract. Python's legacy global notification and incoming-request queues remain separate low-level APIs; the bounded high-level run path uses subscriptions.
