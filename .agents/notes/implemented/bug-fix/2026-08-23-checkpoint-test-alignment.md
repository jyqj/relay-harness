# Agent Note: Checkpoint test alignment and desktop-checkpoint regressions

Status: implemented

English | [中文](2026-08-23-checkpoint-test-alignment.zh.md)

## Problem

The integrated-desktop checkpoint left seventeen tests failing and its quality gates out of sync. `parseDshArgs` had gained `skipUserPlugins` without test expectations following. The dsh release family globbed `apps/*/package.json`, pulling the private, independently versioned desktop installer into the npm family and failing the `@deepseek-ai` name assertion. The new issue-orchestration panel CSS scrolled on an elevated surface without the scrollbar rebind. Four client behaviors regressed or drifted: the feedback popover's fixed layer lacked a no-drag hole, the route-level `defaultInput` editor promised by tests and locale strings was missing from `ProviderEditor`, `WorkflowRunPanel` stopped settling deferred phase closes because the disclosure exit transition kept focus inside the folding tree, and connection/subagent tests still asserted pre-checkpoint lifecycles (unary handshake, root-tree admission throwing with the caller's abort reason, debounced theme writes).

## Decision

Test expectations align with the checkpoint's intended contracts: launcher parses expose `skipUserPlugins` (with a true case); the dsh family excludes `apps/desktop`, which keeps its own installer version line; connection, wire-event, subagent, theme, settings-desktop, and disclosure-transition suites assert the new timing and admission semantics. Product fixes restore intended behavior: `.notePanel` gains `-webkit-app-region: no-drag`; `ProviderEditor` renders the route-level `defaultInput` modality editor with the inheritance hint, empty-value rejection, and disabled Apply; `WorkflowRunPanel.toggleRun` settles each phase's pending clean collapse when the run folds. `IssueOrchestrationPanel.module.css` rebinds the l2 scrollbar thumb tokens on its scrolling body.

## Alternatives considered

**Rename the desktop package into the `@deepseek-ai` scope.** Rejected: the workspace-constraint tool already carves `apps/desktop` out as a private application with its own version line; exclusion from the shared family matches that standing decision.

**Drop the `usePresence` exit transition to keep synchronous collapse assertions.** Rejected: the transition is the shipped 2026-08-14 web-motion behavior; the deferred-close settlement belongs in `WorkflowRunPanel` instead.

## Verification

Targeted runs of the fourteen previously failing test files pass (376 tests); full-repository typecheck, lint, and vitest re-ran clean after the batch; the release-family spec asserts desktop exclusion.

## Consequences

The repository's own gates pass on the fork again. Subagent pre-publication cancellation is now asserted through the admission seam's abort-reason contract rather than provider guards that root-tree admission makes unreachable.
