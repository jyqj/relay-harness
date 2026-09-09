# Agent Note: Desktop config quarantine and port-kill ownership

Status: implemented

English | [中文](2026-09-03-desktop-config-quarantine-and-port-ownership.zh.md)

## Problem

Two desktop main-process defects destroyed user property outside the desktop's own ownership. `readJson` in `apps/desktop/src/main/config.js` caught every read failure identically: a corrupt `config.json` or `credentials.json` silently reset the affected fields to defaults, and the next `saveConfig` wrote the regenerated files over the corrupt originals, making the user's bytes unrecoverable. Separately, `ensureOwnedPort` answered an HTTP-200 probe on the wanted port (default 3080) by killing every `node`/`rlh` image listening there with `taskkill /T /F` (Windows) or a group signal (POSIX), and `_doStop` repeated the sweep unconditionally on every stop. A user's unrelated dev server on node was killable — with its whole process tree — by merely starting or stopping the desktop app.

## Decision

`readJson` now branches on the error: a missing file (`ENOENT`) still falls back silently — that is the normal first-launch state — while any other failure logs the file name and reason to stderr, quarantines the original to `<file>.corrupt-<timestamp>` beside it (best-effort; a rename failure is logged and never blocks startup), and then falls back. Quarantine is the load-bearing half: without it the fallback alone would still lose the bytes on the next save.

Port handling now requires proof of ownership. `ensureOwnedPort` kills only the pid recorded in `rlhd-web.pid`, and only while `isSafeToKill` accepts it; any other listener on the port causes the existing port hop. The `httpReady` probe branch, the `listeningPids`/`killOwnedListeners` sweep, and the `RlhManager` `killOwnedListeners` dependency are deleted. `spawnHarness` passes `detached: true` on POSIX so the child leads its own process group and `killTree`'s negative-pid signal reaches the whole descendant tree; Windows keeps `taskkill /T /F`.

## Alternatives considered

**Keep the sweep but narrow the image match.** Rejected because image-name matching is not ownership: the bug is killing processes the desktop cannot attribute, and any matcher loose enough to catch a leftover rlh whose pid file was lost is loose enough to catch a user's dev server. The pid file already covers the realistic crash-leftover case.

**Auto-delete corrupt files instead of quarantining.** Rejected because deletion is exactly the loss the fix removes. A `.corrupt-<timestamp>` sibling costs nothing on a rare path and preserves the evidence.

**Make the kill port range or image list a Config field.** Rejected because the decision removes the discretionary kill surface rather than tuning it; ownership proof needs no deployment-varying parameters.

## Consequences

A corrupt config or credentials file still boots the app on defaults, but the event is loud on stderr and the original bytes survive for manual recovery; `.corrupt-<timestamp>` files accumulate in `userData` on the rare corruption path. A user who previously relied on the desktop killing a stray node process from port 3080 sees a port hop instead — that reliance was the defect. Stopping the desktop no longer touches foreign listeners. Because the child now leads its own process group on POSIX, group kills cover the full descendant tree, and the child no longer receives signals aimed at the desktop's process group (the Electron GUI main process has no controlling terminal, and child lifecycle stays managed by explicit `kill`/`killTree`). Tests inject the process seams of `ensureOwnedPort` (`probePort`, `readPidFile`, `processAlive`, `killTree`, `findFreePort`, `clearPidFile`) and pin the group-lead contract through `process.kill(-pid, 0)` rather than the removed sweep.
