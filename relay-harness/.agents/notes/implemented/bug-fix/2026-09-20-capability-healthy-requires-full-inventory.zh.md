# Agent Note: 能力 healthy `yes` 要求每一条装配行都被 accounted for

Status: implemented

[English](2026-09-20-capability-healthy-requires-full-inventory.md) | 中文

## 问题

能力报告的 healthy 层（`@relay-harness/rlh-host-plugin-inventory`，`report.ts`）连接 Loader inventory 的方式是遍历该能力的装配 composed 行并收集匹配到的条目。没有对应 inventory 条目的行会被静默跳过：对于多条目能力——web-search 装配 `web-search-deepseek` 和 `tool-web` 两个条目——只观察到其中之一的 inventory 依然会产出 healthy `'yes'`，折叠后的 `effective` 状态宣称 `running`。健康结论建立在部分证据上，与报告其他层已经防范的 AND-hole 同型。

## 决策

- `healthyLevel` 现在跟踪没有匹配到任何 Loader inventory 条目（按 `entryId` 或 `moduleName`）的装配行，只要存在就报告 healthy `'unknown'`，reason 写明首个未匹配行与已 accounted 的比例。healthy `'yes'` 要求每条装配行都有一个匹配且 active 的 Loader 条目。
- 既有检查的顺序与含义不变：disabled 的 composed 行在没有 runtime 证据时仍报告 `'no'`；缺失 runtime dump 仍报告 `'unknown'`；rows 为空的情形仍落入既有的 "no Loader entry matches" unknown。
- `effectiveState` 无需改动：healthy `unknown` 折叠为 `standby`，绝不会是 `running`。

## Alternatives considered（已考虑的替代方案）

**改报 `'no'` 而不是 `'unknown'`。** 拒绝：没有证据不等于失败证据。报告的一贯姿态——输入未携带的证据层报 `unknown` 并附 reason、绝不猜测——已经覆盖此情形；`'no'` 会夸大 dump 实际显示的内容。

**同时扫描未匹配任何装配行的 inventory 行并据此降级。** 拒绝：inventory 列出 host 里所有非 group 的 Loader 条目，其中大多数属于其他能力、或不在目录关注范围内。连接按能力进行，多出的 inventory 行是预期情况，绝不能拖累无关能力的层级；测试 fixture 固定了这一行为。

## 后果

- inventory 被截断、过期或过滤的 dump 无法再凭部分条目把能力报告为 healthy 或 running；它报告 `'standby'`，evidence 字符串写明未被 accounted 的行。
- runtime 证据完整的报告与之前逐字节一致；只有部分证据路径发生了变化。
- 回归覆盖：plugin-inventory report spec 在 web-search 的两条 inventory 行只存在其一的情况下装配，断言 healthy 是 `unknown` 而非 `'yes'`，且 reason 写明第二个条目。
