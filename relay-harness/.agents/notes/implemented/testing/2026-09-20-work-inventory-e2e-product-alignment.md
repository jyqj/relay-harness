# Agent Note: work-inventory browser e2e aligned with the shipped frame and record contracts

Status: implemented

English | [中文](2026-09-20-work-inventory-e2e-product-alignment.zh.md)

## Problem

`apps/web/tests/work-inventory.e2e.ts` failed on two assertions that no shipped build could satisfy, while the product behavior under test was correct and independently pinned by unit contracts:

1. **"uses the main area…"** read `getComputedStyle(gridTemplateColumns)` off the `AppFrame` element once, immediately after `data-surfaces-collapsed` disappeared. That attribute reflects the layout store's React state, which flips synchronously, but `.frame` animates `grid-template-columns` on the shared 300 ms collapse curve (`AppFrame.module.css`), so the single computed-style read sampled the start value (`0px`) and failed with "expected 0 to be greater than 0" every run.
2. **"queries and pages cross-session outputs…"** waited for `getByRole('heading', { name: 'Source record', exact: true })`. The record page renders its title copy (`record.title`) as the header eyebrow `<p>` and the inspected Session id as the only `<h2>` (`RecordPage.tsx`); no heading named "Source record" exists anywhere in the product, so the wait timed out even though the record route, the passive reads, the marker text, and the URL hash were all already correct.

## Decision

- The inspector assertion polls the computed track width until the animation resolves (`expect.poll(..., { timeout: 15_000 }).toBeGreaterThan(0)`). This keeps the original intent — the real frame, not a mocked layout callback, must allocate the opened inspector — while tolerating the shipped collapse animation; a frame that never allocates still fails the poll.
- The record-page wait targets `getByRole('heading', { name: OTHER_ID })` (both on open and after reload). The heading IS the selected source's Session id per `RecordPage.tsx` and `record.client.spec.tsx`, which pins that the heading shows the current route's source and never a stale one. Matching the id is therefore strictly stronger than matching a static page title: it proves THIS source opened, which is the test's stated goal ("preserves the selected source on open").

The product components were deliberately left unchanged: both the eyebrow-plus-id heading structure and the 300 ms grid animation are the shipped contracts, each pinned by their own unit or documented CSS behavior. The e2e file, introduced in the same recovered-tree commit as the components, encoded a DOM and a timing the product never had; its locators were the defect, not the invalidation or openHistory semantics that were initially suspected. The full file now passes 5/5 with P12 precise Library invalidation and P06 read-only `openHistory` in place, including the cold-confirmation round that exercises precise invalidation end to end.

## Consequences

- CI's web lane gets real signal again: the two failing scenarios now assert allocation and source identity that the product actually owns.
- Future layout work that changes the collapse animation or the record heading structure must update these assertions together with `AppFrame.module.css` / `RecordPage.tsx`; the locators are semantic (role plus route identity), not CSS-anchored.
- No product code, README, or locale changed; no snapshot goldens are affected.
