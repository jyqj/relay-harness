# Agent Note: Work uses execution-recorded whole-session deliverables

Status: implemented

English | [中文](2026-09-05-work-durable-deliverable-inventory.zh.md)

## Problem

A paged conversation is not a task inventory: older outputs disappear from Work after reopening a long Session. Recomputing every loaded turn on each streaming update also publishes unchanged Work summaries. A completed Goal can coexist with running work, and file-open rejection needs a user-visible recovery path.

## Decision

The tool runtime captures a successful root definition's declared `diff` or `generic/edit` locations into optional `ToolExecutionSuccess.producedFiles`. The agent loop copies the frozen paths to `tool/result` outside model content. Empty arrays mean captured without declared files; absence means legacy or unavailable capture. Optional presenter failure cannot turn a completed mutation into a failed, retryable execution. Session restore validates captured path arrays, and content-only rewrites must preserve the field.

The existing ui-deliverables Host half registers a pure `deliverables` projection over the full log. It publishes first-seen unique paths plus `unindexedResults`, ignores failed results and surface rewrites, and keeps state identity on irrelevant events. It does not reconstruct old capture using currently installed presenters. The existing [turn-local file-link decision](../feature/2026-07-31-web-workspace-file-links.md) remains applicable to turn tails; this inventory is a separate whole-session read model of the same durable source, not another Session owner.

Work reads that projection, reports incomplete or unavailable capture, and labels its trajectory count as loaded records. Running execution/jobs override Goal completion; paused and blocked phases remain explicit. Inputs and equal derived facts preserve observable identity. Host-open errors provide retry and dismissal, with per-Session stale-settlement suppression.

## Alternatives considered

**Derive the inventory from the browser timeline.** Paging and remounts change the answer and force repeated history scans.

**Replay old calls through the current tool registry.** Changed preset definitions or presenters would rewrite historical output claims, and a pure projection would depend on mutable runtime configuration.

**Track all filesystem side effects.** Shell and nested Code Mode mutation auditing require a broader execution protocol. Declared root-tool locations are a narrower, explicit scope and never prove that a file still exists or the task passed independent acceptance.

## Consequences

No model content or request schema changes. Historical uncaptured successes remain visibly incomplete instead of silently fabricated. Existing projection transports and SDK event carriers carry the additive data. Tests cover successful capture, presenter failure, frozen result replacement, real AgentLoop logging, restored whole-log inventory beyond the initial page, empty versus missing capture, invalid durable input, paused/blocked and complete-plus-running states, unchanged streaming notifications, stale open errors, and both SDK subprocess carriers. The assembled Web replay scenario exercises paging, reload, and Host refusal; it requires freshly built client artifacts.
