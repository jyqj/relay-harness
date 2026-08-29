# Agent Note：确定性 Context Control Plane

状态：已实现

[English](2026-08-29-deterministic-context-control-plane.md) | 中文

## 问题

Context Engine 只对 Provider 结果排序，不拥有资格、延迟隔离、共享请求预算、重复抑制或候选被排除的原因。Provider 本地字符上限无法保护完整模型请求，一个忽略取消的 contributor 也可能阻塞其后的全部 Provider。AgentLoop 会持久记录获准 Evidence，却不能解释 timeout 或预算拒绝。

## 决策

`ctx.contextEngine.prepareStep` 在检索前解析一个确定性 plan。Contributor 声明标识支持的 purpose；引擎为每个合格注册分配字符／token 配额与 deadline。检索仍由 Provider 本地拥有并串行执行，但每次调用都收到子 abort signal。父 signal 中止完整准备；contributor timeout 只中止该子调用并允许后续 Provider 运行。Promise 解析时注册代际必须仍是当前代际，因此释放或同 id 替换不能发布迟到结果。

Provider 返回整条消息及可选 selection metadata。显式用户引用先于 Provider 发现的 recall 参与重复抑制和总预算选择。选中消息恢复注册顺序，保留稳定提示布局。Provider 在局部配额内裁剪并 hydrate；引擎拒绝超大整消息，而不会切开消息、Evidence 与 Coverage 的所有权。

准备结果携带不可变 plan 及选中／拒绝 decisions。AgentLoop 把两者复制进 `context/prepared`；仅含拒绝的事件会记录 timeout、释放、重复或预算排除，而不增加模型可见内容。全部合格 Provider 都明确放弃时，`prepareStep` 仍返回 `undefined`，步骤保持不变。

## 考虑过的替代方案

- **模型检索 planner** —— 拒绝；资格与预算策略必须可重放、低延迟，且不依赖另一轮推理。
- **集中 Provider 搜索与 hydration** —— 拒绝；文件、代码、Memory、Session 与 MCP 来源拥有不同 revision 和 trust 语义。
- **立即并行扇出** —— 延后；确定性串行读取与隔离 deadline 可先关闭饥饿问题，不引入共享 Provider 并发竞态。
- **引擎切分任意返回消息** —— 拒绝；通用裁剪可能破坏 source framing 与 Evidence locator。
- **一个 timeout 中止整个请求** —— 拒绝；一个降级 Provider 不应让无关显式引用饥饿。

## 结果

默认 Base composition 具有显式总／局部预算及单 Provider timeout。文件与 MCP Resource 引用，以及带直接路径 mention 的代码 recall，携带显式引用优先级；其他 recall 保持 Provider 优先级。Prompt Enhancement 与 Agent step 使用同一 plan 和 decision trace。Hydration 验证仍由 Provider 所有；Provider 调用仍保持串行，直至独立并发设计证明 ordering、disposal 与后端容量行为。
