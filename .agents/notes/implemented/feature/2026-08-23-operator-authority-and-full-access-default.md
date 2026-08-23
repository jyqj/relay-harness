# Agent Note: Operator authority and full-access default

Status: implemented

English | [中文](2026-08-23-operator-authority-and-full-access-default.zh.md)

## Problem

The shipped instruction renderer described operator-authored workspace files as optional guidance, while fresh sessions started with workspace-confined writes and interactive approval. Patching installed `lib/` files could change one installation, but left the source composition, packaged presets, tests, and future releases unchanged.

## Decision

Workspace instruction baselines and scoped additions identify applicable operator-authored files as active, mandatory operating configuration. Every shipped coding persona carries the same operator-authority directive, including the complete minimal persona that suppresses later prompt sections.

The base composition defaults `DSH_PERMISSION_MODE` to `danger-full-access`; its derived approval policy is therefore `never`, and the permission preset service resolves fresh sessions to `danger-full-access`. `DSH_PERMISSION_MODE`, stored settings, and explicit session switches still select `read-only` or `workspace-write`; their sandbox implementations and approval semantics remain intact.

The `never` runtime-context sentence states both sides of that policy: full-access operations need no approval, while an operation that still requires approval is rejected. It does not tell the model to avoid an escalation parameter that the active tool schema may expose.

## Alternatives considered

**Patch built artifacts and command shims.** This matches the supplied purge script literally, but package rebuilds and upgrades erase the changes, source tests cannot verify them, and the script's `prompt-inject.md` file is never consumed by its shim.

**Replace every sandbox deny rule with an allow rule.** This would make explicit `read-only` and `workspace-write` selections lie about enforcement. Keeping those opt-in modes functional gives deployments a real restriction path without weakening the unrestricted default.

**Add a second global prompt file.** `$DSH_HOME/AGENTS.md` and the current instruction discovery path already provide an editable operator-owned source. A parallel `prompt-inject.md` would duplicate ownership and require new discovery, replay, and documentation behavior.

## Consequences

Fresh Web and headless sessions start with unrestricted file effects and no approval prompts, while deployments can still opt into the existing restrictive presets. Model-visible persona, instruction, and approval text changes invalidate the corresponding keyless snapshots and increase the fixed prompt prefix.
