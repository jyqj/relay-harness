# Agent Note: Tool resource intents and fair read/write locks

Status: implemented

English | [中文](2026-08-21-tool-resource-intent-locks.zh.md)

## Problem

The unary `isConcurrencySafe(args)` contract can declare a call globally parallel-safe or exclusive, but cannot express the common relation “different files may overlap; the same file must not.” Filesystem write, edit, and the combined string-replace editor therefore remained exclusive, serializing unrelated paths, while simply marking them parallel would race same-target effects and observation policy.

Resource identity must come from the provider-resolved target, not a guessed argument name or raw path spelling. Cancellation while waiting must remove the waiter, and calls claiming several resources must not deadlock.

## Decision

`ToolDefinition.resourceIntents(args, exec)` is an optional typed pre-dispatch resolver. Declaring it opts the call into the parallel pool. It runs after `tools/pre-execute`, approval, and monotonic guards, may perform identity lookup but no resource mutation, and returns canonical namespaced `{ key, access: 'read' | 'write' }` claims. Resolution errors become post-execute tool failures; cancellation before or during resolution remains `ABORTED_BEFORE_DISPATCH`.

`ToolRuntime` owns one fair read/write lock table shared by native calls, direct `execute()` calls, and Code Mode nested dispatches. It normalizes duplicate claims with write dominance, sorts keys before acquiring them, and holds every lease only around the tool body. Same-key reads overlap; a writer excludes readers and writers; a queued writer prevents later readers from bypassing it. Cancellation removes a queued waiter synchronously, releases already-acquired multi-key leases in reverse order, and never invokes the waiting body. Action failure and cancellation release every lease.

`dsh-tool-fs` resolves read, write, and edit claims through `ctx.fs.resolve()` with the same per-session cwd semantics as the body, then namespaces the provider `FsTargetKey` under `fs:`. Read claims are shared and mutation claims exclusive. `dsh-tool-str-replace-editor` uses the same namespace and provider key, with `view` as read and its three mutation commands as write. The existing filesystem intent/CAS policy still runs inside the lock. Consequently, two same-session edits can both land serially: the second policy decision observes the first committed version instead of failing with an avoidable stale-version race.

The request tool snapshot captures the resource resolver with the rest of its definition. Registry replacement cannot change a sampled call's resource behavior.

## Alternatives considered

**Keep every mutation globally exclusive.** Rejected because unrelated files pay unnecessary latency and large multi-file changes cannot use the existing bounded pool.

**Guess file keys from conventional argument names in the scheduler.** Rejected because tools use `file_path`, `path`, nested objects, remote identifiers, and provider-specific resolution. The owning tool and provider are the only reliable identity boundary.

**Lock raw path strings.** Rejected because relative/absolute aliases, symlinks, and provider normalization can name the same target differently. Filesystem tools lock the resolved `FsTargetKey`.

**Place locks only inside `dsh-tool-fs`.** Rejected because the standalone string-replace editor and future tools must coordinate with the same files, and Code Mode must share native locking semantics.

**Acquire resources during ordered prepare.** Rejected because a blocked same-key call would hold the scheduler's ordered lane and prevent later independent keys from filling the pool. Intent resolution stays ordered; acquisition occurs in the overlapping dispatch stage immediately before the body.

## Consequences

Different filesystem targets may execute concurrently while same-target reads and mutations follow one fair order. The tool runtime gains a general resource vocabulary without hardcoding filesystem concepts. Tools that declare incorrect keys can still race; the callback is a trusted capability contract, and first-party filesystem tools derive keys from the provider.

Locks coordinate participating tool bodies in one `ToolRuntime`. Shell commands, external processes, and tools that do not declare the same key remain outside this mechanism. A resource resolver adds one provider identity lookup before dispatch; filesystem bodies still resolve again for their actual operation and retain their existing sandbox and stale-observation enforcement.

