# Agent Note: Preserve filesystem change scope through local code-index refresh

Status: implemented

English | [中文](2026-08-29-code-index-scoped-refresh-and-ignore-lifecycle.zh.md)

## Problem

The public `RefreshOptions.paths` claimed to restrict a pass, but the runtime dropped it and every stale refresh walked and diffed the full workspace. The recursive watcher also discarded native filenames before debounce. In addition, the scanner loaded only the root `.gitignore` once per provider lifetime, so nested ignore rules and edits to the root rules were invisible. These were lifecycle correctness gaps rather than ranking gaps: the seam advertised a scope it did not honor, generated-output directories could pollute the index, and a watcher event carried less information after crossing the provider boundary than at its source.

Source-verified hydration had a related containment gap. Lexical `resolve`/`relative` checks reject `..`, but a parent directory replaced by a symlink could make the current backing path escape the workspace before hashing.

## Decision

`RefreshOptions.paths` is normalized at the runtime boundary into unique workspace-relative POSIX paths. Workspace escapes fail loud, a root path deliberately widens to a full pass, and an empty list is a real no-file scope. The scanner prunes directories that cannot contain a requested file or prefix; the indexer diffs and removes only the matching slice of the committed generation. Directory scopes cover all descendants, so a deleted directory event removes its indexed subtree without touching unrelated rows.

The recursive watcher retains filenames, deduplicates and unions them across its debounce window, and passes the scope through `StaleInvalidator` into the stale refresh. A source that cannot name a path widens to a full pass. Tool results remain authoritative full invalidations because tool result events do not carry trustworthy touched paths. `.gitignore` events also widen to a full pass because one rule edit can change arbitrary descendants.

The scanner owns ignore discovery on every pass. Hard/config exclusions remain independent static layers; root and nested `.gitignore` documents form one ordered hierarchy whose deepest matching rule wins, including child negation of an ancestor file rule. An ignored directory is pruned before its own document could be consulted, matching Git's inability to re-include a file below an excluded parent.

Hydration now resolves both workspace root and candidate source through `realpath`, proves canonical containment, and hashes the canonical current file. Parent-symlink escapes therefore return `source-path-invalid` even when an outside file happens to share the indexed hash.

## Alternatives considered

- **Keep full scans and remove `RefreshOptions.paths`** — rejected because the watcher already supplies usable scope and the reference build lifecycle proves event-scoped admission is viable.
- **Trust only watcher paths** — rejected because events can omit filenames and tool effects carry no path contract; both widen to a full diff.
- **Load nested ignore files into independent boolean exclusion layers** — rejected because a union cannot represent a deeper `!` rule overriding an ancestor file rule.
- **Use lexical containment for hydration** — rejected because it does not constrain symlinked path components.

## Consequences

Native file storms avoid unrelated traversal, hashing, parsing, and removal work. Full manual/lazy/tool-result passes remain available and authoritative. Ignore files cost no blind read per directory: the walker reads one only when the directory listing contains `.gitignore`. Selected changed files now use deterministic bounded read/parse concurrency, and refresh scopes arriving after scanning begins merge into one follow-up generation. Unsafe configuration events still require full traversal. BuildExplain, embedding generations/batching/clocks, independent vector recall, and executable Recall/MRR/p95 gates are implemented by the later code-index notes.
