# Work 与文件上下文

[English](work-and-files.md) | 中文

File Context 是 chat/work 共用的文件边界：Chat 中随 conversation 生效，Work 中随独立任务生效。本文重点定义 Work 的持续执行场景。

## 1. Work 不是 Project

work 表示“一件需要完成的事”。用户无需创建项目、命名工作区或预先配置目录。每次 work 独立维护：

- 目标与对话；
- 引入的文件和文件夹；
- 计划、状态与确认；
- 生成的产物；
- checkpoint 与本地验证记录。

## 2. 文件引入

用户可以在 chat 中附加文件，也可以在 work 开始前或执行中引入文件/文件夹。引入动作创建对应 conversation/work 的 File Context 条目，而不是创建 Project。

```yaml
file_context_item:
  id: string
  display_name: string
  source: upload|local_path|folder|generated
  source_ref: string
  media_type: string
  fingerprint: string
  access: read_only|read_write
  status: pending|ready|unsupported|stale|removed
  user_note: string|null
  extracted_summary_ref: string|null
```

## 3. 读取策略

- 默认只读取显式引入的内容。
- 文件夹先建立清单，再按任务相关性读取文件。
- 大文件先提取结构、元数据和摘要，正文按需分页读取。
- 二进制或不支持格式给出人话提示，不伪装已读取。
- 文件指纹变化后标记 stale，使用前重新确认或刷新。

## 4. 访问与写入

- `read_only` 输入不得被原地修改。
- 默认把生成物写入本次 work 的产物区。
- 覆盖源文件、删除、批量改写或写出 File Context 范围前必须确认。
- 产物记录来源文件和生成步骤，便于用户理解结果从何而来。

## 5. 用户界面要求

- 始终可见当前 work 已引入的文件清单。
- 用户可以添加、移除、刷新或补充文件说明。
- 明确区分“输入资料”和“Relay 产物”。
- 不使用 repository、workspace、root 等开发者术语要求普通用户配置；高级本地编码场景可把文件夹作为一个 File Context 引入。

## 6. 与 Prompt Enhancing 的关系

Prompt Enhancing 只得到文件清单、用户说明和与草稿相关的摘要。除非优化草稿确实需要，不读取完整文件正文；增强过程不会修改文件。
