# Agent Note：被改写为空的首个 enter 仍会认领收件箱排队尾部

Status: implemented

[English](2026-09-03-empty-first-enter-continues-queued-tail.md) | 中文

## 问题

当 `agent/pre-step` 瀑布把一个回合的首个 enter 决策改写为零条消息时，`ReactLoopAgent.turn()`（`packages/core/agent-loop/src/agent.ts`）会在 pre-step 检查处直接 `return false`。这个出口是独一无二的：其余所有回合出口都会流经驱动尾部——重新检查 `inbox.hasPending` 并在仍有工作时以新回合继续。驱动运行期间排队入队的消息不会被任何闩锁记录——运行阶段中的 `send()` 刻意不置位 `wakeRequested`，因为活跃驱动会自行认领队列——因此被跳过的尾部让排队的消息被搁置：带空 enter 监听器的 `send('a'); send('b')` 会认领 `a`、关闭回合 1，然后把 `b` 滞留在收件箱里，直到某次后续外部唤醒，这与文档中"回合在无所欠时关闭"的回合契约相矛盾。

## 决策

空的首个 enter 出口改为把 `turnEnds` 置为 `{ kind: 'completed' }` 后 break 到共享尾部，而不是提前返回，与兄弟出口（关闭一个已耗尽且无认领消息的回合）完全一致。当收件箱仍有待处理输入时，尾部重置驱动的 abort 控制器并让 `turn()` 返回 `true`，开启认领下一条排队消息的新回合；当没有待处理输入时，尾部返回 `false`，驱动照旧收敛。

## 已考虑的替代方案

- **在空的首个 enter 之后由驱动退出时补挂唤醒闩锁** — 否决：这会把续接绕道收敛重放、晚一跳才执行，并且要为一个出口做特例，而兄弟的无步骤出口已经证明尾部路径才是正确的共享续接路径。
- **把改写为空视作 `reject` 决策** — 否决：两个决策对监听者含义不同，而且针对空 enter 场景的持久日志契约（一个真实的、带 `turn/end` `completed` 却未花费步骤的回合）已被测试和文档钉死。

## 后果

- `docs/architecture.md` 无需修改：回合流契约（"首个 enter 被改写为空 -> 关闭该回合且无步骤"；"无所欠时关闭"）描述的正是修复后的行为，代码才是偏差方。
- 会话日志格式无变化：续接只是一对普通的 `turn/start` / `turn/end`，无排队输入时记录的事件与之前逐字节相同。
- TypeScript 与 Python SDK 的期望输出不受影响：两者都不会回放"空 enter 改写 + 排队尾部"的组合。

## 测试

- `packages/core/agent-loop/tests/contract-regressions.spec.ts` 在既有空批次用例旁新增 "continues the queued tail after an empty admitted batch as its own turn"：两条排队 followup 配合仅作用于回合 1 的空 enter 监听器，必须产出一个无步骤回合，随后是带 `step/start { turn: 2, step: 1 }` 的真实回合 2、一次模型请求，以及空收件箱。修复前该测试失败（零请求、单回合），修复后通过。
- `pnpm vitest run packages/core/agent-loop packages/core/agent` — 456 个测试全部通过。
