# Agent Note: 让 Code Index 输入与 Git、parser ownership 对齐

Status: implemented

[English](2026-08-30-code-index-input-and-corpus-ownership.md) | 中文

## Problem

Parser registry 会分类 `.mjs`、`.cjs`、`.mts` 和 `.cts`，默认文件系统 scanner 却不接纳这些扩展名。工作区因此可能声明某种 module 支持语义解析，但该文件根本不会进入索引；Auggie 恢复源码 corpus 的可执行源码使用 `.mjs`，会直接暴露这一不一致。Walker 还忽略仓库本地 `.git/info/exclude`，所以已从 Git 排除的本地参考 checkout 仍可能进入产品索引并污染 Relay benchmark。外部 corpus 的增量 probe 另有 ownership 风险：存在性检查无法阻止另一进程在首次写入前创建同一路径，而无条件清理随后可能删除 runner 从未创建的路径。

## Decision

默认 scanner 接纳全部四种 JavaScript/TypeScript module 变体，extensionless import resolution 也探测同一组变体。每次 walk 都以 `.git/info/exclude` 初始化 ignore stack；linked worktree 会解析其 gitdir 与 `commondir`。该文档在决策顺序中低于根目录和嵌套 `.gitignore`，因此更晚的 negation 会保留 Git 的优先级语义。

Corpus runner 会在分配临时存储前拒绝已有 probe，并用 `wx` 完成第一次增量写入，从而关闭检查与写入之间的竞态。它记录 probe ownership，只在持有 ownership 时删除路径。Runtime 构造和完整运行会结算为一个 outcome；probe 删除、runtime dispose 和临时存储删除都会被尝试，运行与清理同时失败时，运行失败保留为首个错误。

## Alternatives considered

- **仅在 corpus manifest 排除本地参考目录名**——拒绝，因为产品索引仍会忽略仓库自身的本地排除决定。
- **只增加 `.mjs` 以满足 Auggie case**——拒绝，因为 parser registry 已经承诺其余三种 module 变体，每一种都存在相同 scanner 不一致。
- **只保留预检存在性检查作为碰撞保护**——拒绝，因为它存在检查/写入竞态，也无法证明清理拥有被删除的路径。

## Consequences

Module 格式源码会一致地进入扫描、解析、import resolution、检索与 hydration。Git 本地排除会阻止已授权参考树进入 Relay corpus，同时这些参考仍可独立测量。真实 Loader composition 测试会启动准确的已交付 Code Index 与 code-context row，执行 Session 定域检索，调用 Context Engine `prepareStep`，并观察经过验证的 hydrated source。外部 runner 会通过 Relay、CodeCortex Rust 与 Auggie 恢复源码 corpus；包 README 记录实测文件/chunk、延迟与 Recall@5/MRR 结果。
