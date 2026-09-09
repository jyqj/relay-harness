# Agent Note: Seeded-session switch e2e misattribution and gateway slot pin

Status: implemented

[English](2026-09-03-seeded-session-switch-e2e-misattribution.md) | 中文

## 问题

Round-6 把 served-web 种子会话 e2e 失败(`apps/web/tests/details-session-lifecycle.e2e.ts`:点击 runtime 种子行后该行从 Tasks 组消失、会话窗口永不挂载)归因于网关里 R5-B 的每会话操作链,并计划把共享槽收窄为 admission-only 路由。插桩之后,两个事实打破了这个前提;而且在修错层之前,需要先把 flake 的归属弄对。

## 决策

**链被 wire 证据免责;守护其排序的钉子落地;flake 重新归属。** 对 `serializeSessionOperation` 插桩显示 switch 路径从未进入该槽:通过与失败的运行里,槽每次运行只见到一次进入——当轮自己的 `session.prompt` 准入;`agentPresets.select` 与 `selectModel` 从不进入。失败的运行里,点击之后没有任何 client→host 请求——switch 在任何 RPC 之前就在客户端中止;通过的运行则在约 200ms 内发出五连调用(`subagent.list`、`session.history`、`dynamicCordisRunner/inventory`、`skill.list`、`commands/list`),且行在已落地的点击之后 100–300ms 才从 list store 消失。

**已提交的红 witness 是陈旧构建产物。** 确定性基线(以及针对它跑的沙箱对照)骑在一个 host `lib/` 上,其 `tsc -b` 遍跳过了最后一次 `api-proxy.ts` 保存——`tsdown` 从陈旧的 `lib/types` 打包,该 lane 测的是链的更早变体。全新构建下该 spec 多数运行通过,残余约五分之一的 flake,其机制位于客户端 switch 流(会话 manager / 工作区树),不在网关。

**落地了什么:** 网关级钉子 `settles a prompt queued behind a slow swap with the swap committed first`(`packages/host/apiproxy/tests/api-proxy-agent-preset.spec.ts`——一个 swap 停在 recompose 中段而一条 prompt 排队:两者都 settle,`agent-preset/selected` 标记先于 prompt 的 user message,投影稍后读取的日志记载着已组合的 preset),外加本记录与[操作链 note](../bug-fix/2026-09-03-apiproxy-subscriber-bound-and-session-ops-chain.md)的交叉链接更新。共享槽保持 R5-B 交付时的原样。

## 已考虑的替代方案

**把槽收窄为 admission-only 并把 `agentPresets.select` 移回独立链。** 依证据否决:没有 select 参与 switch 路径,收窄碰不到这个失败;它还会把已提交的 mid-recompose 排序从"prompt 等待并在新组合下运行"翻转为"prompt 赢、swap 以 `agent-preset-locked` 拒绝",用 hero chip 的 UX 回换取一个无所指的修复。

**在本 slice 内追查残余 flake。** 因归属否决:观察到的机制——点击落地、无 RPC 跟随、行在无线流量下离开 store——位于会话 manager 与工作区树,不在本 slice 的文件集内。应由一个拥有 `packages/client/runtime/src/client/sessions/` 与 `packages/client/ui-workspace/` 的后续 slice,携上文的 wire 捕获方法接手。

## 后果

details-session-lifecycle lane 仍会间歇失败(约五分之一);它不再是针对网关链的证据,其红也不再阻塞本 slice。admission 排序钉子会在 mid-recompose 排序向任一方向回归时响亮失败。一条持久告诫:web e2e lane 从构建后的 `lib/` 运行 host——改动 host 源码后先跑 `npm run build:lib:host`,否则 lane 测的是昨日的 bundle,失败会再次错误归因。
