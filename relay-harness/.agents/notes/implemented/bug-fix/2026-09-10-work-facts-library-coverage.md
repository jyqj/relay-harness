# Agent Note: Independent Work facts and persistent Library coverage gaps

Status: implemented

## Problem

A Goal phase does not determine whether an Agent or background Job is running, whether human input is pending, or whether a result has been reviewed. A single completion label conceals valid combinations such as a paused Goal with a running Job. Library pages can revisit the same Session, so their counts are not additive corpus coverage; a clean final page cannot establish that earlier unreadable Sessions or missing output capture were repaired.

## Decision

The existing current-Session Work projection publishes execution independently from Goal phase. Execution is running when the loaded conversation or visible Job list reports activity, idle when the conversation snapshot is available without active execution, and unknown without that snapshot. Approval and question counts remain separate. Failed and killed Job counts describe the current list, never an inferred overall task outcome. Unknown execution withholds review data and confirmation. The page exposes scope, pending input, and reviewable records even without a Goal; confirmation still uses the existing revision-bound Host API and durable verification.

Library accumulates output identity by the pair of source Session and exact recorded path. It retains boolean facts that any successful page reported missing capture or unreadable Sessions. Numeric counts remain attached to the latest page; the client does not sum them or invent unique-Session totals. A final cursor with either retained gap is labeled incomplete. Failed-page retry preserves the submitted query and cursor. An explicit restart or new search discards accumulated results and gaps. Read and native-open errors remain independent, and request generations reject late settlements.

## Alternatives considered

**Expand one completion enum.** This still forces orthogonal states into a precedence order and confuses Goal intent, execution, and review. Separate facts preserve simultaneous states without another task state machine.

**Sum page counts or trust the last page.** A Session can span multiple path pages, making summed counts misleading. Last-page-only reporting loses earlier gaps. Boolean observed-gap retention expresses exactly what the client knows without changing the Host wire format.

**Replace the main layout in the same change.** The Chat slot owner controls child registrations and draft lifetimes. Moving navigation without assembled browser verification would couple these correctness fixes to an independently risky migration. Work and Library remain sidebar pages.

## Consequences

No new Host method, Session event, persistence store, capability registry, or dependency is introduced. The public type-only Work summary uses an execution field rather than an aggregate completion field; its consumers and fixtures change together. Missing execution data is conservative, but this field is not a connection-freshness guarantee. Cross-workspace management and main-area navigation remain separate work.

## Verification

Projection regressions cover simultaneous Goal and Job states, missing bindings, review without a Goal, outcome-only changes, scope switches, and unchanged streaming snapshots. Scan regressions cover identity deduplication, preserved gaps, reset semantics, and non-additive counts. Component regressions cover review eligibility, durable same-revision retry, failed-page recovery, restart, and existing late-response behavior. Assembled browser snapshots, full client typechecking, and coverage remain required release evidence; the isolated Node assertion run is not a substitute for those checks.
