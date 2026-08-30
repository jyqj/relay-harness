# Repository Governance

English | [中文](repository-governance.zh.md)

## Canonical layout

The Git checkout is an outer container: `relay-harness/` is the only tracked product/runtime monorepo, while the local `auggie-packages/` and `codecortex-rust_副本/` reference projects remain untracked and ignored. Product documentation, package sources, applications, scripts, and build configuration live under `relay-harness/`.

`docs/feature-status.json` records this as `runtimeRoot: "relay-harness"` and `sourceLayout: "nested-monorepo"`. Its `branchProtection` remains `unconfigured` until a remote ruleset is observed.

The Git-root `README.md` only directs visitors to the runtime documentation, while the root `LICENSE` supports repository license discovery; neither creates a second runtime tree. GitHub discovers automation only from root `.github/`, so workflows, Issue policy, and Dependabot remain at the Git root. Ordinary workflow shell steps run with `working-directory: relay-harness`; Landlock shell steps use `relay-harness/native/landlock-run`. Dependabot targets `/relay-harness` for npm and `/relay-harness/python/sdk` for the Python SDK.

Public repository metadata is also Git-root-relative: every published package's `repository.directory` and every absolute `blob/master` source link begins with `relay-harness/`. Contributor commands and relative source paths remain runtime-root-relative. `check-workspace-constraints` rejects package metadata that drops the outer prefix.

## Remote audit snapshot

The GitHub API observation on 2026-08-30 found:

- the public repository is `jyqj/relay-harness`, with `master` as its default branch;
- remote `master` remains `b65b3feeb2` while the local branch contains the audited implementation commits;
- GitHub lists eight historical workflow records, while the local root contains 15 workflow definitions;
- `master` has neither classic branch protection nor a ruleset;
- the repository has no Actions variable, secret, environment, or self-hosted runner, so CI uses standard hosted runners, real-API e2e remains manual-only, Issue Project automation and the enterprise-runner benchmark are explicitly disabled, and release publication remains manual.

The tracked root workflow directory restores GitHub discovery without placing runtime sources at the outer level. Remote discovery becomes a fact only after the commit is pushed; verify workflow registration and one keyless CI run before configuring the required-check ruleset.

## Required remote follow-up

1. Push the root governance and `relay-harness/` runtime commits.
2. Confirm that GitHub lists every workflow under `.github/workflows/` and that `repository governance` passes.
3. Configure a `master` ruleset that requires a PR and the stable `all checks passed` check; decide separately whether secret-bearing e2e is required.
4. Read the ruleset and check runs through the API again; update `docs/feature-status.json` from `branchProtection: unconfigured` only after the remote state exists.

## Container-layout invariant

Tracked product/runtime paths live under `relay-harness/`; root `.github/` is the sole automation authority. Repository checks reject a second runtime tree at the outer level and workflow paths that resolve outside the declared runtime root. Local reference projects are excluded from Git and from Relay documentation/indexing gates.
