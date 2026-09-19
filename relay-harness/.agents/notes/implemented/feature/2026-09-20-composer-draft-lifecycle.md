# Agent Note: Explicit composer draft lifecycle

Status: implemented

English | [中文](2026-09-20-composer-draft-lifecycle.zh.md)

## Problem

Composer input is user data, but its survival rules were implicit. The per-session input machine holds the live draft and mirrors it into the session chat store, so route switches and reloads already keep it — yet a Session-scope teardown with unsent input destroyed that input silently: the slots framework's `pruneStoreScope` cleared the persisted chat state and nothing surfaced what was lost. There was also no answer to what a draft is while the connection is down, and no explicit discard verb. RFC §5.4 requires the opposite posture: navigation never submits or loses a draft, a disposed target's draft is surfaced as discarded (never silently shown as live input), and connection epoch changes never wipe input.

## Decision

The conversation package owns a three-part lifecycle over the existing persistence rather than a second draft store.

Live drafts keep exactly the persistence they had: the per-session chat-store mirror keyed by Session identity (`rlh.conversation.chat.<sessionId>`). Navigating between conversation, Work, and Library neither submits nor touches it — hidden main pages keep the composer mounted.

Discarded drafts live in a root-scoped `DiscardedDraftRegistry` (`input/drafts.ts`), persisted under `rlh.conversation.drafts.discarded` and bounded to the newest entries. At scope teardown the InputHub captures the draft's clipboard projection before disposing the shell; a non-empty projection becomes a tombstone keyed by Session id. Drafts carried or cleared before teardown (Workspace switches) record nothing, and a successful submit records nothing because the machine already cleared the draft. When the session is live again, `ConversationRoot` reads the per-session face from the inject hooks and renders a discarded notice above the composer with explicit restore (registry tombstone out, text written through `inputActions.setDraft`) and discard (tombstone dropped) actions. The tombstone is never seeded into the composer as live text, and the registry persists across reloads so a draft discarded while the page was closed still surfaces on reopen.

Connection epoch changes treat the draft as inert, not gone: `apply` flattens the connection readiness face to a `connected` observable in the composer-bar inject hooks, and InputBar holds submission (send button disabled, Enter no-op) while it is false, leaving the textarea editable and the draft intact until the target is writable again. A readiness-less composition (object-layer boots) stays ready — absence never locks the composer down.

## Alternatives considered

- Extend the per-session chat store with a lifecycle field: the instance and its persisted state are destroyed by `pruneStoreScope` at exactly the moment the discarded mark must survive, so the tombstone needs an owner that outlives the session scope.
- Delete discarded drafts as before and rely on the transcript: silently destroying typed input is the failure the lifecycle exists to prevent.
- Wipe drafts on `connection/reset`: user text is not generation-scoped state; wiping it punishes a transport event, and failing at the sink instead of holding gives the same loss with an error banner.
- Reuse the ui-product-shell `workAvailability` helper: the product shell peer-depends on this package, so the import would invert the dependency direction; the composer only needs readiness flattened to a boolean.

## Consequences

Unsent input now survives every lifecycle path that previously destroyed it, at the cost of one persisted root-scoped record (bounded) that can outlive its session by design. The discarded notice is conversation-package presentation; other surfaces addressing a disposed session (the passive record page) intentionally show no composer and therefore no tombstone. Submission while disconnected holds silently at the affordance instead of failing at the sink, so the send-failed toast path now only covers genuine admission failures.

## Testing

`packages/client/ui-conversation/tests/draft-lifecycle.client.spec.tsx` covers the registry contract (empty-input refusal, restore, dismiss, bounding, reload persistence), tombstone creation at scope teardown over the real hub and sessions runtime, the no-tombstone paths (submit success, carry-clear), and the root surfacing with restore/discard wiring in `tests/skeleton.client.spec.tsx`. The inert-but-intact offline draft is pinned in `tests/input-bar.client.spec.tsx`, including resubmission of the same draft once ready. Route identity remains draft-free by construction in `packages/client/ui-product-shell/tests/navigation.client.spec.ts`.
