# Agent Note: 失败的编译面不生成代码产物

Status: implemented

[English](2026-09-05-failed-compiler-face-no-emission.md) | 中文

## Problem

归入错误编译面的浏览器测试会导入 rootDir 外的 Host 源码。TypeScript 报错后仍可能生成 JavaScript 与声明；相对输出路径随后越出预期输出目录，在源码旁形成影子文件。即使构建命令失败，这些影子文件也会污染后续源码检查与类型解析。

## Decision

共享编译选项要求 `noEmitOnError`。编译面的成员仍必须正确；禁止生成产物不意味着可以忽略 rootDir 或项目引用错误。清理已有生成物之前必须确认其来源与对应源码，而不是删除任意 JavaScript 或声明文件。

## Verification

真实 TypeScript 程序导入其 rootDir 外的源码。回归观察 TS6059 错误，并验证跳过代码生成、源码内容不变，以及两个源码目录均没有生成文件。缺少共享设置时，同一 fixture 会生成产物。该验证不同于成功构建检查，并纳入常规仓库测试清单。

## Alternatives considered

仅在构建失败后清理，会留下源码旁生成物影响导入与检查的窗口。扩大 rootDir 会掩盖错误的编译归属，并混合 Host 与 Client 声明。两者都不能替代拒绝无效程序生成产物。

## Consequences

失败的编译面不能发布部分代码产物。成功程序保留既有输出布局。增量构建元数据与之前有效的输出不构成新的构建成功证据；消费者验证仍以构建退出状态与产物记录为准。
