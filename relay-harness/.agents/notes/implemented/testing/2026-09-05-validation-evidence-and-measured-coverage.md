# Agent Note: Validation evidence and measured coverage

Status: implemented

English | [中文](2026-09-05-validation-evidence-and-measured-coverage.zh.md)

## Problem

Reference files and marker strings establish implementation scope, not execution. Likewise a per-file coverage threshold says nothing about explicitly excluded files. Treating either signal as a complete release verdict hides unexecuted behavior and lifecycle gaps.

## Decision

The product feature index describes implementation references and explicitly disclaims test execution, CI, coverage, and release approval. Context Inspector references follow its actual renderer and locale owner instead of requiring an obsolete inline label. Runtime validation remains the responsibility of executed checks.

Coverage exclusions are removed only after measuring the owning implementation. Session Projection includes explicit listener disposal; Commands includes orphan and duplicate lifecycle rejection, non-Error admission failure, and failure settlement after ownership loss. Webserver includes actual registration ownership and generation-safe cleanup rather than synthetic registration probes. These domains participate in the ordinary per-file threshold.

## Alternatives considered

Lowering thresholds or replacing behavior checks with path markers preserves the original ambiguity. Treating excluded code as uncovered without running cross-package consumers can also invent missing tests; measurements must include the relevant execution paths.

## Consequences

Implementation references and execution results remain separate evidence classes. A missing reference fails the static index check; failed or skipped validation must be reported from its actual run rather than inferred from that index.

## Verification

Focused coverage reached 100% statements, branches, functions, and lines in each removed domain. Real lifecycle regressions exercise the public operation and its observable log or network result. Whole-repository and platform validation remain separate obligations; focused passes are not substituted for them.
