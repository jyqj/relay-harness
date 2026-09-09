# Agent Note：锁定的 Desktop 生产组装

Status: implemented

[English](2026-09-06-desktop-locked-production-assembly.md) | 中文

## 问题

复制整个 checkout 会将开发工具、本机构建输出以及 Desktop 发行目录本身纳入运行时。将无关依赖版本拍平到同一目录会改变 Node 解析：需要 Commander 15 的 CLI 可能拿到 Commander 8。源码构建也会掩盖遗漏共享 JavaScript chunk 的发布清单。

## 决策

Desktop 组装使用固定包管理器的共享锁文件生产部署，依赖图采用物理 hoisted 布局。不使用未锁定的旧部署，也不回退到 checkout 全量复制。部署前将临时目录规范化，避免 macOS 路径别名破坏相对 patch 引用。过程检查源锁文件是否被修改。

组装器复制已发布 CLI 文件、保留嵌套版本的自包含生产依赖树，以及官方构建的 Web 产物。它保留许可证，拒绝开发／自包含递归包和越界链接，并从运行时依赖元数据移除仅用于部署的源码引用。归档记录部署锁 hash 和构建平台作为来源信息，而非执行证明。Desktop 组装由原生平台与 CPU 架构 runner 负责。由于归档包含当前 runner 的 Node 与原生模块，hook 在访问资源或安装依赖前校验 electron-builder 的数字目标架构。缺失、未知、跨架构与 universal 目标均拒绝；universal 发行需要独立的多架构运行时方案。

运行时闭包检查同时覆盖 Python 可执行文件清单和公共 CLI 清单；即使 Python 目标矩阵不含 Windows，CLI preset 检查仍包含 Windows。必需的 workspace peer 被显式列为 CLI 依赖。Webserver 与 Work Results 发布清单包含共享 bundle chunk。归档前检查已发布第一方 JavaScript 的静态相对导入；真实随包 Node 的 CLI help 探针补充更广泛的 packaged smoke。

## 验证

真实 Node fixture 区分嵌套依赖边上的两个 Commander 版本。其他用例保留许可证与随附 skill，拒绝越界部署链接、开发包和遗漏的共享 chunk。真实生产部署与解压后的应用分别接受验证；源码 checkout 成功不等于发布证据。

## 曾考虑的替代方案

扩大跳过清单仍会复制未来未被枚举的 checkout 状态。选择 store 中找到的第一个版本会丢弃依赖语义。启动失败后再补文件不能证明发布集合闭合。

## 影响

包发布清单与冻结的生产依赖图成为发布输入。缺失运行时 peer、chunk，或暂存 CLI 版本不兼容时，会阻断组装，而非回退到开发文件。未签名的本机 smoke 不证明签名、公证或其他平台已经就绪。
