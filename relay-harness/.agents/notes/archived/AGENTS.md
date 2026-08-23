# AGENTS.md — Archived Agent Notes

Archived Agent Note triplets under the kind directories are frozen historical snapshots, not current authority. Never edit, reformat, translate, repair, delete, or move a sealed artifact; use an active Agent Note or current documentation for new decisions and facts.

The archival change may only relocate a complete English/Chinese/sidecar triplet, insert the identical `Archived: YYYY-MM-DD` line below both `Status: implemented` lines, re-record the sidecar, and repair or delete inbound links. Do not inspect, verify, or repair links out of archived notes.

## Reading pre-rename vocabulary

Artifacts sealed before the [Relay Harness rename](../implemented/process/2026-08-23-relay-harness-rename.md) name the product DeepSeek Harness and use the retired `dsh` token. The seal forbids rewriting them, so translate while reading: `@deepseek-ai/dsh-<pkg>` is today's `@relay-harness/rlh-<pkg>`, the `dsh` binary is `rlh`, `DSH_*` variables are `RLH_*`, `--dsw-*` CSS custom properties are `--rlw-*`, and `deepseek-harness` paths are `relay-harness`. `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`, `api.deepseek.com`, and the `llm-deepseek` adapter name refer to a third-party model vendor and read literally in both eras.

Run the [`rlh-archive-agent-notes`](../../skills/rlh-archive-agent-notes/SKILL.md) workflow and append new artifact hashes with `pnpm run verify-archived-agent-notes --write`. The normal verifier rejects changed or missing sealed artifacts, incomplete triplets, unknown kind folders, and invalid archive metadata.
