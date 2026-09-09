# Round 5 — 后端优化实施（2026-09-03）

依据 `round-4-backend-audit.json` 的 10 切片计划（含对抗验证修正），10 个实施 agent 并行落地，全部 TDD failing-first。

## 已落地（10/10）

- **R5-A hooks-claude-code Stop 循环护栏**：镜像 codex 已有的 `stop_hook_active` 每 turn 一次强制续跑语义；deny-loop 不再无限烧 provider 请求。README 双语 + Agent Note。
- **R5-B apiproxy 束**：FrameQueue 加 `muxStreamBufferBytes`（默认 8MiB）上限，慢消费者安全断开（复用客户端重连+基线重放）；`session.prompt`/`selectModel`/`agentPresets.select` 收敛到 per-session 操作链（消除 preset 切换 TOCTOU 与并发 prompt 交错 append）；冷探测 attach 竞态跳读。
- **R5-C TS SDK 生命周期**：协议新增 `session/close`；server `closeSession`（未知 id 响亮报错）；TS client 默认路径 per-run 会话用完即收（显式 sessionId 保持调用方所有）；close 对先于 start 的订阅 fail。
- **R5-D Python SDK 对齐**：`session_close` 镜像；start 双 spawn 加锁 + `RelayHarness.start` 邻接守卫；initialize 校验、畸形事件 fail-loud、close 可重启→terminal 契约修正、teardown 宽限对齐。`pytest` 83 tests passed。
- **R5-E jobs-local 保留策略**：`terminalRetentionMs`（60s）+ `maxTerminalRecords`（100，per-owner 桶 FIFO）双字段；永不剪未 reported 的终态（保 at-least-once 通知）；剪后读响亮 `unknown job`。
- **R5-F SQLite 束**：session-query live 观测缓存（引用相等即字节等价，搜索不再每次全语料重指纹）；storage-sqlite 补 `STORAGE_SQLITE_APPLICATION_ID` 所有权拒绝协议（外来库/缺表 fail-loud，镜像两个兄弟后端）。
- **R5-G atomic-write 陈旧锁自愈**：锁 payload 加 hostname，同主机可证死 pid（ESRCH）自愈；外来主机/活进程/畸形 payload 保持响亮超时。解锁凭证/设置写入。
- **R5-H persistence teardown**：复合 generator effect 固化「先移除监听器再 drain」（经探针实证 Cordis 反序拆卸后修正计划方向）；retire 失败武装一次退避重试，同 id 重建报原始写错误而非误导 collision。
- **R5-I subprocess/spill**：spill I/O 失败降级为 lossy 内存 tail（原来在 stream data 回调内同步抛→进程崩溃）；`SpillStore.disposeSession` 接线 session disposal；`orphanRetentionMs`（默认 7 天）启动清扫孤儿根。
- **R5-J desktop**：损坏 config.json/credentials.json 响亮报告并隔离为 `.corrupt-*`（不再静默重置销毁用户数据）；端口击杀收敛到 rlhd-web.pid 已证明所有权（不再 taskkill 无关 node 进程）；POSIX 子进程 `detached:true` 真覆盖进程树。

## 父轮统一验证与修复

- `pnpm run typecheck`：修复 4 处残留后 exit 0 —— R5-C 漏了 `SessionCloseParams` 的 `src/index.ts` re-export（补上并重建 protocol lib）；3 个新 spec 的 strict TS（`UserMessage` import、`exactOptionalPropertyTypes` 非空断言、未用 import）。
- `pnpm run build` exit 0。
- Python SDK：83 passed。
