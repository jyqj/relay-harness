# Relay 文档地图

本目录描述 Relay 的**当前设计**，不保存完整调整历史。每个概念只设一个权威出处，其他文档以链接引用，不重复维护同一套规则。

## 阅读顺序

1. [`CONTEXT.md`](CONTEXT.md) — 产品定义、系统边界与术语
2. [`product/vision-and-positioning.md`](product/vision-and-positioning.md) — 定位、目标用户与价值主张
3. [`product/product-experience.md`](product/product-experience.md) — 傻瓜式体验、chat/work、Prompt Enhancing
4. [`agent/overview.md`](agent/overview.md) — Rust agent 的总体架构
5. [`agent/agent-runtime.md`](agent/agent-runtime.md) — Agent Loop、状态、恢复与本地验证
6. [`agent/work-and-files.md`](agent/work-and-files.md) — 无项目 work 与文件上下文
7. [`agent/memory.md`](agent/memory.md) — 长期记忆需求与待决策项
8. [`scheduling/interface.md`](scheduling/interface.md) — 外部中转调度接口
9. [`engineering/p0-scope.md`](engineering/p0-scope.md) — 开发起步顺序与验收

## 目录职责

| 目录 | 权威内容 |
|---|---|
| `adr/` | 当前仍具约束力的少量架构决策 |
| `product/` | 产品定位、体验、计费方向、路线图与风险 |
| `agent/` | agent 侧模块、契约和运行时设计 |
| `scheduling/` | 外部中转调度项目的定性需求、边界与接口 |
| `engineering/` | Rust 技术基线、开发阶段和验收 |

## 文档清单

### product/

- [`vision-and-positioning.md`](product/vision-and-positioning.md)
- [`product-experience.md`](product/product-experience.md)
- [`pricing-and-tiers.md`](product/pricing-and-tiers.md)
- [`roadmap.md`](product/roadmap.md)
- [`risk-register.md`](product/risk-register.md)

### agent/

- [`overview.md`](agent/overview.md)
- [`agent-runtime.md`](agent/agent-runtime.md)
- [`prompt-enhancing.md`](agent/prompt-enhancing.md)
- [`prompt-enhancing-context-pipeline.md`](agent/prompt-enhancing-context-pipeline.md)
- [`work-and-files.md`](agent/work-and-files.md)
- [`memory.md`](agent/memory.md)
- [`routing-signals.md`](agent/routing-signals.md)
- [`orchestration.md`](agent/orchestration.md)
- [`verification-and-effects.md`](agent/verification-and-effects.md)
- [`security-and-data-boundary.md`](agent/security-and-data-boundary.md)
- [`tools-and-skills.md`](agent/tools-and-skills.md)

### scheduling/

- [`overview.md`](scheduling/overview.md) — 外部调度侧需要提供什么，不规定其内部算法
- [`interface.md`](scheduling/interface.md) — HTTP/JSON + SSE 契约

### engineering/

- [`tech-stack.md`](engineering/tech-stack.md)
- [`p0-scope.md`](engineering/p0-scope.md)

## 维护规则

1. **当前态优先**：删除“此前、曾经、本次调整、退役”等迁移叙事。
2. **单一权威出处**：产品体验、运行时、记忆、调度接口分别由对应专篇维护。
3. **事实与设想分开**：未裁决项标为 `[待决策]`；待实验参数标为 `[待标定]`。
4. **调度边界**：本项目不设计中转调度内部算法，只定义需求和接口。
5. **变更纪律**：只有跨模块、长期稳定且存在真实取舍的决定才进入 ADR。
