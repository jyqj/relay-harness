# Client Product Shell

[English](README.md) | 中文

Chat、Work、Library 的共享浏览器产品壳。浏览器入口仅将 `apply` 和 `inject` 作为值导出；可见性策略保留在内部。

Simple Mode 会隐藏高级 model/preset/plugin/trajectory control，但保留 Context Inspector provenance surface。Work 读取既有 Goal、Plan、Jobs、Trajectory、Deliverables、Approval、Question 与 Session projection；Library 打开既有 Files 与治理 Settings surface。打开交付文件时，将来源 Session 与执行记录中的精确路径交给 [Host](../../host/work-results/README.md) 检查索引与路径；浏览器不重写路径，也不把当前选中工作区强加为其根目录。

Work 的交付文件索引来自 Host 的全会话 `deliverables` 投影，不读取已加载聊天时间线。旧成功结果缺少采集信息时显示历史不完整；没有投影时显示索引不可用。轨迹计数明确只包含已加载记录。执行、Goal 阶段、待处理的人类输入与审核是独立事实。失败和被终止的 Job 计数只描述可见后台任务列表，不代表整个任务的结果。Work 明确显示工作区与 Session，没有 Goal 的可审核结果也会突出提示。流式更新未改变 Work 事实时保持快照引用稳定。文件打开失败在页面内提供重试和关闭，上一 Session 的迟到结果不会重新打开错误提示。

Work 将执行状态与对 Session 日志前缀的显式确认分开。原始回执投影触发失效或验证，但不证明持久性。安静视图读取 `workResults/get`；其已验证切面、成功确认响应、取消和迟到响应检查，阻止未保存或已过期的回执显示为当前确认。资料库通过 Host 检索有界页面，并按每行的来源 Session 身份打开文件，明确展示历史不完整和续页信息。确认不证明测试、文件版本、权限或所有子任务完成。

Work 只有在 Connection 完成握手后的同步，且 Session 历史窗口已打开、未被移除时，才允许确认结果和打开文件。在断线、同步、历史加载、失败或移除期间，已读取的记录仍保留显示，并明确解释当前不可用状态。每次新握手递增 epoch；即使 Session 和日志修订号相同，核验也归属于该 epoch。过期命令与核验回包不能发布到新连接。连接就绪不代表所有可选提供方或其他 Session 都已成功加载。

资料库在一次扫描的成功页面间保留已发现的采集缺失与不可读 Session 信息。数值计数仍只对应本页，因为同一个 Session 可以跨越多个路径分页。最终游标不会清除此前缺失。重试失败页面保留已提交查询和游标；重新检索则丢弃累积产物与缺失标记。重新连接后，浏览器从第一页重查已提交查询，不复用旧游标，也不提交尚未完成的搜索框草稿。新握手下的扫描返回前不能打开其产物。读取失败与原生打开失败分别处理。

模式重读会先等待本地已准入写入结算，再读取 Host，包括持久化被拒绝的情况。这可防止连接重置将提交前的旧值发布到待确认选择之上。模式操作属于插件实例生命周期。卸载开始后立即阻止新操作，清理会永久使待处理代次失效。生命周期结束后的晚到回复不能发布模式变化或启动原生镜像写入。

## 模型体验

### 不直接发起模型请求

#### 模型看到什么

模型不会看到来自本包的内容。`productMode`、Work 与 Library 只是既有 Host 与 Session 状态的浏览器投影。

#### Token 影响

为零。更改产品壳不会追加 Session event，也不会准备模型上下文。

#### KV Cache 影响

无。产品壳只改变可见控件与导航，不改变模型请求或 cache prefix。

## 已知限制与延后工作

- 当前沿用侧边栏作为顶层导航宿主；Work 与 Library 是紧凑侧边栏页面，而不是独立中心栏路由。
- Product mode 暂无 Host push event；写成功后本地折叠，重连时重新读取持久值。
