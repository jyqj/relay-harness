# Agent Note: Explicit context retrieval and passive work inspection

Status: implemented

English | [中文](2026-09-19-explicit-context-passive-work.zh.md)

## Problem

The current product mixes execution activation with historical reads and asks whole provider messages to fit budgets their producers did not observe. Active retrieval needs real model dispatch without fabricated user input, while Work and Library need source-specific reads and honest partial coverage. The default branch is main, but several inherited workflow triggers still name master.

## Decision

Keep Cordis, the Agent loop, Session authority, provider registries, existing Subagent leases and client object projections. Extend the existing Context Engine with an explicitly opted-in tool purpose, independent candidate batches, source-local cumulative budgets and complete-render fitting. Mount `retrieve_context` in base/standard composition. Code, file, current-Session history, governed memory and exact MCP resource reads retain their own scope rules. No second engine or task database is created.

Expose passive `workResults/inspect`, `history` and `review` operations. Source records, ordinary forks, delegation, Goal phase, execution, missing observations and confirmation scope are distinct. Product navigation carries exact source identity and uses route/connection-generation cancellation. Existing active conversation APIs remain for interactive actions. Library reuses the existing deliverables projection cache and retains bounded corpus observations instead of repeatedly scanning global revisions per page. Workflow push conditions target main and preserve the nested project manifest.

## Alternatives considered

**A new Work database or universal command bus.** The required reads already have authoritative owners. Duplicating writable lifecycle state would add reconciliation without proving output quality.

**Automatic retrieval disguised as model-facing tooling.** A service method alone is insufficient; the new tool is mounted, advertised, dispatched and logged through the actual Agent loop, then consumed by its next request.

**A global atomic snapshot across domains.** Separate Session, Goal, job and provider clocks do not establish one transaction. The response carries source cuts and coverage instead.

## Consequences

Explicit retrieval changes tool catalogs in the compositions that mount it. Whole-message providers remain compatible, but tool retrieval requires explicit opt-in. Code recall does not serve a different execution filesystem through a matching cwd. Bounded history renders final text only; persistence may still decode the whole source. Library observations expire and report omitted/unreadable sources instead of claiming exhaustive current device coverage.

This change does not implement persistent Job scheduling or forced-stop reconciliation, immutable output blobs or file-content acceptance, a global interaction inbox, complete API Proxy removal, or public remote authentication. Existing log-prefix confirmation remains unchanged. These RFC items must not be represented as completed by the new record page or source descriptors.

## Verification

Focused engine/provider/tool tests cover budgets, batch selection, scope and cancellation. The real AgentLoop test invokes `retrieve_context` over a local index and proves one logged result enters the next request without duplicate user input. Trusted HTTP tests cover passive cold reads, existing durable confirmations and retained Library pagination. React tests cover read-only navigation, older pages, hidden reads, reconnect generations and failures. Build, generated API, native lint, coverage and assembled browser outcomes are recorded separately in the pull request; passing a focused suite is not evidence that every gate passed.
