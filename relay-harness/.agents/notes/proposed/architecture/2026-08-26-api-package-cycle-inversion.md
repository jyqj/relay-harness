# Agent Note: API package cycle inversion

Status: proposed

English | [中文](2026-08-26-api-package-cycle-inversion.zh.md)

## Problem

Four packages form a dependency cycle: `@relay-harness/rlh-api-remotes` peer-depends on `@relay-harness/rlh-api-gateway`, whose client half injects `@relay-harness/rlh-client-connection`, which imports runtime values (`AbstractApiClient`, `toFetchHandler`) from `@relay-harness/rlh-host-apiproxy`, which imports remotes at runtime. Two of these edges look like type-only back-edges but are load-bearing mechanisms, not accidents: the `export type {} from '…'` statements in `packages/api/remotes/src/client/index.ts` pull owner packages' client-safe type modules into the consumer's compilation face so Cordis declaration merging (`TypertRemoteEvent`, `$on` event signatures) takes effect; and the `rlh.client.inject` manifests compose gateway and connection into the remotes client assembly, which its own comments call "the one place both planes legitimately meet".

The cycle is debt for three reasons. Published as-is, the four packages form a peerDependency cycle on npm and downstream installs get peer-resolution warnings. No package in the cycle can be refactored, split, or published in topological order. And `api/remotes` peer-depends on 22 host packages because it is both the generated-contracts mirror and the runtime assembly policy in one package, so every host capability change crosses the whole chain.

## Proposal

Invert the one genuinely wrong-direction edge — client packages importing runtime values from a `host-` package — and separate remotes' two roles. The `export type {}` face-composition mechanism stays exactly as is: it is the documented seam that makes declaration merging visible to consumers, not a cycle edge to delete.

**Step 1 — carrier contracts leaf.** Move the wire envelope types (`RpcErrorDetailsMap`, `RpcError`, `RpcResult` in `packages/host/apiproxy/src/api/rpc.ts`) and the carrier handler contracts (`ConnectionRpcHandler` and friends in `packages/client/connection/src/rpc.ts`, `IApiClient` behind `apiproxy/client`) into one leaf package below both groups (extend `rlh-typert-protocol` or add `rlh-api-protocol`; both candidates already depend only on `rlh-invariants`/`rlh-brand`-level leaves). `apiproxy` and `connection` re-export from the leaf during migration, so no consumer import changes in step 1.

**Step 2 — move the fetch handler.** `toFetchHandler` and `AbstractApiClient` are runtime values a client package imports from a host package today. They move to the leaf (or a `connection-transport` package beside it); `apiproxy` keeps its RPC dispatch and consumes the contract like every other implementer. After steps 1 and 2, `client/connection` no longer depends on any `rlh-host-*` package, and the client-face convention (browser-available subpaths maintained by hand per host package) gains a structural guarantee instead of a naming rule.

**Step 3 — split remotes.** Separate the generated-contracts mirror (typert-generated remote faces, the 22-peer type surface) from the runtime assembly policy (the `rlh.client.inject` composition). The contracts mirror keeps its peer set but becomes a pure type package with no runtime imports; the assembly package keeps the injection manifest and depends on gateway/connection/leaf. After the split, `gateway → connection → leaf ← apiproxy → remotes-contracts` is a DAG and each piece publishes in topological order.

## Alternatives considered

**Delete the `export type {}` statements to break the "type back-edges".** They carry the declaration-merging side effect; removing them breaks `$on` typing in consumers (the file's own comments document this). Rejected as a regression disguised as a cleanup.

**Move only `RpcResult` to a leaf, keep `toFetchHandler` in apiproxy.** The runtime edge, not the type edge, keeps the cycle closed; a types-only move reduces no package-level peer cycle while churning every `RpcResult` importer. Rejected until step 2 is in scope.

**Leave the cycle; document it as the deliberate assembly seam.** Defensible for a single-user local deployment, but the peer cycle surfaces on npm the moment the packages publish, and the 22-peer remotes already taxes every host change. Rejected as standing still on a published-surface defect.

## Acceptance criteria

The workspace peer-dependency graph over `api/*`, `client/connection`, and `host/apiproxy` is acyclic (provable by a constraints-gate check); `client/connection` imports no `rlh-host-*` module in either face; `built-lib.e2e.ts` instantiates the split assemblies and passes unchanged assertions; both tsconfig aggregates build with no new per-file special cases.

## Risks

Moving `RpcErrorDetailsMap` changes where declaration merging extends the error-code table, and a missed merge surface would surface as type errors in consumer packages rather than at the definition — mitigated by landing step 1 with both aggregates' `tsc -b` and apiproxy/connection/gateway package tests in the same change. The remotes split (step 3) touches generated code and the typert generator's assumptions; if the generator hardcodes the remotes package name, the split needs a generator change first. Each step is independently shippable and ordered so a stalled step leaves the tree green.
