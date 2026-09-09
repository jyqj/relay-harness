# Agent Note: Failed compiler faces do not emit artifacts

Status: implemented

English | [中文](2026-09-05-failed-compiler-face-no-emission.zh.md)

## Problem

A browser test rooted in the wrong compiler face imports host sources outside its rootDir. TypeScript reports the error but can still emit JavaScript and declarations; relative output paths then escape the intended output directory and create source-adjacent shadows. Those shadows contaminate subsequent source inspection and type resolution even though the build command failed.

## Decision

The shared compiler options require `noEmitOnError`. Compiler face membership still has to be correct; refusing emission is not permission to ignore rootDir or project-reference diagnostics. Existing generated spill is removed only after its origin and source counterpart are identified, rather than deleting arbitrary JavaScript or declaration files.

## Verification

A real TypeScript program imports a source outside its configured rootDir. The regression observes diagnostic TS6059 and verifies skipped emission, unchanged source content, and absence of generated files in both source directories. The same fixture emits artifacts without the shared setting. This is distinct from a successful-build check and remains part of the ordinary repository test inventory.

## Alternatives considered

Cleaning only after a failed build leaves a window in which source-adjacent artifacts can affect imports and inspection. Enlarging rootDir hides incorrect compiler ownership and mixes Host and Client declarations. Neither replaces refusing emission from an invalid program.

## Consequences

A failing compiler face cannot publish partial code artifacts. Successful programs retain their existing output layout. Incremental build metadata and earlier valid outputs are not new successful-build evidence; build exit status and the artifact record still govern consumer validation.
