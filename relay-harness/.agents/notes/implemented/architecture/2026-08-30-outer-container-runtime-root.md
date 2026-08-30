# Agent Note: Outer Container and Runtime Root

Status: implemented

English | [中文](2026-08-30-outer-container-runtime-root.zh.md)

## Problem

The local checkout contains Relay plus two authorized reference projects. Placing the complete monorepo directly beside those references made the outer container look like several unrelated build trees and allowed repository-wide filesystem tools to traverse reference material unless every tool carried a special exclusion. Deleting generated output did not resolve that ownership ambiguity.

## Decision

`relay-harness/` is the single tracked product/runtime monorepo. The local `auggie-packages/` and `codecortex-rust_副本/` directories remain sibling reference projects and are ignored by Git. Product sources, documentation, package metadata, scripts, and build output all belong under `relay-harness/`.

GitHub-facing repository metadata is the deliberate exception. Root `.github/` remains the sole workflow, Issue policy, and Dependabot authority because GitHub discovers workflows only there; its shell steps run from `relay-harness/`, and action-owned paths use the explicit prefix. A pointer-only root `README.md` leads visitors to the runtime documentation, and the byte-identical root `LICENSE` enables repository license discovery without creating a second product-document authority. The outer `.gitignore` owns only container-local references, while `relay-harness/.gitignore` owns runtime build residue.

Repository-facing paths use the same outer-root coordinate system. Published package `repository.directory` values and absolute GitHub blob links begin with `relay-harness/`; commands, workspace discovery, and relative source links inside the monorepo remain runtime-root-relative. The workspace constraint derives and enforces that translation instead of treating a runtime-relative package path as npm repository metadata.

## Alternatives considered

- **Keep the flat monorepo beside reference projects** — rejected because the outer directory is a project container, not the Relay runtime root, and ordinary navigation becomes ambiguous.
- **Move or delete the reference projects** — rejected because they are user-owned audit inputs with stable local paths.
- **Move `.github/` under the runtime root** — rejected because GitHub would not discover those workflows.
- **Maintain product documentation in both roots** — rejected because it recreates two authorities; all product and runtime documentation lives under `relay-harness/docs/`.

## Consequences

The visible outer directory contains the pointer README and license beside `relay-harness/` and the two local reference projects. Root governance remains under `.github/`; no generated dependencies or build output live at the outer level. Feature status records `runtimeRoot: "relay-harness"`, CI and Dependabot target that root explicitly, repository checks reject a second tracked runtime tree outside it, and npm/PyPI source links resolve through the outer prefix.
