# Agent Note: Desktop release trust and source checking

Status: implemented

English | [中文](2026-09-05-desktop-release-trust.zh.md)

## Problem

An updater that selects an executable from a repository response without binding it to this product's publisher can install an unrelated artifact. Optional per-file JavaScript checking also leaves production entrypoints unchecked when their pragmas are missing.

## Decision

The [desktop update protocol](../../../../apps/desktop/docs/trusted-updates.md) derives trust from optional installed build metadata. An embedded Ed25519 key verifies exact manifest bytes before parsing. Product identity, release tag, stable version, expiry, Windows x64 platform, NSIS filename, size, and SHA-256 bind the signature to one installer. HTTPS host restrictions, byte limits, and total deadlines bound downloads. A fresh install check and a post-download check precede atomic rename and launch; failures remove temporary files. Renderer IPC never supplies trust or URLs. Concurrent installation is single-flight, and a process launches at most one installer.

No production authority is fabricated. Missing signing metadata, development launches, and unsupported installer platforms report `unavailable` without installer downloads or execution. Settings disables installation outside `available` and retains install-time verification failures. Release-page links remain informational.

Every packaged production JavaScript source opts into `@ts-check`. Renderer declarations derive from the actual preload API, and an inventory test rejects missing pragmas or extra exclusions. The two non-packaged release QA walkers stay excluded. This extends the non-strict JavaScript gate, not strict TypeScript coverage.

Download attempts own their redirect generations. Retiring a hop closes both streams; final settlement rejects late callbacks. Independent regression tests prove that a timed-out response cannot create a new network request and that a retired request error cannot abort a valid successor.

## Alternatives considered

- **Trust the original fork's latest executable** — repository identity is not this product's publisher or artifact identity.
- **Use an unsigned digest** — a response attacker can replace both installer and digest; the digest must be signed.
- **Replace installation with a link** — neither preserves the capability nor honestly expresses deployment readiness. The verified protocol exists while missing publisher configuration remains unavailable.
- **Disable checking for difficult files** — hides type debt; concrete DOM, HTTP, process, callback, and result types preserve checking.

## Consequences

The protocol supports Windows x64 NSIS and remains unavailable here until a real publisher configures its public key and release pipeline. Private keys stay outside the application. Tests use ephemeral fixture keys, mocked HTTPS, and a fake launcher; they do not download releases or run a real installer. Production JavaScript joins the type gate, while renderer-role authorization remains a separate runtime obligation.
