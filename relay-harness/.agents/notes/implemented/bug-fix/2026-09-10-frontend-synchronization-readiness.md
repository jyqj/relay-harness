# Agent Note: Frontend synchronization readiness and action lifetimes

Status: implemented

English | [中文](2026-09-10-frontend-synchronization-readiness.zh.md)

## Problem

A retained Session object is not proof that its history is loaded or that its connection is current. An unchanged log revision after reconnect cannot validate a receipt checked against the previous Host handshake. Library cursors also belong to a previous scan and cannot safely survive a new connection generation. Separately, root workflows install pnpm before running shell commands; a shell working-directory default cannot locate the nested package manifest for that action.

## Decision

The existing Connection service publishes a read-only readiness source separately from Host capabilities. Its epoch advances for each successful description handshake; its phase does not become ready until the connected consumer finishes asynchronous synchronization. Stop, reconnection, and synchronization failure withdraw readiness. Loop ownership checks surround all reentrant publication points and late asynchronous settlements. Plugin disposal stops the owned stream.

Work combines connection readiness with its Session history open state and removal flag. Retained results remain readable but cannot be opened or confirmed without both sources being ready. Receipt verification is keyed by Session, log revision, and handshake epoch; an old success cannot validate a new generation. No operation is automatically retried as a mutation on reconnect.

Library preserves its unsubmitted search draft while restarting only the last submitted query from the first page after synchronization. It does not carry an old continuation cursor into the new generation. Old query and native-open settlements lose publication authority. Existing source-identity deduplication and observed coverage gaps remain scoped to a scan.

Every pnpm setup action names `relay-harness/package.json` explicitly. The dependency-free repository governance check validates each action's own block-style inputs before installation. The focused frontend workflow executes the affected tests without replacing or weakening the full CI matrix.

## Alternatives considered

**Infer readiness from Host description presence.** The description arrives before the consumer reloads its baselines, so this would allow operations during synchronization. Capabilities and synchronization remain separate observable facts.

**Use a loaded object or a cached receipt as authority.** A history window can be cold, loading, failed, or removed while the object still exists. A previous handshake's durable verification is not a new verification. Explicit readiness and epoch checks retain these distinctions.

**Replay all pending actions or preserve the Library cursor.** Replaying a command can repeat an already-admitted mutation, while the old cursor may name a changed corpus. Only read-side refresh restarts automatically; mutation recovery remains explicit.

**Hardcode the pnpm version in each workflow.** This creates another version source beside the project's packageManager field. Explicit action-owned manifest paths reuse the pinned project version instead.

## Consequences

No Host endpoint, authorization policy, Session event, or persistent task store is added. The Connection handle gains a required client-only observable; typed fixtures include it. Work and Library remain sidebar pages. Ready means consumer synchronization resolved, not that all optional sources succeeded or both downlinks are established; Work additionally requires its own open history window. Full browser and artifact checks remain distinct from component tests.

## Verification

Connection tests exercise pending synchronization, replacement, stop, disposal, subscriber reentrancy, and late rejection. Work tests exercise unavailable history and epoch-bound receipt verification. Library tests exercise retained drafts, first-page reconnect, cursor retirement, and old responses. The assembled Work example checks a real browser downlink loss, disabled operations, recovery, and absence of an implicit confirmation event. Workflow fixtures reject misplaced paths, shell-default substitutes, and borrowing another action's inputs.
