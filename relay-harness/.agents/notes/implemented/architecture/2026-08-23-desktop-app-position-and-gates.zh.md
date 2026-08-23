# Agent Note: Desktop app position and static gates

Status: implemented

[English](2026-08-23-desktop-app-position-and-gates.md) | 中文

## Problem

`apps/desktop` 是仓库中最大的、没有任何静态门禁读取的代码体：96 个非测试文件、约 38000 行纯 JavaScript，在本次改动前，覆盖它的自动化信号只有 `node --test`。根 oxlint 配置启用类型感知，因而直接忽略 `**/*.js`；桌面端又不属于任何 TypeScript project，于是 `pnpm run lint` 与 `pnpm run typecheck` 从未看过它。一次改名漏掉某个 `require` 路径，或重构留下的死函数，只有在用户启动应用时才会暴露。

[Relay Harness 更名](../process/2026-08-23-relay-harness-rename.md)让这个缺口变得具体：把 `install-dsh-plugin-client.js` 改名，意味着树内每一处 `require` 都必须跟进，而能发现遗漏的只有测试套件。

它的位置也悬而未决。仓库现在在 harness 之上托管了一层 Relay 产品文档（[ADR-0005](../../../../../docs/adr/0005-adopt-ts-harness-runtime.md)），这就引出一个问题：Electron 壳层究竟是 harness 的应用，还是应当上移到外层仓库根目录的 Relay 产品壳。

## Decision

桌面端保留在 `apps/desktop`、留在 harness 的 pnpm workspace 内，并接入仓库的静态门禁，而不是搬家。

### 位置

壳层是 harness 之上的应用，不是它的对等物。源码启动时 [`harnessRoot()`](../../../../apps/desktop/src/main/paths.js) 把 harness 解析为 `apps/desktop/../..`，`setup:harness` 通过 `pnpm --dir ../..` 构建，所有根级便捷脚本都用 `pnpm --filter relay-harness-desktop` 驱动它。`apps/*` 是 workspace glob，因此壳层共享根 lockfile、固定的 Electron 工具链，以及同一次安装。

上移到外层仓库根目录会切断这一切：需要第二个安装根与 lockfile，需要为源码与打包两种模式重写 harness 根解析，CI lane 也无法再经由 harness workspace 触及它。换来的只是一条另一侧无人认领的仓库边界。Relay 的运行时**就是**这个 harness，所以壳层与它启动的运行时属于同一次安装。

### 静态门禁

三个门禁覆盖壳层，均可从仓库根运行，且都与既有的桌面测试门禁一起接入 CI 静态 lane：

| 门禁 | 脚本 | 读取内容 |
|---|---|---|
| `desktop-tests` | `pnpm run test:desktop` | `node --test` 套件 |
| `desktop-typecheck` | `pnpm run typecheck:desktop` | 对已开启文件执行 `tsc` |
| `desktop-lint` | `pnpm run lint:desktop` | 不依赖类型的 oxlint 规则 |

[`apps/desktop/tsconfig.json`](../../../../apps/desktop/tsconfig.json) 设置 `checkJs: false`，因此类型检查以**逐文件**方式开启，靠文件首行的 `// @ts-check` 声明。96 个非测试文件中已有 67 个带上该声明，因为它们本就干净；其余 27 个尚未标注。带声明的文件即门禁，必须保持无错。扩大覆盖的方式是修好某个文件的类型并在同一次改动中加上声明；绝不能为了让改动通过而删除声明。`src/main/release-ui-walk.js` 与 `src/main/composer-official-qa.js` 整体排除——它们是在实时 Electron 页面内求值的发布 QA 脚本，打包产物本就不含它们。

[`apps/desktop/.oxlintrc.json`](../../../../apps/desktop/.oxlintrc.json) 是独立配置，而非在根配置上开的例外，因为根配置的 `typeAware: true` 恰恰是纯 JavaScript 在那里无法被 lint 的原因。打开它发现了 16 个真实问题，包括 `workspace-fs.js` 里已死的 `asCwd`，以及某测试 `finally` 块内的 `throw`——它会把该测试中任何断言失败替换成清理错误。

### 被 vendor 的 `node_modules` 保持入库

[`apps/desktop/vendor/rlhmarket/node_modules`](../../../../apps/desktop/vendor/rlhmarket/README.md) 有 249 个入库文件——`undici`、`js-yaml`、`argparse`，约 2.7 MB。它们是承重件，不是残留。[`rlhmarket-preset.js`](../../../../apps/desktop/src/main/rlhmarket-preset.js) 会把整个 vendor 树复制到用户的 web profile，并在任一声明的运行时依赖缺失时快速失败，同时剥离其托管的 `cordis.patch.yml` 区块，使 Loader 不会挂载半装状态的插件。取消入库会让首次启动依赖一次网络安装，也会破坏离线随包分发市场的 electron-builder `extraResources` 路径。

## Alternatives considered

**把壳层移到顶层 `apps/desktop`，作为 Relay 产品壳。** 最有力的理由是：Relay 的产品表面就是桌面应用，而外层仓库才是 Relay 所在之处。它输在上文的耦合上——harness 根解析、共享 lockfile 与 Electron 固定版本、CI lane 都假定同一个 workspace——而且这次拆分需要有人认领一条其实并无第二个团队在背后的边界。若 Relay 将来推出不内嵌本 harness 的壳层，可重新考虑。

**抽成独立包并配上真正的构建流水线（打包、转译）。** 壳层是由 Electron 直接加载的 CommonJS，没有构建步骤，这正是源码启动瞬时可用、堆栈直指所编辑文件的原因。引入 bundler 只为一个体积由 Electron 主导的应用换来 tree-shaking，代价是失去这种直接性。本次加入的类型检查已经拿到了人们通常寄望于构建步骤的大部分安全收益。

**把壳层改写为 TypeScript。** 这是诚实的终点，但 38000 行无法一步抵达。`// @ts-check` 阶梯是同一套类型系统的增量施加，不需要语法迁移也不需要构建步骤，而且它可以走完——96 个文件全部标注——之后才需要决定 `.ts` 是否值得一个编译阶段。

**为该应用全局开启 `checkJs`，再抑制那 126 个失败。** 否决，因为抑制清单不是门禁：它会静悄悄地变长，而且无从区分"还没人清理过的文件"与"有人放弃了的文件"。逐文件开启把方向反了过来——已标注集合只增不减，未标注的文件则诚实地表示"尚未"。

**把桌面端 glob 加进根 `.oxlintrc.json`。** 根配置的价值在于其类型感知规则，而这些规则无法在 TypeScript program 之外的文件上运行。在那里解除 `**/*.js` 的忽略，要么削弱 TypeScript 树的配置，要么被迫写一堆 per-glob override，读起来像是在为一条本就不适用的规则开例外。独立配置把处境讲得更清楚。

**取消 vendor `node_modules` 入库，改为打包时安装。** 对仓库体积有吸引力，但它会把首次启动和每一次离线打包都变成网络操作，而代价只省下 2.7 MB。若市场插件将来有了自己的构建步骤，可重新考虑。

## Consequences

现在，桌面端会因为 `require` 路径失效、死导出，或已标注文件中的类型错误而使 CI 失败——正是更名本可能悄悄带过去的那类破坏。三个门禁只读取 `apps/desktop` 且不需要构建产物，因此在静态 lane 里安装后即可运行，不引入排序约束。

类型覆盖是部分的，而且显式如此：27 个文件没有声明，这个数字就是迁移还差多远的诚实度量。没有任何机制推着它前进，因此除非触及这些文件的改动顺手偿还自己的类型债，阶梯可能停滞。

把壳层留在 harness workspace 内，意味着外层 Relay 那一层仍然没有属于自己的应用——仓库根目录的产品文档描述的是一个位于下一层目录的壳。这处错位真实存在，并将持续到 Relay 交付产品代码而不只是产品文档为止。
