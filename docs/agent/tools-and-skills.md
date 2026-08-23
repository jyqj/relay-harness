# Tools 与 Skills

## 1. 工具层

工具是 Agent 读取或改变外部世界的唯一执行通道。初始工具类别：

| 类别 | 能力 |
|---|---|
| 文件 | 清单、读取、生成、精确编辑、导出 |
| 终端 | 受控执行构建、测试、脚本和查询 |
| 搜索 | 在当前 File Context 内定位内容 |
| 网络 | 搜索和抓取公开资料 |
| 交付 | 生成 ArtifactRef 和结果摘要 |

## 2. 工具契约

- 参数使用严格 Schema。
- 输出区分成功、失败、部分结果和取消。
- 大输出落本地引用，上下文只接收摘要。
- 写操作尽量幂等；非幂等操作先检查已有状态。
- 工具错误提供 Agent 可行动信息，用户界面转换为人话。
- 工具权限受当前 work 的文件与动作边界约束。

## 3. Skills

Skill 是可复用的任务方法、模板和验收规则，不是新的权限来源。

```yaml
skill_manifest:
  name: string
  description: string
  applicable_task_types: [string]
  instructions_ref: string
  required_tools: [string]
  input_schema: object|null
  output_schema: object|null
  verification: [string]
```

规则：

- Skill 不能扩大 File Context 或绕过权限门。
- Prompt Enhancing 可以利用已选 Skill 的输入/输出要求帮助用户补全草稿。
- 没有可靠输出要求的 Skill 不得声称可自动完成结构化任务。
- 选择 Skill 不等于选择模型；模型调用仍通过外部调度接口。

