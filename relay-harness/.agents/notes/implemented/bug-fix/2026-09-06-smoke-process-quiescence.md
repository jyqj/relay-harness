# Agent Note: Smoke process quiescence

Status: implemented

English | [中文](2026-09-06-smoke-process-quiescence.zh.md)

## Problem

Rejecting a timeout immediately after SIGTERM lets Electron remain alive, restart helpers, and retain pipes or profile files. An owner exit alone also does not prove that observed detached runtime groups have stopped.

## Decision

Source and packaged smoke share one process runner. POSIX observation requires `ps`; the runner records descendant groups while the owner is alive, checks known leader identity before signaling, applies TERM then bounded KILL escalation, and waits for output closure and observed-group quiescence. Zombies do not count as executing workers. Windows uses tree termination through `taskkill`. Failure to establish quiescence preserves the profile and is reported explicitly.

The runner controls the original group and observed descendant groups, not arbitrary daemons that escape observation. Application-owned runtime shutdown remains responsible for its lifecycle; smoke does not claim a kernel containment primitive.

## Verification

Real subprocess regressions cover output draining, spawn failure, a TERM-resistant owner with a separate worker group, and an owner returning zero while an observed worker remains alive. Native application smoke is a separate check of the assembled application.

## Alternatives considered

Returning on the owner's exit ignores retained output pipes and detached groups. A single TERM request does not terminate a resistant application. Deleting the profile before quiescence races the running application and destroys failure evidence.

## Consequences

Timeout remains a failed smoke even if shutdown eventually returns zero. The runner does not label forced cleanup as application success, and it does not treat another platform's unit result as native process evidence.
