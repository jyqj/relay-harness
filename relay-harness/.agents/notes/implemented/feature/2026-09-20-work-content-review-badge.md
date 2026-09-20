# Agent Note: Work page content-review currency badge

Status: implemented

English | [中文](2026-09-20-work-content-review-badge.zh.md)

## Problem

The Host already exposed `workResults/contentReview` (latest recorded content review plus per-version currency) and the remote client binding existed, but no client surface rendered it: a user could not see whether a recorded content review still described the current files. The only visible acceptance signal remained the log-prefix record confirmation, which explicitly does not cover file contents.

## Decision

The Work page's review card renders a read-only content-review badge beside the record-confirmation badge. The page injects a `contentReview(sessionId, signal)` callback forwarded to `remote.workResults.contentReview`; the read is non-activating, fires once per session, handshake epoch, availability transition and explicit recheck, and follows the page's existing abort-and-generation rules, so a late reply from an older session or epoch never reaches the display.

The displayed state aggregates the per-version `currency` list to the worst entry: any `changed-unreviewed` wins, then any `not-reverified`, then `matches-confirmed`. Before the first review, when the read fails, or while the page is not synchronized, no badge renders — the absence is the honest state. The slice is display-only; recording a new content review (`recordContentReview`) has no UI and stays a follow-up. The Host's read applies no fresh file observation, so a live read currently reports `not-reverified` for every confirmed version; the aggregation still handles all three states because a caller-side or future Host-side fresh observation flows through the same read contract.

## Alternatives considered

**Rendering each confirmed version as its own row.** Rejected for this slice: the review card stays compact, and per-version identity matters once submission exists; the worst-state aggregate is sufficient to answer "can I trust the confirmed review".

**Neutral "no content review yet" line.** Rejected: the confirmation badge already communicates "unreviewed" for the log record, and a second idle-state line invites reading content-review absence as a record-confirmation fact.

**Applying `contentCurrency` client-side against locally observed files.** Rejected: the browser has no authoritative file observation, and fabricating currency states from tool-call history would repeat the record-confirmation overclaim this domain was built to avoid.

## Consequences

Users see one of three bilingual currency labels next to the record-confirmation badge, or nothing when no review exists, the read fails, or the page is not synchronized. The badge is passive: it never blocks the confirm action and adds no polling loop. Future submission UI can reuse the same injected read to refresh the badge after `recordContentReview` succeeds.

## Verification

`packages/client/ui-product-shell/tests/content-review.client.spec.tsx` pins the worst-state aggregation for every currency input, no badge before the first review or on a failed read, and that an older-handshake reply is aborted and cannot corrupt the current badge. `packages/client/ui-product-shell/tests/apply.client.spec.ts` forwards the injected callback to `remote.workResults.contentReview` with the exact request and signal, including the denied-envelope path. `node_modules/.bin/tsc -b packages/client/ui-product-shell` is clean.
