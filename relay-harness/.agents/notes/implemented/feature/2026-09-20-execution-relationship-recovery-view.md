# Agent Note: Execution relationship and recovery capability facts in passive Work views

Status: implemented

English | [中文](2026-09-20-execution-relationship-recovery-view.zh.md)

## Problem

The passive `inspect` Work view listed executions as a flat set. It recorded residency and a coarse `recovery` word per entry, but a reader could not see how each execution relates to the addressed Work — delegated child, continuable reporter, fork origin — nor what recovery can honestly promise per entry. Worse, nothing separated graph adjacency from control: a cold continuable child looks related, and a reader may assume the Host can therefore act on it, when in fact only present residency carries any control.

## Decision

Each `WorkExecutionEntry` in the [work-results](../../../../packages/host/work-results/README.md) inspect view carries two optional facts derived only from state the existing owners already publish — durable session headers, the subagent catalog's descriptor classification, and in-process Job status:

- `relationship` names the edge toward the addressed Work. `owned` marks the Work's own plain root or an in-process Job; `delegated` marks a one-shot catalog child and a Work whose own root carries a `subagent` origin header; `reports-to` marks a continuable child, the one kind holding a durable report channel back to its parent; `forked-from` marks a Work whose root was forked from a parent. `controlLink` is the separate control observation: true only while the Host registry holds that exact execution live. Adjacency never sets it.
- `recoveryCapabilities` states what recovery can honestly promise. `history` is `persisted`, `in-process`, or `unknown`; `resume` is `explicit` only on a durable continuable descriptor or an ordinary cold Session, `unavailable` for one-shot children and Jobs, and `unknown` without evidence; `control` mirrors residency. An unclassified (corrupt) child reports `unknown` across the row rather than any claim. The derivation derives from the descriptor alone and never consults the activation lease store, so `resume: 'explicit'` promises a resume path exists, not that a lease is currently free. External one-shot providers publish no session-backed descriptor, so they produce no entry and no claim.

The derivation lives in `execution-facts.ts`; `work-view.ts` only gathers inputs. The compact `recovery` field keeps its values and consumers.

## Alternatives considered

- Model control as a property of the relationship kind: a `delegated` edge would then silently claim control over live children and deny it over cold ones. Splitting `controlLink` out keeps the two facts independently truthful.
- Consult the activation lease store for a stronger resume verdict: work-results would depend on the subagent package's internal lease mechanism, and a free lease still does not make resume authorized (it needs a live parent). The descriptor is the durable capability evidence; the lease governs concurrent takeover only.
- Enumerate fork-origin descendant sessions as entries with a `forked-from` edge: the existing catalog interprets only `subagent`-origin headers, and enumerating ordinary forks would make the passive view a new session-graph authority. Fork lineage stays a fact of the addressed root's own header.
- Encode the matrix as prose wording per entry (for example "history only, not controllable"): free text is locale-hostile and untestable; the closed value sets say the same thing and the UI renders them.

## Consequences

The Host tests derive relationship and recovery rows through the real HTTP `inspect` endpoint against live roots, cold fork/delegation roots, and persistence-authored continuable, one-shot, and corrupt children; pure unit tests pin the derivation table. The Product Shell record page renders the edge kind and resume word when present and unchanged rows when absent. Consumers of the old `recovery` field are unaffected. The matrix stays honest only while its inputs stay honest: a future catalog entry kind or Job status must extend `execution-facts.ts` rather than widening the view at the consumer.
