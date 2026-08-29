# 本地验证与效果记录

[English](verification-and-effects.md) | 中文

## 1. 目的

本地验证是 Agent Loop 的保底机制，用来回答“用户想要的结果是否真的发生”。它不属于模型路由、训练、遥测或运营分析。

## 2. 两层结果

- `ExecutionResult`：工具是否执行成功。
- `EffectRecord`：预期结果是否经过本地检查成立。

```yaml
effect_record:
  step_id: string
  expected_effect: string
  status: verified|failed|unverifiable
  method: test|build|lint|readback|schema|comparison|user_confirmation|none
  evidence_ref: string|null
  note: string|null
```

## 3. 验证规则

- 计划步骤在执行前应写明可用的验收方式。
- 写文件后回读；运行命令后查询实际状态；生成结构化产物后校验 Schema。
- 编码任务优先使用相关测试、构建和类型检查。
- 文档、表格和其他办公产物优先做结构、数量、引用和输入输出对账。
- 无可靠验证方式时标记 `unverifiable`，交付时说明，不伪装完成。

## 4. 终态关系

- 所有必要效果均 verified：`complete`。
- 有可用产物但部分必要效果失败或不可验证：`partial`。
- 核心效果失败且无可交付结果：`failed`。
- 缺少外部条件或用户确认：`blocked`。

## 5. 数据边界

EffectRecord 与 evidence 默认保存在本地 Work State。不得上传给调度侧，不生成训练样本，不用于后续模型选择。
