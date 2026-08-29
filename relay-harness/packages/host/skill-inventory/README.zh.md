# @relay-harness/rlh-host-skill-inventory

[English](README.md) | 中文

为 Settings 的 Skills 页提供 Host Remote `skillInventory`。每个方法都接受可选的 `cwd` 与 `sessionId`；一旦提供 cwd，就必须同时提供对应 live Session，而且 cwd 必须等于其权威 cwd。提供 `sessionId` 时，网关只读解析该精确存活 Agent，并读取该 Agent 所见的分层 `ctx.skills` 视图（含 standard preset 的 filesystem provider）；它不会创建或恢复 Agent，缺少存活 Agent 时抛出类型化的 `session-not-found`。`list` 与 `get` 不过滤 composer 的 `isUserInvocable`，并补上 `path`、`source` 与 `writable`。`create` 按调用方选择的模型/用户初始调用开关，写入 `$RLH_HOME/skills/<name>/SKILL.md` 或 `<project-root>/.rlh/skills/<name>/SKILL.md`。`update`、`delete` 与 `setInvocation` 会规范验证 Provider path 仍位于自有 user/project root 内；原子 sibling-write/rename 会保留未知 frontmatter 字段。bundled、runtime 与 custom skill 只读。`importSkill` 会安装本地目录、ZIP 或 GitHub archive，记录 source／version／permission metadata 与显式 `unsigned-local` trust；`replace` 执行更新。

Import 会在 staging 前后约束 archive byte、expanded byte、文件数、regular-file 类型、路径 containment 与本地 bundle symlink。GitHub `version` 会选择实际下载 ref。声明 permission 使用有界 canonical label，并且只是 metadata，不是 runtime grant。

该服务仅供 Remote 使用。Client 包通过 [`api-remotes`](../../api/remotes/README.md) 消费。composer 的 `skill.list` RPC 不变。

## 模型体验

无，因为这个 Host Remote 不注册提示词、工具、消息或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- Import 会明确标为 `unsigned-local`；不会伪造 marketplace 签名或已验证 publisher identity。
- **创建后不可改名** — 重命名等于删除再创建。
