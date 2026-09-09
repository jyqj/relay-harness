# Agent Note: Ordinary-user safe defaults

Status: implemented

English | [中文](2026-08-29-ordinary-user-safe-defaults.zh.md)

## Problem

The shipped profile defaulted to `danger-full-access` with approval `never`, while Desktop fresh installs defaulted Simple Mode off. Those defaults contradicted the ordinary-user product contract and made unrestricted developer behavior implicit.

## Decision

Fresh shipped profiles now resolve to `workspace-write` and approval `ask`. Existing `RLH_PERMISSION_MODE` overrides remain authoritative; explicitly selecting `danger-full-access` still resolves approval `never` and is presented as `Developer Mode`. Persisted permission settings continue to override the composition base for future Sessions, so explicit existing choices survive migration.

Desktop fresh config now defaults `simpleMode: true`; a persisted explicit false migrates once into the Host-owned `productMode` setting and remains mirrored for native menu filtering. Web and Desktop use the same Web bundle and the same persisted Client projection. The shared shell labels its top-level navigation Chat, Work, and Library; Work composes existing Session projections, while Library opens the existing Files, Memory, Skills, MCP, and Code Index surfaces.

Simple Mode keeps Context Inspector provenance visible rather than classifying source transparency as an advanced diagnostic. Work deliverable navigation delegates the source Session and execution-recorded path to the [Host Work Results](../../../../packages/host/work-results/README.md) authority instead of resolving paths against the currently selected workspace.

The Client mode service owns an effect-lifetime invalidation flag and checks its captured owner fiber before new dispatch or late publication. Owner state blocks the interval before effect cleanup runs; the lifetime flag prevents a retired instance from becoming active again when its fiber reloads. Reloads wait for locally admitted write completions before allocating their read generation; a get that races durable commit must not supersede its acknowledged value. Existing in-flight Host writes are not rolled back, and this ordering does not serialize other clients.

## Consequences

Ordinary workspace work remains writable without constant prompts. Escalation beyond the workspace follows the existing approval gate. Full host authority and advanced model, preset, plugin, trajectory, and raw diagnostic entries remain available only after explicit Developer Mode choice; Context provenance remains visible in both modes.

## Alternatives considered

- Keeping unrestricted access as the fresh default was rejected because it contradicts the ordinary-user contract.
- Removing full access was rejected because Developer Mode remains a legitimate explicit workflow.
- Treating Simple Mode as a Desktop-only menu filter was rejected; the shared Host mode now owns browser and Desktop presentation.
