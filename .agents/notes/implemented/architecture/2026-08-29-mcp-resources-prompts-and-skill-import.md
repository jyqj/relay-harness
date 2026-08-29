# Agent Note: Protocol-native MCP catalogs and governed Skill imports

Status: implemented

English | [中文](2026-08-29-mcp-resources-prompts-and-skill-import.zh.md)

## Problem

MCP bridged Tools only, while Resources and Prompts disappeared. Skill Settings could author local files but could not import bundles or explain source, version, permissions, trust, or degraded discovery.

## Decision

`mcp-client` now fully paginates Tools, Resources, Resource Templates, and Prompts, rejects repeated cursors, reacts to all three list-change notifications, rechecks generation ownership before every swap, and atomically swaps last-good generations. `startupTimeoutMs` bounds connect plus discovery; disconnected last-good catalogs refuse reads before touching a stale Client, and credential values are redacted from bounded diagnostics. `mcp-catalog` keeps Resources and Prompts protocol-native: explicit Resource URIs hydrate through Context Engine Evidence with per-resource failure containment and honest coverage, while Prompts use a dedicated list/get seam and preserve bounded rich blocks plus annotations. Reconnect health projects tool, resource, and prompt names.

Skill Inventory imports local directories, ZIP archives, and GitHub archives into user/project bundles. Archive/local imports enforce compressed/expanded/file-count bounds, regular-file-only trees, canonical containment, and no bundle symlinks before and after staging. GitHub versions select the fetched ref. Project Remote cwd is authorized by a live Session; writable provider paths are canonically confined to owned roots, and ordinary edits use atomic replacement. Imported frontmatter records source, version, declared permissions, and explicit `unsigned-local` trust; signing is not fabricated. Re-import with `replace` is the update path, ordinary remove remains recursive and guarded. Filesystem discovery serves the last-good catalog on transient read failures. Settings presents trust, health, version, permissions, and import controls without merging MCP and Skill protocols.

## Alternatives considered

- **Convert Resources into Tools** — rejected because read-only context must not acquire tool authority.
- **Convert MCP Prompts into Skills** — rejected because server prompt lifecycle and local Skill governance are distinct.
- **Trust ZIP paths after extraction** — rejected because archive traversal must be refused before materialization.

## Consequences

Web and Desktop continue sharing the Web Settings bundle. MCP Resources never acquire tool authority, and MCP Prompts never become Skills. Extension health is presented consistently while each protocol retains its own lifecycle and permission model.
