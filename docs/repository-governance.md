# Repository Governance

English | [中文](repository-governance.zh.md)

## Canonical layout

The Git root is the single repository authority. The TypeScript monorepo, product documentation, package sources, applications, scripts, and GitHub metadata all live directly under that root; no nested source monorepo remains in the tracked tree.

`docs/feature-status.json` records this as `runtimeRoot: "."` and `sourceLayout: "root-monorepo"`. Its `branchProtection` remains `unconfigured` until a remote ruleset is observed.

GitHub discovers automation only from root `.github/`. Issue templates, policy, Dependabot, all 15 workflows, CI, e2e, documentation, sandbox, and release workflows therefore have one canonical location. Ordinary workflow shell steps and action-owned paths resolve from the repository root; Landlock shell steps use `native/landlock-run`. Dependabot targets `/` for npm and `/python/sdk` for the Python SDK.

## Remote audit snapshot

The GitHub API observation on 2026-08-29 found:

- the public repository is `jyqj/relay-harness`, with `master` as its default branch;
- remote `master` was `b65b3feeb2` when the audit began;
- the remote root contained only `README.md`, `docs/`, and `relay-harness/`, with no root `.github/`;
- GitHub still listed six historical workflow records, but the last branch run stopped at `a72dc590f6` on 2026-08-23 and later `master` commits had no check runs;
- `master` had neither classic branch protection nor a ruleset;
- the repository had no Actions variable, secret, environment, or self-hosted runner, so CI uses standard hosted runners, real-API e2e remains manual-only, Issue Project automation and the enterprise-runner benchmark are explicitly disabled, and release publication remains manual.

The tracked tree restores root workflow discovery. Remote discovery becomes a fact only after the commit is pushed; verify workflow registration and one keyless CI run before configuring the required-check ruleset.

## Required remote follow-up

1. Push the root workflow and flat-layout migration.
2. Confirm that GitHub lists every workflow under `.github/workflows/` and that `repository governance` passes.
3. Configure a `master` ruleset that requires a PR and the stable `all checks passed` check; decide separately whether secret-bearing e2e is required.
4. Read the ruleset and check runs through the API again; update `docs/feature-status.json` from `branchProtection: unconfigured` only after the remote state exists.

## Flat-layout invariant

The tracked source tree and physical checkout contain no `relay-harness/` path. Repository checks reject nested workflow authority, nested operational prefixes, and a recreated physical source root. Historical nested paths remain in Git history only.
