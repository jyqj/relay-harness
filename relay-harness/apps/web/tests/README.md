# apps/web browser e2e

English | [中文](README.zh.md)

These tests boot the real web composition in-process and drive it with a real
Chromium over real HTTP. The lane's mechanics — modes, fixtures, goldens, and
the deliberate composition divergences from `rlh web` — are documented in
[`scaffold.ts`](scaffold.ts) and the
[browser e2e Agent Note](../../../.agents/notes/implemented/testing/2026-07-24-web-gui-browser-e2e-lane.md).

The [Settings catalog scenario](settings-catalog-pages.e2e.ts) exercises Memory Center validation through the built browser and real governance Remote in an isolated temporary store. It pins the invalid-draft alert, verifies that blank confidence leaves the persisted value unchanged, and verifies that explicit zero saves one revision.

The [recording media test](browser-recording.e2e.ts) is a lower-level exception: it transpiles the dependency-free recording source into a real Chromium page without booting the Host or loading built bundles. Real canvas capture, MediaRecorder, and video decoding verify dimensions, non-black frame pixels, and ended tracks; only the frame source and save transport are supplied by the test. It does not prove Electron IPC or packaged recording.

The [product-shell scenario](product-shell-prompt-context.e2e.ts) toggles Developer Mode through the built Settings UI, checks the real Host-persisted mode, and pins both switch states with inline ARIA snapshots before exercising Prompt Enhancement.

## These are Host-face tests

They type-check in the root `tsconfig.host.json`, not in the Client aggregate,
because they read Host services directly: `ctx.apiProxy`, the Host
`SessionStore`, `ctx.sessionProjectionCache`. Driving a browser at runtime does
not make a file part of the Client program — the two faces merge cordis
`Context` under the same keys with different services, so one program cannot see
both. Moving these files into the Client aggregate makes every Host-service
access fail to compile.

## Do not import `@relay-harness/rlh-client-*` here

Importing a Client package — a value or a type — pulls its whole TypeScript
project, and every project it references, into the **Host build graph**. That has
bitten this lane once already: four Client consumer packages reference
`api/remotes`' Client face, which cannot compile until Host tsdown has generated
`@relay-harness/rlh-goal/remote`, so the Host build phase ended up waiting on an
artifact it produces itself.

When a scenario needs a Client-owned constant or pure function, mirror it here
instead, next to the commented-out import that names the source module. A drift
then surfaces as a missed selector or a stale mirrored value — a loud failure,
never a silent pass. `scaffold.ts` follows this rule for the welcome-notice
namespace, acknowledgement field, version, and asserted Chinese copy.

Two kinds of Client import stand. `assembled-boot.ts` drives the shell itself, so
it imports `AppWebEntry` from `@relay-harness/rlh-client-web` and the boot-manifest
type from `@relay-harness/rlh-client-modules/client`: booting the real shell is what
that harness is for, and both packages are already in the Host graph. Separately,
the chat scenarios import `conversationContextKey` from
`@relay-harness/rlh-client-runtime/client` because `client/runtime` is reachable
through the unsplit `directory-picker` packages and pulls nothing further in.
That reachability is incidental, not a guarantee — if it ever leaves the graph,
mirror the helper like the rest.

Nothing mechanically enforces this rule; keep it in review.
