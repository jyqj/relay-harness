# Agent Note: Capability healthy `yes` requires every assembled row accounted for

Status: implemented

English | [中文](2026-09-20-capability-healthy-requires-full-inventory.zh.md)

## Problem

The capability report's healthy level (`@relay-harness/rlh-host-plugin-inventory`, `report.ts`) joined the Loader inventory by iterating the capability's assembled composed rows and collecting the entries that matched. A row whose inventory entry was absent was silently skipped: with a multi-entry capability — web-search assembles `web-search-deepseek` and `tool-web` — an inventory that observed only one of the two still produced healthy `'yes'`, and the folded `effective` state claimed `running`. Health was asserted on partial evidence, the same AND-hole shape the report's other levels already guard against.

## Decision

- `healthyLevel` tracks assembled rows that match no Loader inventory entry (by `entryId` or `moduleName`) and reports healthy `'unknown'` when any exist, with the reason naming the first unmatched row and the accounted fraction. A healthy `'yes'` requires a matching, active Loader entry for every assembled row.
- The pre-existing checks keep their order and meaning: a disabled composed row still reports `'no'` without runtime evidence, a missing runtime dump still reports `'unknown'`, and the empty-rows case still falls to the existing "no Loader entry matches" unknown.
- `effectiveState` needed no change: an `unknown` healthy level folds to `standby`, never `running`.

## Alternatives considered

**Report `'no'` instead of `'unknown'`.** Rejected: absence of evidence is not evidence of failure. The report's standing posture — levels whose evidence the input does not carry are `unknown` with the reason, never guessed — already covers this case; `'no'` would overstate what the dump shows.

**Also scan inventory rows that match no assembled row and degrade on them.** Rejected: the inventory lists every non-group Loader entry in the host, most of which belong to other capabilities or to none of the catalog's concern. The join is per capability, so extra inventory rows are expected and must not degrade an unrelated capability's level; the test fixtures pin that behavior.

## Consequences

- A dump whose inventory is truncated, stale, or filtered can no longer report a capability as healthy or running on a subset of its entries; it reports `'standby'` with an evidence string that names the unaccounted row.
- Reports with complete runtime evidence are byte-identical to before; only the partial-evidence path changed.
- Regression coverage: the plugin-inventory report spec assembles web-search with only one of its two inventory rows present and asserts healthy is `unknown`, not `'yes'`, with the second entry named in the reason.
