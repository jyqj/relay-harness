# Agent Note: Relay Harness rename

Status: implemented

[English](2026-08-23-relay-harness-rename.md) | 中文

## Problem

Harness 一直以一个并不属于自己的名字发布。所有 npm 包位于 `@deepseek-ai` scope，二进制名为 `dsh`，环境变量前缀是 `DSH_`，`BRAND_GUIDELINES.md` 还声明了 DeepSeek 商标归属。但本仓库属于 Relay 产品，DeepSeek 只是它通过 HTTP 调用的模型厂商，而非发布方。用别家公司的 scope 发布，是本项目无权做出的声明。

这个 token 还与自身冲突。`dsh` 在树里指代四种不同事物——npm scope 后缀、CLI 二进制、`package.json` 协议命名空间，以及 CSS 自定义属性族 `--dsw-*`——只改一部分会让读者无法分辨哪些出现属于品牌，哪些属于厂商 API 表面。

## Decision

产品名为 **Relay Harness**，缩写 **rlh**。更名一次性覆盖全部品牌所属表面，由 [`scripts/rebrand-dsh-to-rlh.ts`](../../../../scripts/rebrand-dsh-to-rlh.ts) 执行：

| 表面 | 更名前 | 更名后 |
|---|---|---|
| npm scope 与包名 | `@deepseek-ai/dsh-<pkg>` | `@relay-harness/rlh-<pkg>` |
| CLI 二进制与 `pnpm` 脚本 | `dsh` | `rlh` |
| 环境变量 | `DSH_*` | `RLH_*` |
| `package.json` 协议命名空间 | `"dsh": { client, profile, bundle }` | `"rlh": { … }` |
| 浏览器引导全局量 | `window.__DSH_BOOT__` | `window.__RLH_BOOT__` |
| CSS 自定义属性 | `--dsw-*`、`--ds-*` | `--rlw-*`、`--rl-*` |
| 仓库 URL | `github.com/deepseek-ai/deepseek-harness` | `github.com/jyqj/relay-harness` |
| 桌面应用 id | `ai.deepseek.harness.gui` | `com.relayharness.desktop` |
| 移动端 bundle id | `ai.deepseek.harness.mobile` | `com.relayharness.mobile` |

目录名与文件名沿用同一套 token：`.agents/skills/dsh-*` 改为 `rlh-*`，`dshbot` 改为 `rlhbot`，`install-dsh-plugin*` 改为 `install-rlh-plugin*`。

[AGENTS.md](../../../../AGENTS.md) 的预发布立场决定了改动半径：没有外部消费者，因此旧 scope、旧二进制名和旧环境变量都不保留兼容别名。读取 `DSH_*` 变量不是受支持的回退路径，它只是未设置。

有一个变量是从仓库之外读取的，值得单独点名。[`patches/node-pty@1.2.0-beta.15.patch`](../../../../patches/node-pty@1.2.0-beta.15.patch) 让 pty spawn helper 的路径可被覆盖，以适配那些把 helper 放在 addon 同级目录之外的嵌入方，而本仓库中没有任何地方设置它。该覆盖项现为 `RLH_NODE_PTY_SPAWN_HELPER`；仍在导出旧名称的嵌入方会退回到未打补丁的同级查找，而不是报错。这也是 `pnpm-lock.yaml` 中 `node-pty` 的 `patch_hash` 发生位移的原因：变的是补丁文本，不是包版本。

### 更名不触及的部分

三类内容保持原拼写，codemod 为每一类都设了显式保护模式，重跑不会侵蚀它们。

**模型厂商引用。** `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`、`api.deepseek.com`、DeepSeek 模型标识以及 `llm-deepseek` 适配器名，标识的是本项目调用的第三方 API，其可改名程度不高于一个 HTTP 头字段名。

**第三方插件生态坐标。** 桌面市场从 `https://awesome-dsh-plugin.com/plugins.json` 拉取目录，并安装 `dsh-composer-expand`、`github:0xsline/dsh-spotlight` 等社区插件。这些主机名、npm 名与仓库路径归其他作者所有，改写它们会让安装器指向不存在的包。[`apps/desktop/src/main/marketplace-registry-snapshot.json`](../../../../apps/desktop/src/main/marketplace-registry-snapshot.json) 逐字镜像该登记表；codemod 只改写每条 `install` 命令的首个 CLI token，因为只有该 token 指代本仓库的二进制。

**已封存的归档产物。** `.agents/notes/archived/<kind>/` 下的冻结 Agent Note 三元组及其 manifest 保留封存时的用词。[`archived/AGENTS.md`](../../archived/AGENTS.md) 提供读者所需的 token 对照表；该文件属于说明性正文而非封存产物，因此随更名一同改写。

### Telemetry

更名删除了硬编码上报端点，而不是给它换个牌子。会话遥测以关闭态挂载：[`packages/bundle/base/cordis.patch.yml`](../../../../packages/bundle/base/cordis.patch.yml) 将 `mode` 默认为 `DISABLED`，collector URL 只从 `RLH_TELEMETRY_OTLP_URL` 解析，不内置默认值。需要遥测的部署自行指定 collector；未配置的安装不向任何地方上报。

## Alternatives considered

**保留 `@deepseek-ai`，只改产品文案。** 代价最低，却恰好在唯一要紧的层面上是错的：npm scope 是发布身份。一边保留它、一边称产品为 Relay Harness，等于谎报发包方。

**引入 `rlh` 作为别名，逐步弃用 `dsh`。** 在存在外部消费者时这是标准做法，但这里并没有外部消费者。别名会让每个门禁、文档和 fixture 需要覆盖的表面翻倍，换来的却是无人要求的兼容性。AGENTS.md 的预发布立场正是为了拒绝这笔交易而存在。

**保留 `--dsw-*` CSS token 以减少改动量。** 有吸引力，因为 token 名是内部约定，渲染层并不关心。之所以否决，是因为该 token 族是已发布样式表中最显眼的 `ds` 残留，而半改完的词汇表比任何一个端点状态都更难推理。这些 token 与其他部分一同迁移。

**手工编辑而非编写 codemod。** 在约 5700 个文件的规模上直接否决。脚本还让排除项可供评审：受保护片段清单就是"何为厂商表面、何为品牌"的规格说明，任何手工编辑序列都无法陈述这一点。

## Consequences

旧名字彻底消失且无迁移路径，这是在首个 tag 发布前更名所要付出的预期代价。已有 `$DSH_HOME` 目录、`PATH` 上的 `dsh`，或 shell 配置里 `DSH_*` 变量的使用者需要重新配置；磁盘上的会话数据不受影响，因为 `SESSION_FORMAT_VERSION` 未变。

生成产物必须重新生成而非改写，因为其锚点由包名派生：`docs/config-catalog.md` 与 `docs/tool-catalog.md` 现在 slug 为 `relay-harnessrlh-*`，所有入链——包括生成器不产出的中文译文——都已重新指向。

codemod 在迁移后保留在树内。它是幂等的——任何规则的输出都不匹配任何规则的输入——因此重跑即可发现被重新引入的零星 `dsh`，而受保护片段清单以可执行形式记录了厂商与品牌的边界。

第三方市场坐标仍是脆弱之处。它们读起来像品牌 token，且只在安装或拉取时才失败，离出错的那次编辑很远。受保护模式逐一列举了受影响的插件名，因此当登记表快照新增一个 `dsh-` 前缀的社区插件时，需要先把该名字加入清单，再重跑 codemod。[`apps/desktop/vendor/plugins.json`](../../../../apps/desktop/vendor/plugins.json) 中 vendored 插件的 `upstream` 坐标同理：`npm:dshmarket` 指代该 drop 的来源包，因此 codemod 保护整个 `"upstream": "npm:…"` 值，而不是其中某一个名字。

按裸 token 保护这些名字，代价是另一个方向上的精度，有一处只能手工修正：`dsh-web-ui` 既是目录中以裸名列出的社区插件，也是 [GUI 分层与 RPC 协议](../architecture/2026-07-19-gui-layering-and-rpc-protocol.md)中一条被否决的替代方案给本仓库自有包起的名字。保护同时覆盖了两者，因此更名后该 Agent Note 仍留着一个 `dsh-` 名；现已改为 `rlh-web-ui`。一个同时指代社区插件与本仓库包的 token 无法用模式区分——引用了受保护名字的散文需要人工核对。

有一个表面完全逃过了 codemod：DOM 属性 `data-ds-dark-theme` 没有对应规则（codemod 映射了 CSS 自定义属性前缀 `--ds-`/`--dsw-`/`--dsh-`/`--dsl-`，却没有 `data-ds-` 属性），因此 86 处、50 个文件一直保留旧 token，直到 2026-08-26 以 `packages/client/ui-layout/src/client/theme-presenter.ts` 中的 `DARK_ATTRIBUTE` 常量为锚点，一次性更名为 `data-rl-dark-theme`。
