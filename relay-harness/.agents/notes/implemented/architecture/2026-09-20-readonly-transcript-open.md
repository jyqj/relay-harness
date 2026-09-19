# Agent Note: Read-only transcript open without agent activation

Status: implemented

English | [中文](2026-09-20-readonly-transcript-open.zh.md)

## Problem

Opening an existing session's transcript and starting or continuing work in it share one client service verb, `ISessions.open`. Nothing in the face distinguishes a read-only inspection from a work-session open, so a consumer that only wants to view a transcript reaches for the same path a continuation uses, and the guarantee that a cold session stays unmaterialized lives only in host-side implementation details, not in any contract a consumer can rely on or a test can pin.

## Decision

Add `ISessions.openHistory(sessionId)` as the explicit read-only transcript open: it stages the selection like `open()`, resolves once the history window is installed, and its contract is the non-activating `session.history` read only — never `session.create` and no prompt or queue traffic. On the Host, `session.history` already serves attached sessions from memory and cold sessions from persistence inspection (`historySourceFor`), so the client-side seam plus one host-side guard test pins the whole path: a cold open materializes no Session and no Agent, resumes nothing, and starts no input processing. Live tailing needs no separate attachment protocol: the Host pushes events only for sessions it already runs, so a cold window is naturally a snapshot, and a live session receives passive tail frames without this path causing the run. Work, Library, and record source-session navigation in ui-product-shell use `openHistory`; start/continue-work flows keep `session.create`, whose semantics are unchanged.

## Alternatives considered

**A separate read-only view runtime.** The object layer already renders a cold window from the same history page (`openState`, projection seeding, page-back), and a second transcript pipeline would duplicate conversation assembly to save one selection write.

**Making `open()` itself promise non-activation.** That would freeze the workbench open against any future need to attach or resume at open time and would not give consumers a written distinction between the two intents.

## Consequences

`ISessions` widens by one method, so the test-support sessions double implements it (recorded like `open`, settling immediately). `openHistory` returns a promise while `open` stays synchronous and void; a consumer that ignores the promise keeps today's fire-and-forget behavior. Continuation from a cold read-only window still requires the user's explicit send, which rides the live resolver (`session.prompt`) and is where activation belongs.

## Verification

`api-proxy-cold.spec.ts` proves the Host half: with the full proxy, agent registry, and cold-resume lookup mounted, `session.history` on a persisted session serves the log while `ctx.agents.resume`/`ctx.agents.create` go uncalled and no Session or Agent materializes. `sessions-service.client.spec.ts` proves the client half: `openHistory` stages, resolves with the window installed, issues only `session.history` (never `session.create`), re-pulls nothing on a repeat open, and fails loud on unknown ids.
