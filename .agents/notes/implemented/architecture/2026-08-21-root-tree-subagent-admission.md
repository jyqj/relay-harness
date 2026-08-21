# Agent Note: Root-tree subagent admission

Status: implemented

English | [中文](2026-08-21-root-tree-subagent-admission.zh.md)

## Problem

Subagent providers could start independently and every consumer could fan out through the same service, but the service owned no shared capacity. Provider-local limits could not coordinate spawn, fork, remote, workflow, and team paths, while a tool-only limit was bypassed by direct service callers. Recursive delegation could therefore multiply active child lifetimes without one root-session ceiling.

A capacity slot also needs one correct release point. Result settlement is too early because a one-shot run can still own resources, and continuable children have no run result at all. Releasing before quiescent disposal would admit replacement work while the previous child still holds an Agent, process, transport, or descendant forest.

## Decision

`SubagentRuntime` owns one `SubagentAdmissionController` used by ordinary `start()` and every continuable materialization. Since workflows and teams delegate through the same service, they enter the same table without consumer-specific integration. The controller resolves the highest currently live durable ancestor of the direct parent and charges the child to that root plus its direct-parent id. Different roots have independent state.

`maxActivePerRoot` and `maxActivePerParent` are optional positive configuration values. Omission leaves that scope unbounded, preserving the Service Definition as a reusable composition primitive. The shipped base bundle sets `maxActivePerRoot: 4` and `overflow: reject`, following Codex multi-agent v2's four-thread default while applying the bound to DSH's transport-neutral child lifetime. Saturation rejects with `CAPACITY_EXCEEDED` before provider startup or Agent materialization.

`overflow: queue` is an explicit alternative deployment policy. Each root owns a queue; promotion selects the oldest waiter whose root and direct-parent ceilings both permit admission, so one parent at its sibling cap does not block an eligible sibling parent. Caller cancellation removes the waiter. Runtime close rejects queued and future acquisitions but does not revoke already-published children.

One-shot admission transfers into the returned `SubagentRun`; its idempotent wrapper releases only after the provider's `dispose()` attempt settles. Provider startup rejection releases immediately. Continuable admission transfers into the Activation and releases after unpublished rollback or full Activation handle disposal, after child-first teardown and quiescence. Every release is idempotent and may promote queued work.

## Alternatives considered

**Limit only the model-facing delegation tool.** Rejected because workflows, teams, direct service consumers, and future adapters call `ctx.subagents` without that tool.

**Let each provider own capacity.** Rejected because simultaneous spawn, fork, and remote children would occupy independent pools and exceed one root's intended ceiling.

**Count only active model turns in the Agent loop.** Rejected because remote provider work and non-model child resources remain active outside that state, and adding subagent policy to the generic loop would invert capability ownership.

**Release on `result` or lifecycle end.** Rejected because observation can settle before holder-owned cleanup, and continuable Activations expose neither a run result nor a holder.

**Use one process-global ceiling.** Rejected because unrelated user roots would starve each other. Root-local counters preserve isolation while still bounding recursive fan-out.

**Queue by default.** Rejected because a nested caller can occupy a root slot while waiting for another slot, making progress depend on an unrelated child releasing. Immediate rejection gives the model a deterministic capacity error; deployments that prefer backpressure can opt into queueing with caller cancellation.

## Consequences

The base composition admits at most four simultaneous one-shot runs and continuable Activation lifetimes across one complete root tree, regardless of provider or consumer. A fifth start fails before external work. Direct compositions stay unbounded unless they choose a ceiling, and distinct roots never share slots.

Capacity now follows cleanup rather than visible completion. A one-shot consumer that violates the existing requirement to dispose every returned run also retains capacity, making the ownership leak observable instead of silently oversubscribing. Continuable rollback and teardown release even when handle cleanup reports an error, preventing a failed cleanup record from permanently starving the root.

Queue mode can wait indefinitely if its caller supplies no useful cancellation and no admitted lifetime releases. It remains opt-in; manager and runtime teardown close admission and reject pending work.

Unit coverage pins root isolation, sibling ceilings, eligible promotion, cancellation races, close behavior, and idempotent release. Service coverage pins shared ancestry, provider-start rollback, one-shot disposal ownership, and continuable release after Activation quiescence.
