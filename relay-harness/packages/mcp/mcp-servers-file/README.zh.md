# @relay-harness/rlh-mcp-servers-file

[English](README.md) | 中文

负责 `$RLH_HOME/mcp-servers.yaml`（或显式 `path`），并为每条已启用记录挂载一个 [`@relay-harness/rlh-mcp-client`](../mcp-client/README.md) 子实例。HTTP endpoint 必须是绝对 HTTP(S)，不能包含 URL credential、fragment 或 secret query key，credential 必须放在 header。写入走 atomic-write 锁；监视器在外部编辑后重新挂载子实例。`authorize` 在系统浏览器里跑 MCP HTTP OAuth（PKCE），把 `Authorization: Bearer …` 写进该记录并重新挂载。`listManaged` 会掩码看起来像密钥的 env/header 以及 legacy URL value；upsert 里的空字符串或 `********` 会保留已存值。

OAuth 元数据、客户端注册和 token 交换都要求 HTTP 响应成功，才允许其 JSON 字段驱动后续操作。HTTP 状态与 JSON 校验诊断不包含响应体。注册或 token 交换失败时，已创建的回调监听器会被关闭。 本地回调只有在 GET 方法且 state 匹配时才消费 code 或授权错误；无效请求不会终止当前登录。仅允许一个等待，超时后可重新等待；幂等关闭会拒绝未结算等待并清除其定时器。浏览器启动异常不会遗留无人观察的回调 Promise 拒绝。 浏览器打开操作等待共享 `rlh-native-command` 执行器，并设置十秒取消期限，不再启动无人观察的 detached 子进程。目标必须为不含内嵌凭据或 fragment 的 HTTP(S) URL。Windows 使用转义后的 PowerShell 字面量，而非 `cmd /c start`；原生命令错误会替换为不含响应体的诊断。Windows 原生执行需要独立发布证据，不能由离线 argv 测试推定。

OAuth 结果绑定发起登录时的 HTTP URL。保存 bearer 前，写入操作在跨进程文件锁内重新读取文档，拒绝已删除、已改为非 HTTP 或 URL 已变化的记录，并保留较新的无关字段和其他记录。文档不可读或格式损坏时，修改会被拒绝，不会用内存缓存覆盖磁盘；只读刷新仍保留最后有效文档。

每个服务实例只允许启动一次；再次启动会在创建第二个后台 owner 之前被拒绝。关闭时会同步拒绝新的操作。幂等 disposer 返回同一个 Promise，等待启动及此前已准入的修改完成、关闭 watcher，并等待全部子级 disposer，即使其中有一个失败。关闭后 reconcile 不会挂载替代实例，晚到的 OAuth 结果也不能持久化。服务先中止活跃 OAuth 的生命周期，再等待授权任务结算。取消信号会传到网络请求、原生浏览器打开和回调等待；每个 HTTP 请求另有覆盖响应体读取的三十秒取消期限。注入的运行时必须响应取消；关闭不会悄悄放弃仍未停止的实现。

OAuth JSON 响应体限制为 1 MiB：提前检查声明长度，并独立累计流式解码后的字节，即使服务器省略或低报长度也受约束。读取器释放锁并取消放弃的响应体；挑战和 HTTP 错误响应体直接丢弃，不做缓存。监听器关闭还会销毁其自身的活动连接，未完成的回调请求不能拖住关闭。若绑定地址校验失败，会先关闭监听器再拒绝启动。

两种受管列表投影都返回分离的快照，包括嵌套的 headers、环境变量映射、参数及重连设置。修改返回快照不能改变服务持有的文档或已挂载子级配置。原始投影仍有意保留 secret 值；分离只保证状态所有权，不是脱敏或权限边界。

Watcher 完成初始扫描后会排队重读磁盘，补回启动快照之后、监听建立之前的修改。该协调与后续文件事件共用串行操作队列，关闭后不再准入。Watcher 将解析后的外部文档与当前内存文档比较去重，而非与历史自身写入内容比较，因此恢复旧配置仍会作为真实更新处理。外部 YAML 损坏时保留最后有效的运行配置且不重写文件；删除文件会清空受管列表，同一个 watcher 也会观察后续重建。

Watcher 的错误事件会被捕获并报告，不回显错误详情；当前配置仍可用，后续有效文件事件仍可生效。即使调用方尚未等待就绪，后台启动失败也会被观察；等待就绪的调用方仍接收原始失败。后台读取和解析诊断不包含 YAML 片段或配置值。

授权服务器发现遵循 [RFC 8414 第 3.1、3.3 节](https://www.rfc-editor.org/rfc/rfc8414.html#section-3)：well-known 前缀插入 issuer 路径之前，返回元数据的 issuer 字符串必须与发现值完全一致。Issuer URL 要求 HTTPS，并在读取元数据前拒绝凭据、query 和 fragment。这些检查不表示已完整支持全部 OAuth 发现扩展。

使用受保护资源元数据中的授权服务器列表前，必须核对其 resource 与原请求资源完全一致，包括元数据地址来自挑战响应头的情况。备用发现地址保留非根资源路径和 query。这些身份检查依据 [RFC 9728 第 3 节](https://www.rfc-editor.org/rfc/rfc9728.html#section-3)。

公布的授权服务器和 scope 集合必须是数组，且成员都是非空字符串；格式错误会在创建监听器前被拒绝。选择策略仍使用首个 issuer 和 scope，不会自动请求全部已公布 scope。

授权、注册和 token 端点必须是不含凭据或 fragment 的绝对 HTTPS URL，并在创建监听器前校验。OAuth 传输对探测、元数据、注册和 token 请求都不自动跟随重定向；服务器须直接提供最终端点，避免后续重定向绕过准入或把授权请求转发到其他位置。

OAuth 资源 URL 要求 HTTPS，仅对 `127.0.0.1`、`localhost` 和 `[::1]` 的 HTTP 开发 origin 例外。明文 HTTP 资源元数据仅允许与此类资源同源；HTTPS 元数据可以显式委托给其他 origin。两类地址在网络准入前都拒绝内嵌凭据与 fragment。此 OAuth 规则不改变通用受管传输的 URL schema。

## 模型体验

无，因为本包只挂载已定义的 mcp-client 实例，自身不组装提示词、工具或提供方请求。

#### KV Cache 影响

无；本包从不组装模型输入。

## 已知限制与暂缓事项

- **不从 Cursor 或 Claude 的 `.mcp.json` 导入** — 文档格式留给后续导入器；本包只读自己的 YAML。
- **组成配置里的 mcp-client 行不写入此文件** — 手写的 `cordis.patch.yml` 实例不会被改写。
- **OAuth 访问令牌会过期** — 没有 refresh token 续期；服务器再返回 401 时从 Settings 重新登录。
