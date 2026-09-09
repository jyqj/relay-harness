# AGENTS.md — GitHub Actions

This root `.github/` directory is the only GitHub-discoverable automation authority. Shell steps default to `relay-harness/`; action-owned cache and artifact paths remain repository-root-relative and therefore carry the explicit `relay-harness/` prefix.

Run jobs on Windows runners (`windows-*` labels) under native `pwsh`. The pull-request `windows` job is the deliberate exception: it runs Windows Node under Wine on hosted Linux. Both Wine and `windows-native` on `windows-2025` block `all checks passed`, together with the reusable native sandbox and desktop smoke workflows. Self-hosted standby jobs remain disabled until their runner capacity is registered. Keep reusable workflow concurrency groups distinct from their caller and make the aggregate reject failed, cancelled, and skipped dependencies.
