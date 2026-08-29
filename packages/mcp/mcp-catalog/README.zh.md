# @relay-harness/rlh-mcp-catalog

[English](README.md) | 中文

Client-safe descriptor/read/prompt 词汇从 `./types` 导出；root 为既有 Host consumer 继续 re-export。

MCP Resources、Resource Templates 与 Prompts 的协议原生注册表。已连接的 `mcp-client` generation 会原子发布完整分页目录。Resource read 保留文本和 base64 blob；Prompt 调用保留 text、image、audio、resource-link 与 embedded-resource block。列表刷新失败会保留 last-good generation，连接健康仍由 `mcp-client` 拥有。

服务在共享 Context Engine 注册 `mcp-resources`。它只 hydrate 直接用户文本中显式出现的 Resource URI 并生成绑定 revision 的 Evidence；绝不把 Resource 伪装成工具。`ctx.mcpCatalog.listPrompts()` 与 `getPrompt()` 是显式 Prompt catalog／invocation seam。

## 模型体验

### 显式 MCP Resource recall

#### 模型看到什么

只有用户显式提到已编目 URI 时，模型才看到一条有界的不可信 recall 消息（`source.plugin = 'mcp-resources'`）。

#### Token 影响

Resource read 超过 `maxReadBytes` 会被拒绝；内联 Resource JSON 还受 `maxResources` 与 `maxChars` 限制。没有 URI mention 就不增加 Token。

#### KV Cache 影响

Resource revision 只影响显式包含它的请求。

## 已知限制与延后工作

- Resource template 已进入 catalog，但 template expansion 仍由 caller 拥有。
- Remote server 是未签名外部 authority；catalog health 只证明连接性，不证明内容可信。
