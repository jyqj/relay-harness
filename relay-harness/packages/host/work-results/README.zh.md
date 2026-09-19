# @relay-harness/rlh-host-work-results

[English](README.md) | 中文

用于显式确认结果记录和跨会话发现产物的 Host 适配器。Session 日志仍是唯一持久权威；本包不创建 Work 数据库，也不改变 goal 的 phase。它拥有纯 `deliverables`、`workAcceptance` 与 `workContentReviews` 投影，既有承载通道发布这些投影，`ui-product-shell` 负责消费。`ui-deliverables` 只拥有回复指导和逐轮呈现。

`workResults/get` 还返回 `confirmationBlockedBy`，根据实时根会话身份、回合关闭状态、Agent 状态、排队输入、Host 审批／提问以及所属后台 Job 采样。读取时的原因仅供解释，不是授权或持久化证明。maintenance 保护的确认路径会再次应用同一纯策略，客户端不能把此前的可用读取转变成授权。

## 确认

`workResults/accept` 要求原始、仍活动的可信 Connection 请求恰好对应此端点，且不存在 agent initiator。客户端提交所审阅的最后一个非确认日志序号。Host 要求确切的活动根 agent、已结束的轮次、空待处理 inbox、没有所属的 running/stopping job，以及没有待处理的 ApiProxy 审批或问题。既有 Agent maintenance 事务使确认与其他维护串行，并将新的驱动输入排队；初次 flush 后，Host 在追加 `work/accepted` 前立即重新检查调用方、取消、资格和修订值。

回执记录 `reviewedThroughSeq` 和 `actor: 'host-client'`。它不会使自身失效，后续日志事实则会。同修订值重试复用回执，并发维护竞争者可能被拒绝。只有持久化屏障完成且物理读取确认回执后，操作才返回成功。未收到成功不证明记录不存在：稍后的重试可以确认已有记录而不再追加。

`workResults/get` 在等待前捕获一个审阅切面，flush 已接受工作，并检查物理回执及覆盖该切面的存储尾部。它返回 `verifiedThroughSeq` 和该切面是否仍为当前切面，绝不把更晚的内存序号升级为持久性声明。原始投影不是持久化证明。客户端只在安静的审阅时点验证；流式变化使较早的确认失效，而不会逐 chunk 触发 flush。

这些是既有可信 Host 客户端提交的确认，不是物理人点击的密码学证据。所有端点都按既有 Connection 策略限定为 loopback。确认不授予 agent 权限、不证明测试结果，也不证明文件未变化或子 agent 树已完成。

## Content review

`workResults/recordContentReview` 追加 `work/reviewed`：一个用户决定，绑定到显式的 `WorkContentVersion` 身份（执行环境、来源切点、定位符、实际读取字节的 sha-256 摘要、观察时间）和 `WorkCheckRecord` 事实（检查器身份、版本与配置摘要、消费的版本摘要、退出码与结论、持久化日志位置，以及证据级别 `agent-claimed` | `host-captured` | `user-reviewed`）。每个引用都必须在其所属事件内解析。持久化屏障与物理重读对齐既有回执路径；字节级相同的重复提交复用最新记录，并适用同样的可信请求限制。

与 `work/accepted` 不同，该事件不命名日志前缀，记录确认策略保持不变：后续日志事实既不使内容审核失效，也不把它标记为过期。`workResults/contentReview` 读取最新审核并返回逐版本 currency。没有新的 Host 重读时，每个已确认版本都报告 `not-reverified`；持有新鲜 Host 侧观察的调用方应用纯比较，报告 `matches-confirmed` 或带当前观察身份的 `changed-unreviewed`。这是显式的当前与已确认分离，不是文件监听，也不是重验承诺。

## 资料库与原生打开

`workResults/list` 在不激活 Agent、不扫描设备文件的前提下，从保留的会话集合观察返回有界分页。第一页固定规范查询、会话顺序和查询生命周期；后续分页复用已经观察到的来源清单。活动会话变化会使查询失效。外部冷存储编辑不被全局监听，因此这是已观察集合，不表示所有来源始终未变。来源位置、覆盖遗漏和游标过期均明确返回；详见下文保留的 Library 观察。

`workResults/open` 接收来源 Session id 和确切的已记录路径。记录证明来源，不授予权限。相对路径使用来源目录，绝不使用当前选中的工作区。明确的外部文件和已引入的符号链接仍由既有特权 Host opener 处理；本适配器不另造仅限 cwd 的授权规则。Host 在同一请求内重新检查来源成员，并拒绝操作中发生变化的规范目标，再调用既有 `apiProxy.host.openPath`，保留原生拒绝和取消行为，不使用客户端分离的检查／打开往返。路径是定位符，不是不可变文件身份。

## 配置

| 键 | 默认值 | 含义 |
|---|---|---|
| `scanSessionsPerPage` | `20` | 每页最多检查的 Session 日志数，范围为 1 至 100。 |
| `maxResultsPerPage` | `100` | 每次请求最多返回的产物行数，范围为 1 至 500。 |
| `defaultResultsPerPage` | `50` | 默认行数上限；不能超过最大值。 |

## 模型体验

### 结果记录确认

#### 模型看到什么

不新增 prompt、工具或模型可见消息。`work/accepted` 仅用于日志；SDK session-event 通知保留回执，而不改变 `deriveMessages()`。

#### Token 影响

不增加模型 token。

#### KV Cache 影响

已有模型可见前缀不变。

### Explicit content review

#### 模型看到什么

不新增 prompt、工具或模型可见消息。`work/reviewed` 与 `work/accepted` 一样仅用于日志。

#### Token 影响

不增加模型 token。

#### KV Cache 影响

已有模型可见前缀不变。

## 已知限制与暂缓工作

- 确认绑定 Session 日志前缀，而不是文件哈希。外部文件编辑不一定追加事件；恢复记账也可能在没有新模型轮次时保守地使回执失效。
- 内容审核绑定声明的摘要，不是设备文件。读取 API 在真正重读之前报告 `not-reverified`；两次审核之间没有任何文件监听。
- 原生打开要求文件对 Host 可见。远程执行环境需要自己的导出／定位适配器；本功能不下载或读取远程产物字节。
- 资料库页面是有界观察，不是保留的不可变语料快照。不可用历史及旧版未捕获结果会被报告，并发的相关变化可能要求重试。
- Host 客户端来源继承既有 loopback／浏览器信任边界，不是独立的身份认证或物理用户认证系统。

## Passive Work and history reads

`inspect({sessionId})` 分别返回 Goal、执行、待处理交互、记录审核和已注册上下文来源的观察。它使用 Session Query 与现有 Subagent 目录，不解析冷 Agent，也不申请租约。普通 fork 与委派保持区别。inactive 或不可用子执行不能被解释为成功。各领域时钟独立：`source.current` 只比较目标 Session 的日志切点与运行所有者；覆盖信息说明缺失的运行历史和执行展示上限。来源描述不是 provider 健康探测。

`history({sessionId, beforeSeq?, limit?, snapshot?})` 返回带精确事件位置的有界最终消息文本。前缀摘要绑定后续分页，后续追加可以继续，但替换、修复或前缀变化要求重新读取。它不宣称展示 reasoning、二进制内容或所有日志事件；限制输出页不等于限制底层持久化解码成本。

`review({sessionId})` 只对已经存活的 Agent 执行原有持久化核验；冷记录明确报告 `runtime-unavailable`，不激活执行。旧 `get(agent)` 接口留给未迁移客户端，Product Shell 改用 `review`。现有确认仍绑定 Session 日志，不认证文件内容或测试。

## Retained Library observations

第一页捕获有界、有序的 Session 语料观察。后续分页复用该观察和各来源首次捕获的产物目录，不在每页重新列出或 stat 全部语料。活 Session 使用已有投影；冷来源优先使用已有 projection cache，回退读取也不激活 Agent。活 Session 或产物变更使保留查询失效。外部冷存储变化不被全局监听：这是保留的观察，不是所有当前文件的不可变快照。重新查询或游标过期后取得新观察。

`maxLibraryQueries` 默认 8，`libraryQueryTtlMs` 默认 120000，`maxLibrarySessions` 默认 10000。被省略的 Session 会报告。`observedSessionIds` 支持跨路径分页去重覆盖统计，既有页计数仍只表示本页。`maxExecutionEntries` 默认 200，`maxHistoryRows` 默认 50，`maxHistoryChars` 默认 64000。所有新接口保留精确可信请求和 loopback 限制。
