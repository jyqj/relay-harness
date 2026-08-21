# Agent Note: 显式 workspace checkpoint 与 rewind

Status: implemented

[English](2026-08-21-explicit-workspace-checkpoint-rewind.md) | 中文

## Problem

Workspace 注册会保留目录身份与 session 分组，却无法让 host 操作在危险编辑前建立可恢复文件边界。对话 fork 与 retry 不能恢复用户文件，而盲目复制整个目录既昂贵，也会捕获无关 secret 与 build output，并且对 symlink 与并发变化的行为含糊。

当前没有 caller 证明自动逐 prompt rewind 合理。它需要观察每个文件系统 effect、定义对话截断，并决定 shell 与外部进程写入是否参与。当前有用原语更窄：由 host 显式拥有、覆盖具名路径的 checkpoint，以及显式事务 rewind。

## Decision

公开 `Workspace` entity 暴露 `checkpoint(paths)` 与 `rewind(checkpointId)`。本包保持 host-only，不注册模型工具或 prompt。Checkpoint path 必须为 workspace-relative、lexically contained，并排序去重。每个现存 component 都在不跟随 symlink 的情况下检查；symlink、目录、特殊文件、空选择、超过 4096 个 path、单文件超过 64 MiB 或 aggregate 超过 64 MiB 都会在发布前拒绝。

每个 path 记录确认缺失状态，或完整 binary bytes 加 permission mode。Record 是带版本 JSON，位于 `<workspace>/.dsh/rewind-checkpoints/<sha256(workspaceId)>/<sha256(checkpointId)>.json`；原始 caller id 永不成为路径 component。store 写入 owner-only 的 `*` `.gitignore`。Checkpoint 与文件恢复都使用同目录随机 temporary、fsync、rename 和最终 chmod。返回的 `WorkspaceCheckpoint` 包含 opaque id、capture time、排序 path 与保留 byte count。

`rewind(id)` 会严格验证 workspace ownership、id、唯一 normalized path、snapshot tag、canonical base64、逐文件 byte 声明与完整 byte total。然后，它会在应用任何变化前预检每个 path 当前状态，并 capture rollback snapshot。Present snapshot 会原子替换 bytes 与 mode；absent snapshot 会 unlink 当前普通文件，或在已经缺失时 no-op。若后续 apply 失败，先前 path 会按逆序从 rollback snapshot 恢复，再报告原始 failure。第二个独立 rollback failure 会成为 aggregate。

成功 rewind 后，store 会移除所选 checkpoint，以及 capture instant 相同或更晚的每个 checkpoint。更早 checkpoint 保持有效。损坏的无关 JSON 与非 JSON directory entry 会在 post-commit timeline cleanup 中忽略；它们绝不会参与所选 checkpoint 的 strict load。

该操作只影响文件。它不会改变 Workspace 注册 record、session membership、conversation event 或 Agent state，也绝不会在 prompt boundary 自动运行。

## Alternatives considered

**自动 checkpoint 每个用户 prompt。** 不予采用，因为没有当前 host 或 UI 拥有匹配的 conversation-rewind transaction，而文件写入可以通过 shell、subprocess 或外部程序绕过 DSH 工具。自动承诺会不完整。

**Snapshot 完整目录树。** 不予采用，因为它会捕获无关 repository、credential、build artifact 与大型 dependency tree。显式 path 可约束 authority、storage 与 review。

**使用 Git commit 或 stash。** 不予采用，因为 workspace 可能不是 Git、可能 dirty、nested，或拥有 harness 不得改写的用户 staging state。checkpoint store 与 VCS 无关，并被 gitignore。

**把 checkpoint 存入 storage domain。** 不予采用，因为 binary 文件 rollback 是 co-located execution state，而不是 Workspace 注册 metadata。把 bytes 留在 workspace 内，使 workspace／rootfs snapshot 可以携带它们，同时 storage domain 继续保持小型 structured record。

**跟随 symlink 并存储解析目标。** 不予采用，因为后续 symlink retarget 可以把 rewind 重定向到 workspace 外。该机制在 capture 与 apply 时都会拒绝每个现存 symlink component。

**Best-effort apply，不做 rollback。** 不予采用，因为在先前 path 已改变后失败，会留下既不匹配 checkpoint、也不匹配 rewind 前 workspace 的混合状态。Preflight 加逆序 rollback 提供单一 operation owner。

**一起 rewind conversation 与文件。** 不予采用，因为 Session log 是 append-only，并有独立 fork／compaction 语义。组合式 destructive operation 需要 authenticated Host consumer 与自己的持久 transaction。

## Consequences

Host code 可以用持久本地 checkpoint 包围危险具名文件操作，并恢复 binary content、mode、创建与删除，而不接触无关 path。成功 rewind 会截断其未来文件 timeline，防止后来 rewind 到已放弃状态。

store 是本地单进程。它没有跨进程 lease、目录 recursion、自动 capture、shell-write interception，或 checkpoint record 到达 fsync 前 crash window 的 exactly-once 保证。它会拒绝 path-type race，而不是跟随。第二个独立文件系统 failure 下，rollback 为 best effort，并在发生时报告 aggregate。

测试覆盖公开 Workspace 委托、binary／mode 与缺失恢复、timeline 截断、malformed 与 foreign record、path escape、symlink、目录、hard cap、带 rollback 的 atomic-write failure、损坏 sibling record 和 missing id。除 external double-failure race 外，包保持逐文件 100% statement、branch、function 与 line。
