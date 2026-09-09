# rlh-atomic-write

English | [中文](README.zh.md)

Zero-dependency atomic file replacement shared by file-backed stores that must never leave partial, symlink-hijacked, or wider-than-intended content on disk — the user-settings document (`rlh-settings-file`) and the credentials store (`rlh-credentials-local`).

## Surface

```ts
import { withFileLock, writeFileAtomic } from '@relay-harness/rlh-atomic-write'

declare const text: string
declare const render: (previous: string) => string

await writeFileAtomic('/home/u/.rlh/settings.yaml', text, { mode: 0o600 })

// Read-modify-write against the same file from several processes.
await withFileLock('/home/u/.rlh/settings.yaml', async () => {
  await writeFileAtomic('/home/u/.rlh/settings.yaml', render(text), { mode: 0o600 })
})
```

`writeFileAtomic` commits one already-rendered string. The contract, in the order failures would exploit it:

- **Exclusive-create temp** (`wx`, random suffix): the open refuses to follow a symlink planted at a guessable temp path.
- **The fresh inode carries `mode` through the rename**: replacing a wider-permission file narrows it without a chmod race. `mode` is required so the permission decision stays visible at every call site (subject to the process umask, like every fresh inode).
- **`rename` replaces a symlinked target itself**, never writing through to its referent.
- **Same-directory sibling** keeps the rename on one filesystem, so the swap stays atomic.
- Parent directories are created; on any failure the temp is removed and the failure rethrown; readers observe either the old or the new complete content.

`withFileLock` serializes the writers of one file across processes, for the read-render-commit cycles a bare atomic commit cannot make safe on its own. The lock is a `wx`-created `<filename>.lock` sibling recording the owner pid and host, so readers never contend; waiters back off exponentially and fail with a timeout rather than block forever. `EEXIST` identifies contention directly; `EPERM` does so only when a fresh `lstat` confirms that the lock path exists, covering Windows exclusive-create behavior without hiding an unrelated permission failure. A contender removes the existing lock only when it can prove the lock abandoned — the recorded host is this machine and the recorded pid is dead (`ESRCH` from `process.kill(pid, 0)`); every other stale form keeps failing acquisition at the deadline instead of guessing.

## Model Experience

None, as this is a pure filesystem primitive; nothing here reaches a model request.

#### KV Cache effect

None; nothing here enters a request prefix.

## Known Limitations and Deferred Work

- **Atomic, not durable** — no `fsync` of the file or its directory, so after a crash the rename may be observed unwound. The file-backed stores here re-read and republish on boot, keeping durability the caller's policy.
- **String content only** — no `Buffer` or stream form until a consumer needs one.
- **Stale-lock self-heal is same-host and proof-gated** — a contender recovers a lock only when the lock records this machine's hostname and its owner pid is provably dead; a foreign-host lock (shared filesystem), an unreadable or malformed payload, a live owner, and a pid reused after a reboot all stay operator actions. File age alone is not safe evidence of abandonment.
