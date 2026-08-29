# @relay-harness/rlh-mcp-servers-file

[English](README.md) | 中文

负责 `$RLH_HOME/mcp-servers.yaml`（或显式 `path`），并为每条已启用记录挂载一个 [`@relay-harness/rlh-mcp-client`](../mcp-client/README.md) 子实例。HTTP endpoint 必须是绝对 HTTP(S)，不能包含 URL credential、fragment 或 secret query key，credential 必须放在 header。写入走 atomic-write 锁；监视器在外部编辑后重新挂载子实例。`authorize` 在系统浏览器里跑 MCP HTTP OAuth（PKCE），把 `Authorization: Bearer …` 写进该记录并重新挂载。`listManaged` 会掩码看起来像密钥的 env/header 以及 legacy URL value；upsert 里的空字符串或 `********` 会保留已存值。

## 模型体验

无，因为本包只挂载已定义的 mcp-client 实例，自身不组装提示词、工具或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **不从 Cursor 或 Claude 的 `.mcp.json` 导入** — 文档格式留给后续导入器；本包只读自己的 YAML。
- **组成配置里的 mcp-client 行不写入此文件** — 手写的 `cordis.patch.yml` 实例不会被改写。
- **OAuth 访问令牌会过期** — 没有 refresh token 续期；服务器再返回 401 时从 Settings 重新登录。
