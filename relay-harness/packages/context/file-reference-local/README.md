# `@relay-harness/rlh-file-reference-local`

English | [中文](README.zh.md)

Local-filesystem implementation of `ctx.fileReferences`. It maintains one bounded `WorkspaceFileSearch` per agent, rooted at that session's `cwd` and falling back to the host process cwd. The index ranks direct directory listings for queries containing `/`, otherwise fuzzy-ranks a bounded recursive index; it never follows directory symlinks.

Tool-result events invalidate the addressed agent's reusable index so later completion observes likely workspace mutations. Agent disposal releases that index and its scoped prompt contribution; plugin disposal awaits every prompt fiber and releases all cached searches.

When the optional `fileContent` section is present, the provider also registers one context-engine step-context contributor (`file-reference-content`, late-bound through `ctx.inject(['contextEngine'])`, so the engine stays optional). For each step it collects every distinct `@file` mention across the claimed direct user messages and contributes one `file-reference` recall message with read-only snapshots of those files; a step without mentions contributes nothing. Mentions that are missing, not regular files, or unreadable are recorded with an `unavailable` reason in both the message and its source record instead of being dropped.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `maxResults` | `20` | Maximum ranked candidates returned for one query. |
| `maxEntries` | `10000` | Maximum files and directories indexed per agent workspace. |
| `excludedDirectories` | `[".git", "node_modules"]` | Directory basenames omitted from traversal and candidates. |
| `fileContent` | absent | Presence enables mentioned-file content injection. |
| `fileContent.maxFileBytes` | `65536` | Maximum content bytes included from any one file. |
| `fileContent.maxTotalBytes` | `262144` | Maximum total content bytes included from all files of one step. |

Every numeric value must be a positive safe integer. Excluded names must be non-empty basenames without `/` or `\`. With the section absent no contributor registers and file mentions stay ordinary prompt text; once a file exhausts the total budget, later mentions of that step are recorded as `truncated` with the reason `total budget exceeded`.

## Model Experience

### File-reference guidance when `read` is available

#### What the model sees

When the addressed agent has an effective `read` tool, the provider contributes this stable system-prompt section:

##### File-reference instruction

```markdown
Paths prefixed with @ are files explicitly referenced by the user. Use the read tool when their contents are needed; do not claim to have inspected a file before reading it.
```

#### Token effect

Conditional and fixed: the one sentence is present while `read` is visible to the addressed agent; candidate lookup itself adds no tokens, and a selected path contributes only its ordinary user-message characters.

#### KV Cache effect

The stable sentence joins the system-prompt prefix. Mounting or removing this provider, or changing whether `read` is visible, changes that prefix; queries, candidates, and index invalidations do not.

### Injected file snapshots when `fileContent` is enabled

#### What the model sees

After the claimed direct user messages of a step, one user-role recall message headed `## Referenced file snapshots`. It frames the content as untrusted read-only data and wraps one fenced block per distinct mention, headed with the mentioned path, the resolved path when it differs, the filesystem revision, and the truncation flag; unavailable mentions carry their reason instead of content.

#### Token effect

Per step and mention-proportional: only steps whose direct user messages contain `@file` mentions receive the message, and its size is bounded by `maxFileBytes` and `maxTotalBytes`. Steps without mentions add nothing.

#### KV Cache effect

The recall message sits after the step's claimed user messages, so its content does not join any stable prefix; changing budgets or mention sets changes only that step's tail.

## Known Limitations and Deferred Work

- **Host-local namespace** — the provider scans the Harness host filesystem, so remote or virtual `read` implementations require a provider whose namespace matches the tool. Content injection reads through `ctx.fs` and fails loud when no filesystem service is present.
- **Bounded advisory index** — very large workspaces may omit paths after `maxEntries`, and excluded or unreadable directories do not appear.
- **No ignore-file semantics** — `.gitignore` and other project ignore files do not influence discovery; only configured directory basenames are excluded.
- **Text-only snapshots** — binary mentions are recorded as `unavailable: FS_NOT_TEXT`, and injected content is not re-read after the step begins; the model still uses `read` for fresh or full contents.
