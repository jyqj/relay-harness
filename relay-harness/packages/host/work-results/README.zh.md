# @relay-harness/rlh-host-work-results

[English](README.md) | 中文

用于显式确认结果记录和跨会话发现产物的 Host 适配器。Session 日志仍是唯一持久权威；本包不创建 Work 数据库，也不改变 goal 的 phase。它拥有纯 `deliverables` 与 `workAcceptance` 投影，既有承载通道发布这些投影，`ui-product-shell` 负责消费。`ui-deliverables` 只拥有回复指导和逐轮呈现。

## 确认

`workResults/accept` 要求原始、仍活动的可信 Connection 请求恰好对应此端点，且不存在 agent initiator。客户端提交所审阅的最后一个非确认日志序号。Host 要求确切的活动根 agent、已结束的轮次、空待处理 inbox、没有所属的 running/stopping job，以及没有待处理的 ApiProxy 审批或问题。既有 Agent maintenance 事务使确认与其他维护串行，并将新的驱动输入排队；初次 flush 后，Host 在追加 `work/accepted` 前立即重新检查调用方、取消、资格和修订值。

回执记录 `reviewedThroughSeq` 和 `actor: 'host-client'`。它不会使自身失效，后续日志事实则会。同修订值重试复用回执，并发维护竞争者可能被拒绝。只有持久化屏障完成且物理读取确认回执后，操作才返回成功。未收到成功不证明记录不存在：稍后的重试可以确认已有记录而不再追加。

`workResults/get` 在等待前捕获一个审阅切面，flush 已接受工作，并检查物理回执及覆盖该切面的存储尾部。它返回 `verifiedThroughSeq` 和该切面是否仍为当前切面，绝不把更晚的内存序号升级为持久性声明。原始投影不是持久化证明。客户端只在安静的审阅时点验证；流式变化使较早的确认失效，而不会逐 chunk 触发 flush。

这些是既有可信 Host 客户端提交的确认，不是物理人点击的密码学证据。四个端点都按既有 Connection 策略限定为 loopback。确认不授予 agent 权限、不证明测试结果，也不证明文件未变化或子 agent 树已完成。

## 资料库与原生打开

`workResults/list` 分页扫描既有 Session Query 日志，不激活 agent，也不扫描设备文件。它筛选执行时捕获的产物路径，返回来源 Session id，并报告已扫描／总会话数、历史未捕获结果、不可用会话和续页信息。不透明续页修订值绑定规范化查询、Session 顺序、活动产物投影及冷存储修订值；相关事实变化要求重新开始，而不是静默漏掉较早页面新增的产物。扫描前后的修订检查会拒绝变化中的扫描，而不宣称页面已一致完成。

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

## 已知限制与暂缓工作

- 确认绑定 Session 日志前缀，而不是文件哈希。外部文件编辑不一定追加事件；恢复记账也可能在没有新模型轮次时保守地使回执失效。
- 原生打开要求文件对 Host 可见。远程执行环境需要自己的导出／定位适配器；本功能不下载或读取远程产物字节。
- 资料库页面是有界观察，不是保留的不可变语料快照。不可用历史及旧版未捕获结果会被报告，并发的相关变化可能要求重试。
- Host 客户端来源继承既有 loopback／浏览器信任边界，不是独立的身份认证或物理用户认证系统。
