# @relay-harness/rlh-tool-context

[English](README.md) | 中文

现有 Context Engine 的模型工具 `retrieve_context`。工具通过所在 Cordis 作用域的 `ctx.tools` 注册；共享 base 为 headless 装配它，Web 禁用全局行，由 standard Agent preset 挂载作用域内的版本。minimal preset 不变。不引入新的任务数据库、上下文引擎或远程认证系统。

## Invocation and authority

省略 `query` 只列出明确支持工具检索的来源 id，不调用 provider。查询可以用 `sources` 选择这些 id。Session、工作目录和 preset 从精确的存活 Agent 获取，不接受模型参数提供的身份。配置引用不存在的来源会明确报错，请求未知来源会被拒绝。异步检索前后都检查作用域与身份，取消信号传递到读取过程。

代码召回绑定工作区，并拒绝不同执行文件系统，不能将远端 cwd 误当作 Host 目录。文件读取要求显式 `@path`，使用 Agent 的文件系统并检查规范工作区包含关系。记忆保留 provider 的 preset、子 Agent 和治理规则。会话历史只检索有界的当前 Session，不遍历其他会话。MCP 只读取明确提及、已在目录中的资源 URI，不创建服务器或隐式执行 Prompt。

## Configuration

| Field | Default | Meaning |
|---|---:|---|
| `maxQueryChars` | `8192` | 查询 Unicode 码点上限。 |
| `maxContextChars` | `12000` | 最终工具渲染之前的完整上下文消息预算。 |
| `maxContextTokens` | `3000` | 上下文选择的估算 token 预算。 |
| `maxOutputChars` | `24000` | 包含 JSON 转义、来源与包装的完整结果预算。 |
| `maxOutputTokens` | `6000` | 完整结果的估算 token 预算。 |
| `contributors` | omitted | 部署允许的来源；省略则保留明确支持工具检索的来源。 |

数值必须是正安全整数。输出预算须容纳上下文预算及最小报告。工具测量完整渲染结果，必要时按整条观察或诊断省略并返回计数，不能独立截断证据正文而保留旧摘要。

## Model Experience

### Explicit evidence retrieval

#### What the model sees

一条 `retrieve_context` 结果，包含来源描述、观察、证据、覆盖范围、选择决策和省略计数。`catalog`、`ok`、`partial`、`empty`、`unavailable` 描述本次操作，不证明否定结论。来源描述只说明注册和用途支持，不证明 provider 健康或授予权限。非文本 MCP 内容不会悄悄转成文本：输出报告省略的观察。

#### Token effect

每次显式调用支付有界的普通工具结果 token。该消费者不调用辅助模型；provider 可在自身配置限制内进行检索或 embedding。

#### KV Cache effect

普通工具结果只追加一次 Session 日志并进入下一次模型请求，不伪装为用户输入，也不重复注入上下文。安装工具改变下一次请求快照中的工具目录。

## Known Limitations and Deferred Work

Token 使用现有计量器或其估算，不是精确 tokenizer。这是有界检索，不是穷尽性不存在证明。当前会话历史不会激活冷 Agent 或搜索无关 Session。工具不把召回内容提升为指令、不执行 MCP Prompt、不批准记忆、不认证工作，也不持久化第二份证据数据库。整消息 provider 与候选批次 provider 可以并存；排序是确定性的，不是学习得到的全局相关性模型。
