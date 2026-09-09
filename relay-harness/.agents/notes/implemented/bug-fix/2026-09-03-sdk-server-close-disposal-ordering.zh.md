# Agent Note: SDK server closeSession 在释放停稳后才注销会话 id

Status: implemented

[English](2026-09-03-sdk-server-close-disposal-ordering.md) | 中文

## 问题

两侧 SDK 传输都允许 pipeline 请求，而服务端的 `closeSession` 在 await agent 释放之前就把会话 id 从 map 中移除。对刚关闭的 id 在未等到 close 响应时发出的 `session/prompt`，会对同一个 SessionId 执行 `ctx.agents.create`，而旧 agent 仍在注册表中：新创建与旧 agent 的注销相竞态，并作为该提示词的 JSON-RPC 错误 `agent "main" is already registered` 浮出。文档承诺的 close 契约——对已关闭 id 的再次提示词会创建全新会话——只在客户端恰好串行化请求时成立，使契约对协议并未禁止的客户端模式变成时序相关的。

## 决策

`closeSession` 让 record 在 map 中存活到释放完成。record 新增一个在释放开始时设置的 `disposeCompletion` promise；注销该 id 的操作作为该 promise 的延续执行，因此注销严格晚于旧 agent 的注销。`getOrCreateSession` 把处于关闭中的 id 路由到进行中的 completion 上，随后重新解析，在旧 agent 消失后创建全新会话；pipeline 的提示词等待有界的释放停稳，而不是失败。`performShutdown` 面对已存在的 `disposeCompletion` 选择 await，而不是对处于关闭中的 record 第二次调用 dispose。

## 已考虑的替代方案

**先删除 id，再用一张记录历史释放的墓碑表约束重建。** 否决：它会为服务端已不再持有的 id 增加释放状态；存活中的 record 是自身释放的天然持有者，墓碑还需要各自的清理。

**对关闭进行中到达的提示词以专门的 "session closing" 错误失败。** 否决：close 契约承诺对后续提示词创建全新会话，而 pipeline 在两侧传输上都是合法的；对合法客户端模式报错只是把契约本就禁止的失败换了个新错误码。

**仅把 `sessions.delete` 挪到 `await rec.handle.dispose()` 之后，不做路由。** 否决：窗口只是变小——释放期间到达的提示词仍会构建与旧 agent 注销相竞态的第二个 agent。

## 后果

close 响应现在只在 agent 释放达到停稳后落定；释放是有界中止，不是等待进行中的 turn，因此 close 响应不会无界拉长。对关闭中 id 的 pipeline 提示词以全新 handle 落定，永远不会观察到 `already registered` 或 `unknown session`。同一 id 的两个并发 close 现在都在唯一一次释放后落定；在 id 已被注销后发出的 close 仍以 `unknown session` 响亮失败。shutdown 不再对 close 进行中的 record 二次 dispose。服务端 options 的 JSDoc 不再声称 turn 结局的状态映射——`maxTokensAsSuccess` 只影响 `subagent.finished`，root turn 的未映射停止原因出现在 `RunResult.finishReason`。该顺序由 `packages/sdk/server/tests/server.spec.ts` 中的 `pipelines a prompt for a mid-close session onto the in-flight dispose` 钉住，两份 server README 的 close 契约句也写明了进行中的语义。
