# Agent Note: Ordinary-user execution and instruction containment

Status: implemented

English | [中文](2026-08-31-ordinary-user-execution-and-instruction-containment.zh.md)

## Problem

Two optional developer mechanisms crossed the ordinary-user trust model. The generic Workflow tool sent model-written JavaScript to a worker-thread engine whose `node:vm` shapes the script API but does not contain hostile code; the base bundle nevertheless exposed that tool. The fixed Ralph script uses the same engine without accepting model-written code and is not part of this defect. Separately, `agent-instructions` followed a repository-owned final-component symlink to any host-readable target, so opening a repository could place content outside its project root into a model request. The latter behavior was an explicit earlier trade-off, but it conflicts with Relay's explicit File Context and ordinary-user data-access direction.

## Decision

The ordinary-user compositions do not expose arbitrary model-written Workflow execution. `rlh-base` omits `tool-workflow` and its package dependency while retaining `workflow-worker-thread` solely for `tool-ralph`'s deployment-owned fixed script. The shipped `standard` and `code` presets contain no generic Workflow tool. The Cordis-creation preset retains the generic tool as an explicit developer opt-in, and user-authored profile or preset composition can still mount it deliberately. The Workflow seam and worker implementation remain available; this decision narrows the unsafe Consumer without removing the safe fixed-policy Consumer.

Instruction candidates still support symlinks, but the resolved target must belong to an allowed root. The user-global candidate is confined to canonical `$RLH_HOME`; project candidates are confined to the canonical discovered project root. `additionalAllowedRoots` accepts explicit absolute roots for shared canonical instruction files and participates in `baselineIdentity`, so changing authorization revalidates a visible baseline. Host discovery resolves the candidate and allowed roots, checks containment, stats and reads the checked canonical target; provider discovery uses `FileSystem.resolve()` identities plus `FileSystem.contains()`. An off-root or non-file target is confirmed absence, so reconciliation removes a previously visible candidate; provider failures remain temporary unavailability.

This decision partially supersedes [unconditional instruction symlink following](../feature/2026-07-21-follow-instruction-symlinks.md) and narrows the default-composition part of [dynamic workflows](../feature/2026-07-05-dynamic-workflows.md). Same-root `CLAUDE.md → AGENTS.md` mirrors and explicitly authorized shared files remain supported.

## Alternatives considered

**Keep Workflow in ordinary presets and add a prompt warning.** Rejected because prompt text cannot enforce process authority. A model-written script that escapes `node:vm` has already bypassed the tool, approval, and sandbox seams.

**Delete Workflow entirely.** Rejected because the seam, journal, cancellation, and developer use cases remain valuable. Explicit developer composition states the trust choice without imposing it on ordinary sessions.

**Forbid every instruction symlink.** Rejected because same-root mirrors and operator-owned shared files are legitimate. Canonical target containment preserves those cases while closing implicit off-root disclosure.

**Leave read containment solely to `ctx.fs`.** Rejected because the shipped filesystem policy confines mutation but intentionally permits reads. `agent-instructions` owns automatic model admission and therefore must enforce its own source-admission rule.

## Testing

The base bundle test rejects the generic Workflow tool and dependency while requiring the worker and fixed Ralph Consumer. Shipped-preset tests reject the generic tool from standard and code while requiring it in the Cordis developer preset. Agent-instructions tests cover host and `ctx.fs` off-root rejection, explicit additional-root authorization, and invalid relative authorization roots; the complete package suite continues to cover baseline and reconciliation behavior.

## Consequences

Ordinary sessions cannot submit arbitrary model-written scripts to the non-sandboxing Workflow engine through shipped composition, while the fixed Ralph policy remains available. Developers retain an explicit opt-in and a future process/container Adapter can restore safe generic exposure without changing the tool Interface. Repositories cannot use an instruction symlink to admit arbitrary host-readable content into model history by default. Deployments that intentionally share instructions outside the project or Harness home must list the canonical containing root, and changing that list deliberately changes the durable baseline identity.
