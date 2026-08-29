# AGENTS.md — GitHub Actions

This root `.github/` directory is the only GitHub-discoverable automation authority. Shell steps run from the repository root unless a workflow explicitly selects a narrower workspace such as `native/landlock-run`; action-owned cache, artifact, hash, and trigger paths are repository-root-relative.

Run jobs on Windows runners (`windows-*` labels) under native `pwsh`. The pull-request `windows` job is the deliberate exception: it runs Windows Node under Wine on hosted Linux and blocks `all checks passed`; `windows-native` runs automatically on `windows-2025` (or the self-hosted `[self-hosted, rlh-win-ci, windows]` pool under `RLH_CI_FAILOVER_WINDOWS=selfhosted`) but reports independently. The master `serial-windows` standby continuously validates the self-hosted failover target — see the [failover runbook](../.agents/notes/implemented/process/2026-07-26-ci-failover-runbook.md).
