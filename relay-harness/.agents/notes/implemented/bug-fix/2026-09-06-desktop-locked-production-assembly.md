# Agent Note: Locked Desktop production assembly

Status: implemented

English | [中文](2026-09-06-desktop-locked-production-assembly.zh.md)

## Problem

Copying the entire checkout includes development tools, machine-local build output, and the Desktop distribution inside its own runtime. Flattening unrelated dependency versions into one directory changes Node resolution: a CLI requiring Commander 15 can receive Commander 8. Source builds conceal publication manifests that omit shared JavaScript chunks.

## Decision

Desktop assembly uses the pinned package manager's shared-lockfile production deployment with a physical hoisted dependency graph. It does not use legacy unlocked deployment or a checkout-copy fallback. Temporary directories are canonicalized before deployment so macOS path aliases cannot corrupt relative patch references. The source lockfile is checked for mutation.

The assembler copies published CLI files, the self-contained production dependency tree with nested versions intact, and the official built Web assets. It retains licenses, rejects development/self-recursion packages and escaping links, and removes deployment-only source references from runtime dependency metadata. The archive records its deployment-lock hash and build platform as provenance, not as execution proof. Native platform and CPU-architecture runners own their Desktop assembly. The hook validates electron-builder's numeric target architecture before accessing resources or installing dependencies, because the archive contains the current runner's Node and native modules. Missing, unknown, cross-architecture, and universal targets fail closed; universal distribution needs a separate multi-architecture runtime strategy.

The runtime-closure check covers both the Python executable manifest and the public CLI manifest; CLI presets include Windows even when the Python target matrix does not. Required workspace peers are explicit CLI dependencies. Webserver and Work Results publication manifests include their shared bundle chunks. Static relative imports in published first-party JavaScript are checked before archiving; a real bundled-Node CLI help probe complements the broader packaged smoke.

## Verification

A real Node fixture distinguishes two Commander versions across a nested dependency edge. Additional cases preserve licenses and shipped skills, reject escaping deployment links and development packages, and reject omitted shared chunks. The actual production deployment and extracted application are exercised separately; source checkout success is not publication evidence.

## Alternatives considered

A larger skip list still copies whatever future checkout state it fails to name. Picking the first package version found in the store discards dependency semantics. Copying missing files after a failed startup does not prove a closed publication set.

## Consequences

Package publication manifests and the frozen production dependency graph become release inputs. A missing runtime peer, chunk, or incompatible staged CLI version blocks assembly rather than falling back to development files. Unsigned local smoke does not establish signing, notarization, or another platform's readiness.
