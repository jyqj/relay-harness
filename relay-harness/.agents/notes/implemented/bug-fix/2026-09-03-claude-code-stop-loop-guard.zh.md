# Agent Note: Claude Code Stop 钩子循环护栏

Status: implemented

[English](2026-09-03-claude-code-stop-loop-guard.md) | 中文

## Problem

hooks-claude-code bridge 对每次合并后的 Stop-hook deny 都执行 steer，没有任何计数：`agent/turn-stopping` 的 deny 会在同一个 turn 的循环内重新填充 inbox，因此每次 deny 都会再消耗一次模型请求且没有上界——untrusted `hooks.json` 里的 always-deny 钩子会循环到 abort 为止，烧掉无界的 provider 开销。bridge 还在每个 Stop payload 里硬编码 `stop_hook_active: false`，Claude Code 钩子无法观察自己触发的强制续跑来自我限制。codex bridge 已上线 once-per-turn 守卫；只有 Claude Code 方言携带这个缺口。

## Decision

hooks-claude-code 的 Stop 监听器现在用 `WeakMap` 按 agent 记录最近一次强制续跑的 turn 号。同一 turn 内的再次 Stop 检查在 stdin payload 上报 `stop_hook_active: true`，若仍然 deny，bridge 记录 `remained blocking … closing the turn` 并返回、不再 steer——turn 在恰好一次强制续跑后关闭。bridge 尚未续跑过的 turn 内的 deny 照旧 steer 并记录该 turn。SubagentStop payload 保持 `stop_hook_active: false`，与 codex bridge 一致。

每 turn 一次强制续跑是 Claude Code 自身的 `stop_hook_active` 协议语义，因此这是协议对齐修复而非新策略，不加 Config 字段。后续 turn 里合法需要再次阻塞的钩子仍能得到一次，因为守卫按 turn 号键控。

## Alternatives considered

**跨 turn 计数连续 deny。** 否决：真正重要的 deny 循环发生在单个 turn 内，且 Claude Code 的文档契约是按 turn 的（下一 turn 的首次 Stop 检查 `stop_hook_active` 重新为 false）。跨 turn 上限还会困住跨 turn 边界合法重新阻塞的任务。

**把数值上限做成 Config 字段。** 现阶段否决：协议值就是 1，不是 deployment-varying 的选择。若部署将来确需不同上限，届时再落成经过校验的 Config 字段。

## Consequences

同一 turn 内 deny 两次的 Stop 钩子现在关闭 turn 而不是强制第二步——与 codex bridge 已上线的语义相同，消除了方言间的不对称。hook payload 日志在第二次同 turn 检查时记录 `stop_hook_active: true`，强制续跑的 hook payload 可观察地变化。依赖无限同 turn 强制续跑的既有 hook 配置必须自我限制（重复检查时 exit 0），这正是 Claude Code 自身协议的预期。剩余缺口是共享的 `TODO(hook-continue-false)`：`{"continue": false}` 结果仍只记录、不终止运行。
