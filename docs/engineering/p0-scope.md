# P0 范围与验收

## 目标

P0 建立 Rust Agent 基础能力。CLI 是工程验证入口；真正面向普通用户的 Web 体验在后续阶段复用同一内核。

## M0：领域骨架

- 建立 Rust workspace；
- 定义 Work、Run、Step、File Context、Artifact、EffectRecord；
- 定义 Ports：store、tools、router、memory、clock、approval；
- 实现 work 终态机。

**验收**：状态转换单元测试覆盖 complete、partial、failed、blocked、cancelled；领域对象中不存在必填 `project_id`。

## M1：无项目 Work 与文件

- 创建独立 work；
- 文件/文件夹引入、清单、指纹和访问模式；
- 大文件按需读取接口；
- 输入与产物分离；
- 范围外访问和覆盖源文件经过确认。

**验收**：用户只提供一句目标和若干文件即可开始；未引入文件不可访问；文件变化后能识别 stale。

## M2：Agent Loop 与工具

- understand/plan/act/observe/verify/decide；
- 文件、终端、搜索和交付工具；
- 权限门与本地审计；
- 人话错误映射。

**验收**：在固定夹具上完成文件整理与代码修改任务；工具成功但效果不成立时不能标 complete。

## M3：外部调度接口

- 实现 `POST /v1/routes`；
- 消费 SSE 事件并组装文本/工具调用；
- 幂等、超时、取消和错误映射；
- 首次 chat/work 使用 `pre_classify`；
- Subagent 使用主 Agent 提供的完整信号。

**验收**：契约夹具覆盖正常流、工具调用、断流、重复请求、非法信号、超时和取消；本地验证数据不进入请求。

## M4：Subagent、验证与恢复

- SubagentSpec/Result；
- 上下文与权限隔离；
- 本地验证与 EffectRecord；
- checkpoint、退出和恢复。

**验收**：长任务中断后恢复，不重复已确认步骤；Subagent 缺路由信号时拒绝创建；验证结果只保存在本地 Work State。

## M5：产品能力接口预留

- Prompt Enhancing 的 Context Composer 与结果契约；
- chat/work 共享的输入上下文接口；
- 长期记忆 Port，只定义用户控制与查询能力，不提前锁实现；
- 面向 P1 Web 的稳定 application service 边界。

**验收**：Enhance 在提交前独立调用、不创建 work、不执行工具、可恢复原草稿；Context Composer 不读取无关文件和记忆。

## P0 非目标

- 面向普通用户的完整 Web 产品；
- 长期记忆的最终存储与检索方案；
- 强度档数、套餐和最终计费；
- 中转调度内部实现；
- agent 遥测、模型训练或路由飞轮。

