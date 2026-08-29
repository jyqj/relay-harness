# Agent Note: 将依赖升级分批安排在更名之后，而不是塞进更名里

Status: proposed

[English](2026-08-23-staged-dependency-upgrades.md) | 中文

## Problem

`dsh` → `rlh` 更名整体重新生成了 `pnpm-lock.yaml`：281 个 workspace 包全部改名，因此 lockfile 的 diff 几乎全是更名产生的噪声。此时再去改动依赖版本恰恰是最糟糕的时机。审阅者若想从 lockfile 中确认"更名有没有意外改动某个解析结果"，一旦升级混在其中就无从判断；而某个回归即便被 bisect 定位到更名提交，也同样可能出自被顺带提升的传递依赖。

与此同时，积压确实存在，且分布并不均匀。`pnpm outdated -r` 报告有 63 个不同的包落后于 latest，它们并非同一类：

| 级别 | 数量 | 性质 |
|---|---|---|
| major | 21 | 生态级迁移。React 18 → 19、TypeScript 6 → 7、Vite 5/6 → 8、`js-yaml` 4 → 5、`zustand` 4 → 5、`@agentclientprotocol/sdk` 0.25 → 1.4。 |
| minor | 26 | 多数是增量式的，但也包含影响面很广的项：`oxlint`（新规则会以新的失败形式出现）、`@anthropic-ai/sdk` 0.93 → 0.120、`e2b` 2.29 → 2.45、`katex` 0.16 → 0.18。 |
| patch | 16 | 工具与叶子库的缺陷修复：`vitest`、`tsdown`、`esbuild`、`koffi`、`ws`、`execa`、`lefthook`。 |

把它们当作一件事来做，结果要么是升级停滞，要么是没法审阅。

## Proposal

更名 PR 中不落地任何依赖升级，之后分三批处理积压，每批各自成 PR、可独立回滚。

**第一批 —— patch。** 16 个 patch 提升在一次 `pnpm update -r` 中完成。按约定它们不带 API 变更，因此整批共用一套验证：`pnpm run doc-sync`、`pnpm run lint`、`pnpm run typecheck` 以及完整测试套件。整批通过就作为一个提交落地；若某个包出问题，剔除该包重跑，而不是把这批拆开。

即便在 patch 级别，仍有两项值得单独说明。`koffi` 3.1.1 → 3.1.6 是沙箱、文件系统与子进程包在 Windows 和 macOS 上依赖的原生 FFI 插件 —— Linux CI 大部分覆盖不到。`esbuild` 0.28.1 → 0.28.2 处于 1.0 之前，按生态惯例破坏性变更就落在 patch 位上；请阅读其 changelog，不要凭版本号形状判断。

*修订 —— 第一批已在更名分支上落地。* 按请求方要求，第一批不再另开 PR，而是作为更名分支上的一个独立提交落地。下方验收标准想从 PR 边界拿到的东西 —— 一份审阅者可以当作纯更名来读的 lockfile —— 提交边界同样给得出：更名提交不移动任何第三方版本，随后那一个提交也不夹带别的改动。两份 changelog 都已读过，全部是缺陷修复。`koffi` 3.1.2 修掉了字符串长度计算中的缓冲区溢出，3.1.3 改为正确识别 libc，使 musl 与 Alpine ARM64 主机不再在加载时崩溃，3.1.6 修掉了在加载任何库之前调用 `register()` 的崩溃；`esbuild` 0.28.2 修掉了经由 TypeScript `import` 别名的 tree shaking，以及 CSS 压缩器误删本该保留的 `&`。

十六项中落地了十五项。`@anthropic-ai/claude-agent-sdk` 0.3.220 → 0.3.240 依据本批自身的规则被剔除，因为 patch 位低估了它：该版本随附一整套 Claude Code 构建，而新构建拒绝已禁用的 `ExitPlanMode` 时用词不同，`packages/subagent/subagent-claude-code` 的真实产物套件正断言在这句话上。这是一份需要重新阅读的 fixture，而非机械提升，因此它属于第二批的模型 SDK 组，与 `@anthropic-ai/sdk` 同行。

**第二批 —— minor，分三组。** 按影响半径切分，让失败能指向自身成因：

- 把守 CI 的工具链（`oxlint`、`knip`、`playwright`、`publint`、`pnpm`、`lefthook`）。新版 linter 会带来新规则，要预留处理或显式关闭这些发现的成本；一次静默的 `--fix` 会把真正的问题一起埋掉。
- 模型与沙箱 SDK（`@anthropic-ai/sdk`、`@openai/codex`、`@earendil-works/pi-ai`、`@modelcontextprotocol/sdk`、`e2b`）。这些包的真实行为只在带密钥的测试中显现；请运行那些用例，不要依赖无密钥套件。
- 渲染与叶子库（`shiki`、`@shikijs/langs`、`katex`、`mermaid`、`lightningcss`、`fast-check`、`smol-toml`、`tsx`、`use-sync-external-store`）。这一组的预期结果就是快照变动；请审阅渲染后的 diff，而不是一律更新快照。

*修订 —— 第二批已作为三个提交在更名分支上落地。* 理由与第一批相同：让一次提升可回滚的是组的边界，而不是 PR 的边界，三个提交给出三条边界。工具组移动了 `oxlint` 1.76.0 → 1.79.0、`playwright` 1.61.1 → 1.62.1、`pnpm` 11.8.0 → 11.22.0、`@yarnpkg/cli-dist` 4.17.1 → 4.18.0 与 `eslint-plugin-sonarjs` 4.1.0 → 4.2.0。模型组移动了 `@anthropic-ai/sdk` 0.93.0 → 0.120.0、`@anthropic-ai/claude-agent-sdk` 0.3.220 → 0.3.240、`@openai/codex` 0.147.0 → 0.149.0、`@modelcontextprotocol/sdk` 至 ^1.30.0（连同 `@modelcontextprotocol/server-everything` 2026.7.4 → 2026.8.18）以及 `e2b` 2.29.1 → 2.45.0。渲染组移动了 `shiki` 与 `@shikijs/langs` 4.3.1 → 4.4.3、`katex` 0.16.47 → 0.18.4、`mermaid` 11.16.0 → 11.17.0、`lightningcss` 1.32.0 → 1.33.0、`fast-check` 4.8.0 → 4.9.0、`smol-toml` 1.7.1 → 1.8.0、`tsx` 4.22.4 → 4.23.12、`use-sync-external-store` 1.2.0 → 1.6.0，以及四个 `@opentelemetry/*` 日志包 0.220.0 → 0.221.0。

分组预判对了工作的形状，却未必对了方向。linter 确实改了规则，只是方向与预算的相反：`oxlint` 1.79 不再对转义控制字符报 `no-control-regex`，于是发现的是 `reportUnusedDisableDirectives` 之下的一条无用抑制，是删掉而不是新增。两处真正的契约位移都出自模型组 —— Claude Code 2.1.240 拒绝已禁用的 `ExitPlanMode` 时换了措辞，Codex 0.149 新增第十二个 `codexErrorInfo` 变体 `misalignmentPolicyViolation`，wire 现在直接命名它，而不再折叠为 `unknown`。渲染组给出了它应当给出的快照变动，且仅此而已：KaTeX 0.18 为其自身 HTML 分支内部那些过于通用的类名加了前缀（`base` → `katex-base` 及同类），我们的样式表与断言都不读这些名字，因此两份 math DOM 对照 fixture 恰好只按这一次改名位移。

有两个原定包依据本批自身的规则被剔除，仍然悬而未决。`knip` 6.16.1 → 6.32.2 没有可以出发的绿色基线 —— `pnpm run knip` 在本分支头部已经是红的，因为 `apps/desktop` 进来时没有对应的 knip workspace 条目 —— 而 6.32 又几乎替换了整套发现集合，因此调和它是一次配置修复，不是一次提升。`@earendil-works/pi-ai` 0.82.1 → 0.84.2 破坏的是适配器断言的两项契约，而非一个版本字符串：携带 `maxTokens` 的请求不再以 `max_completion_tokens` 抵达 provider，而已经处于 abort 状态的调用方 signal 会让流以 `error` 而非 `aborted` 收尾 —— 那会把用户取消报成失败。两者各需自己的改动与自己的笔记。

**第三批 —— major，每个包或每组耦合项单独一个 PR。** 这些是迁移而非升级，而且其中若干彼此耦合：

- `react` + `react-dom` + `@types/react` + `@types/react-dom` + `@vitejs/plugin-react` 一起走；`zustand` 4 → 5 与 `use-sync-external-store` 也应并入同一次改动，因为 zustand 5 移除了默认导出，而 React 19 让那层 shim 不再必要。
- `typescript` 6 → 7 与 `typescript-language-server` 5 → 6 一起走。这一项的影响比 diff 看上去更远：`packages/typert` 依据 checker 生成类型模型，其快照编码了 checker 内部的 type id。
- `vite` 5/6 → 8 要跨两个大版本，每一跳都有插件 API 破坏，而当前仓库同时存在两个大版本；先统一到一个，再跨到 8。
- `js-yaml` 4 → 5、`chokidar` 4 → 5、`immer` 10 → 11、`supports-color` 9 → 11、`eventsource-parser` 3 → 4、`@babel/code-frame` 7 → 8 相互独立，各自体量都足以单独成立。
- `@agentclientprotocol/sdk` 0.25 → 1.4 在一个线协议上跨越了 1.0 边界。它需要把 ACP 示例的快照套件重新录制并逐条阅读，而不是简单刷新。

三批按 1 → 2 → 3 顺序推进；第三批内部先做 TypeScript 再做 React：checker 不同时移动时，React 迁移更容易读懂。

## Alternatives considered

**把 patch 升级并入更名 PR。** 之所以诱人，是因为 patch 提升单个来看足够安全，还能省下一个 PR。之所以否决，是因为代价不在任何单个提升的风险，而在于 lockfile 作为可审计产物的价值被抹去。更名已经重写了 `pnpm-lock.yaml` 中每一条 workspace 记录；能够证明更名没有扰动任何解析结果的唯一信号，就是没有任何第三方版本发生位移。加入 16 处有意的版本变动恰好抹掉的正是这个信号，而进度上一无所得。

**全量升级再修善后。** 一次 `pnpm update -r --latest`，然后一路追修到全绿。之所以否决，是因为 React 19、TypeScript 7 与 Vite 8 各自的变更量足够大，其失败会互相交织：一个在 React 19 下损坏的组件与一个在 TypeScript 7 下失效的类型，呈现出来是一堵无从区分的报错墙，而且一旦共处同一提交，两者都无法独立回滚。

**锁定当前版本，不再跟进。** 宣布当前版本即受支持集合。之所以否决，是因为其中若干属于安全相关面 —— `ws`、`koffi`、沙箱与模型 SDK —— 原地不动本身就是风险；而且差距只会越拉越大：React 18 → 19 今天已经比过去更难，下个季度只会更难。

**改用 Renovate 或 Dependabot，而非分批计划。** 就第一批和第二批而言，自动化才是长期正解，本笔记并不反对。但它替代不了第三批：机器人能开出 React 19 的 PR，却做不了其中的迁移决策；而在 63 个包的积压上直接打开机器人，只会产生一个无人审阅的队列。应把它排在第二批之后 —— 那时剩余积压已小到机器人的产出可被审阅。

## Acceptance criteria

- 更名提交中的 `pnpm-lock.yaml` 只体现 workspace 更名，不含任何第三方版本变更。唯一的非更名条目是 `node-pty` 的 `patch_hash`，它位移是因为补丁文本中带有一个被改名的环境变量；解析出的版本没有变化。移动第三方版本的是第一批自己的那个提交，而它不夹带别的改动。
- 第一批作为一个提交落地，`doc-sync`、`lint`、`typecheck` 与完整测试套件全绿，且 `koffi` 与 `esbuild` 的 changelog 是读过的而非假定的。
- 第二批作为三个提交落地，各自可独立回滚，新增的 lint 发现被逐一处理而非整体压制。
- 第三批每次迁移一个 PR，凡改变可观察契约者各自附带 Agent Note；SDK 跨版本一项须重新录制并审阅 ACP 快照套件。

## Risks

分批比一次性推进更慢，而积压会在推进过程中继续增长 —— 等第三批开始时，第一批涉及的包又已前移。这一点是接受的：重跑第一批之所以便宜，正因为它是机械性的。

该计划所假设的 CI 覆盖，Linux CI 并不能完全提供。`koffi` 驱动 Windows ACL 沙箱与 macOS 文件系统路径，而带密钥的模型测试在无 secret 时会跳过。某一批可能在 CI 全绿，却在某个门禁未覆盖的平台或路径上回归；第三批叠加之前，第一、二批应在真实桌面构建上验证。

推迟 major 意味着仓库在整个分批期间都运行在 React 18 与 TypeScript 6 上，期间新写的客户端代码是针对旧 API 编写的，在 React 19 迁移时可能需要回头修改。
