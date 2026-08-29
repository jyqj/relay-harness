# Agent Note：协议原生 MCP catalog 与受治理 Skill import

Status: implemented

[English](2026-08-29-mcp-resources-prompts-and-skill-import.md) | 中文

## 问题

MCP 只桥接 Tools，Resources 与 Prompts 会消失。Skill Settings 可以编写本地文件，但不能导入 bundle，也无法解释 source、version、permissions、trust 或降级 discovery。

## 决策

`mcp-client` 现在完整分页 Tools、Resources、Resource Templates 与 Prompts，拒绝重复 cursor，响应三类 list-change notification，在每次 swap 前重新检查 generation ownership，并原子替换 last-good generation。`startupTimeoutMs` 约束 connect 加 discovery；断开后的 last-good catalog 会在触碰 stale Client 前拒绝读取，credential value 也会从有界诊断中脱敏。`mcp-catalog` 保持 Resources 与 Prompts 的协议原生语义：显式 Resource URI 通过 Context Engine Evidence hydrate，并逐 Resource contain 失败、诚实报告 coverage；Prompt 使用专用 list/get seam，保留有界 rich block 与 annotations。

Skill Inventory 会把本地目录、ZIP archive 与 GitHub archive 导入用户／项目 bundle。Archive/local import 在 staging 前后执行压缩／展开／文件数限制、regular-file-only tree、canonical containment 与 bundle symlink 拒绝。GitHub version 选择实际 fetch ref。Project Remote cwd 由 live Session 授权；writable Provider path 被规范限制在 owned root，普通编辑使用原子替换。导入 frontmatter 记录 source、version、声明 permissions 和显式 `unsigned-local` trust；不会伪造签名。文件系统 discovery 在临时读取失败时提供 last-good catalog。

## 考虑过的替代方案

- **把 Resource 转为 Tool**——否决；只读上下文不能获得 tool authority。
- **把 MCP Prompt 转为 Skill**——否决；服务端 Prompt lifecycle 与本地 Skill 治理不同。
- **解压后才信任 ZIP path**——否决；archive traversal 必须在 materialization 前拒绝。

## 结果

Web 与 Desktop 继续共享 Web Settings bundle。MCP Resource 不会获得 tool authority，MCP Prompt 也不会变成 Skill。Extension health 使用一致展示，但每种协议保留自身 lifecycle 与 permission model。
