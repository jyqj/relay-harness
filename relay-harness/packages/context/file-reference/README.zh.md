# `@relay-harness/rlh-file-reference`

[English](README.md) | 中文

文件引用发现 seam，以及供宿主驱动的用户界面共享、可在浏览器中安全使用的 `@file` 语法。`ctx.fileReferences.list(agent, query, signal)` 为指定 agent（智能体）返回仅含路径的文件或目录候选；具体提供方负责命名空间访问、排序、缓存和失效处理。同一契约以一元 `fileReferences/list` Remote 方法对外可调（`@Remote` 标注在 Service Definition 上，经保留的末位 signal 参数取消），浏览器消费方直接调用 `ctx.remote.fileReferences.list`，无需 API Proxy 路由。

`activeAtToken()` 只在输入开头或空白后识别 `@path` 或尚未闭合的 `@"path with spaces` token，因此类似电子邮件的文本不会打开补全。`formatFileMention()` 会生成与提示词匹配的写法，为目录候选追加 `/`，保留显式打开的引号，并拒绝编辑器语法无法安全表示的控制字符或内嵌引号。`parseFileMentions()` 按同一语法从完成的提示词文本中提取全部提及——包括带引号的 `@"path"` 写法，以及位于输入开头或空白后的不带引号路径——并按首次出现顺序去重。

选择候选项本身不会读取或附加文件内容。将所提及文件内容注入步骤的提供方，通过 `file-reference` recall 消息 source（`form: 'recall'`，每个不同提及一条记录，含解析后路径、revision、已包含字节数、截断标记或不可用原因）上报，本包通过对 `MessageSourceMap` 的声明合并在此声明该类型。导出的 `FILE_REFERENCE_PROMPT` 是稳定指引；当指定 agent 可以调用 `read` 时，提供方可以安装该指引。

## 模型体验

间接影响模型体验：`@relay-harness/rlh-file-reference-local` 会按条件贡献本包的稳定文件引用指引，并在启用其 `fileContent` 配置段时，为每个步骤贡献一条携带所提及文件快照的 recall 消息。

#### KV 缓存影响

接口、语法和 recall source 记录本身不会增加请求 token；缓存行为取决于提供方拥有的提示词段与注入的 recall 消息。

## 已知限制与暂缓事项

- **路径候选仅供参考**：该 seam 不保证后续面向模型的文件系统工具能够访问同一命名空间；部署时必须让提供方与实际生效的 `read` 实现对齐。
- **内容注入由提供方拥有且需显式开启**：seam 只定义 recall source 记录与提及解析器；将所提及文件读入步骤需要提供方开启（`@relay-harness/rlh-file-reference-local` 的 `fileContent` 配置段），并依赖同一命名空间的文件系统服务。
