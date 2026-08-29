# @relay-harness/rlh-host-skill-inventory

English | [中文](README.zh.md)

Host Remote `skillInventory` for the Settings Skills page. Every method accepts optional `cwd` and `sessionId`; a supplied cwd requires that live Session and must equal its authoritative cwd. When `sessionId` is present, the gateway resolves that exact live Agent and reads the layered `ctx.skills` view that Agent sees (the standard preset's filesystem provider included); it never creates or resumes an Agent, and a missing live Agent throws typed `session-not-found`. `list` and `get` omit the composer `isUserInvocable` filter and add `path`, `source`, and `writable`. `create` writes `$RLH_HOME/skills/<name>/SKILL.md` or `<project-root>/.rlh/skills/<name>/SKILL.md` (`project-root` is the nearest `.git` ancestor of `cwd`, or `cwd` itself) with caller-selected initial model/user invocation flags. `update`, `delete`, and `setInvocation` canonically verify the provider path remains inside `user-rlh`, `user-agents`, and — when `cwd` is present — `project-rlh` / `project-agents` roots. Atomic sibling-write/rename updates preserve unknown frontmatter fields; delete removes the entire skill bundle directory. Enablement is the existing frontmatter pair `disable-model-invocation` and `user-invocable`.  Bundled, runtime, and custom skills stay read-only. `importSkill` installs local directories, ZIP files, or GitHub archives with source/version/permission metadata and explicit `unsigned-local` trust; `replace` performs an update.

Imports bound archive bytes, expanded bytes, file counts, regular-file types, path containment, and local bundle symlinks before and after staging. GitHub `version` selects the actual downloaded ref. Declared permissions use bounded canonical labels and remain metadata rather than runtime grants.

The service is Remote-only. Client packages consume it through [`api-remotes`](../../api/remotes/README.md). The composer `skill.list` RPC is unchanged.

## Model Experience

None, as this Host Remote registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- Imports are explicitly `unsigned-local`; no marketplace signature or verified publisher identity is fabricated.
- **Name is immutable after create** — rename is a delete plus create.
