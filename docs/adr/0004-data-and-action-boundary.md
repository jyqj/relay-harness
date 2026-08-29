# ADR-0004: Explicit File Context, Least Privilege, and Local State

English | [中文](0004-data-and-action-boundary.zh.md)

- **Status:** Accepted
- **Date:** 2026-08-20

## Context

Project-free Work reduces user complexity but must not become an implicit whole-device scan. Ordinary users need a simple way to add files while understanding what the agent may access and modify.

## Decision

1. Chat and Work may access only files, folders, and the current artifact directory that the user explicitly introduces by default.
2. `File Context` records each file's source, version fingerprint, access mode, and processing state.
3. Large files are read, indexed, or summarized on demand rather than inserted into model context in full by default.
4. High-impact writes, deletion, external transfer, and publication pass through permission gates; prefer reversible approaches.
5. Checkpoints, audit records, and verification evidence remain local by default rather than becoming platform telemetry.
6. Sensitive content must not enter logs, error messages, or context unrelated to the task.

## Consequences

- The product UI must continuously show the files and authorization scope introduced to the current Work.
- Prompt Enhancement may use only context reasonably related to the current request.
- See [`../agent/work-and-files.md`](../agent/work-and-files.md) and [`../agent/security-and-data-boundary.md`](../agent/security-and-data-boundary.md) for file and security details.
