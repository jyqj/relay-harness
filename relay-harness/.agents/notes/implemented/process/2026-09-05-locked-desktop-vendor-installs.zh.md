# Agent Note: 锁定桌面 vendored 安装

Status: implemented

[English](2026-09-05-locked-desktop-vendor-installs.md) | 中文

## Problem

如果打包可回退到 `npm install`、复用漂移的安装，或接受没有归档地址和完整性摘要的 lock 项，不可变 workspace 安装就不能固定桌面插件依赖。缺失的插件编译代码是独立问题，lockfile 无法修复。

## Decision

[桌面 vendor 安装器](../../../../apps/desktop/vendor/README.md) 要求普通文件形式的版本 3 npm lock，其身份和依赖声明必须与 manifest 一致。生产项携带固定 HTTPS 地址和完整性摘要。缺失或不一致的 lock 会在删除既有安装前失败。发行打包始终通过 `npm ci` 安装，省略开发依赖、禁用脚本、禁用 peer 自动安装和 workspace 自动发现，再验证运行时入口文件。开发同步可以复用匹配的安装，但不能忽略缺失的 lock 或版本漂移。

市场插件的三项生产依赖锁定为 `argparse` 2.0.1、声明范围内的 `js-yaml` 4.3.1，以及 `undici` 7.29.0。缺失归档元数据只从现有根 lock 和缓存 tarball 恢复，并验证 SHA-512 和包身份匹配，再由离线 npm 规范化和验证。编译代码直接导入的 `@relay-harness/schemastery` 被声明为 Host peer，范围采用本地已验证的 `^3.18.1` API 版本线。Host settings 和 schema 代码共享，不复制第二套运行时。

私有 `rlhbot` 只有 Host peer，因此具有真实生成的零生产依赖 lock。其已记录缺失的 Host `lib` 仍不可用，也不进入可安装插件清单；lock 不伪造代码或启用该可选功能。

## Alternatives considered

- **保留未锁定回退安装** —— 应用源码和 manifest 不变时，发行内容仍可能变化。
- **使用占位完整性摘要，或从安装文件重建注册表 tarball** —— 两者都不能证明原发布归档的字节。
- **为每个插件自动安装 Host peer** —— 产生第二套 SDK/Cordis 身份，而不是复用既有 Host。
- **把 lock 当成插件代码完整的证据** —— 掩盖独立已知的私有 Host 入口缺失。

## Consequences

打包要求可访问或已缓存的锁定归档，否则失败关闭，脚本禁用始终保持。两次干净离线 npm 安装生成逐字节一致的依赖树，三项运行时依赖通过导入探针，真实市场 Host 入口通过到既有 Host settings/schema 包的链接完成导入。可选开发 `node_modules` 目录缺失时，本地工作树安装检查仍可跳过；受控临时安装独立证明 lock。可选 bot 的 Host 实现缺失仍是明确限制，不是成功交付的发行能力。
