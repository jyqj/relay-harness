# `@relay-harness/rlh-code-context`

English | [中文](README.zh.md)

Opt-in code-index recall context. When the plugin entry carries a config section, the package registers one context-engine step-context contributor (`code-index-recall`, late-bound through `ctx.inject(['contextEngine'])`, so the engine stays optional). For each claimed step it binds `ctx.codeIndex` to `input.cwd`, joins the direct user messages' text blocks into one search query — with every distinct `@file` mention passed as the explicit `paths` scope — runs one ranked search, and batch-hydrates the selected candidates through the same immutable Workspace face.

A healthy answer with hits contributes one `code-index` recall message containing source-verified fenced snippets plus one evidence record per admitted snippet. Evidence revision is the current file content hash, its digest covers the exact injected source, and `verification` is `verified`; parser provenance, score trace, and both search/hydration epochs remain in the durable source/domain records. Stale, unavailable, or revision-drifted hydration is omitted with a warning and coverage entry. A no-hit answer contributes a short bounded-negative message. A degraded/failed search or failed/empty hydration returns no model message and raises `ContextProviderError` with a stable stage classification for the engine decision trace, never a path-only fallback or false no-results claim. An exhausted rendering budget records an explicit declined outcome. Diagnostics contain neither raw query nor provider error text; partial hydration warnings contain only a rejection count.

The `form: 'recall'` source record keeps the projection out of derived consumers: the session-query corpus extraction skips recall-form messages, and memory extraction collects `kind: 'user'` messages only. Injection is strictly opt-in: a Loader entry without a config section constructs the `ctx.codeContext` service but registers no contributor. The default Web/Desktop composition enables it over the workspace router.

## Configuration

| Key | Default | Contract |
|---|---:|---|
| `maxChars` | `65536` | Maximum code points of complete snippet entries included in one recall message. |
| `maxHits` | `8` | Maximum hits injected per step. |
| `minQueryChars` | `8` | Minimum trimmed direct-user-text length that triggers a search. |

`maxChars` and `maxHits` must be positive safe integers; `minQueryChars` must be a non-negative safe integer. Budgets apply in ranked order and count Unicode code points. Each admitted entry first reserves its complete path/revision/parser header and a Markdown fence longer than every backtick run in the full source; only the source body may clip. An entry whose fixed framing cannot fit is dropped without evidence. The footer reports candidate cuts and source-verification rejections.

## Model Experience

### Injected code-index recall

#### What the model sees

After the claimed user messages of a step, one user-role recall message headed `## Code-index recall`. It frames source as untrusted data, then renders each revalidated chunk as a revision/parser/ranking header plus its fenced source body inside `code-index-recall`; a no-hit step states that an index miss is not proof of absence. The durable source record carries content hash, parser provenance, score trace, truncation, and both search/hydration epochs without duplicating source bytes.

#### Token effect

Conditional and capped: only steps whose direct user text reaches `minQueryChars` receive the message, and its size is bounded by `maxHits` and `maxChars`. Steps below the floor add nothing.

#### KV Cache effect

The recall message sits after the step's claimed user messages, so its content does not join any stable prefix; changing budgets or the query changes only that step's tail. Ranking is deterministic for an unchanged index epoch, so an identical query over the same epoch reproduces the message byte-for-byte.

## Known Limitations and Deferred Work

- **No compaction pinning** — recall messages are ordinary user-role turns; compaction may drop them and this package neither pins nor re-injects their content.
- **Missing `ctx.codeIndex` fails the turn** — a deployment that registers the contributor without a code-index provider makes every contributing step end in an error instead of contributing silence (the `file-reference-local` fails-loud precedent).
- **Compaction checkpoints may re-index recall-derived text** — a checkpoint summary is a model-authored `user/message` under a plugin source, so it can restate recall-derived text and enter the session-query corpus; the `form: 'recall'` extraction skip covers only the recall messages themselves (the ADR 0006 rule-6 boundary stops at system-injected context, and a checkpoint summary sits on the assistant-reply side of it).
- **Raw-text queries** — the query is the claimed direct user text verbatim, with no rewriting or extraction step; retrieval quality depends on the seam's tolerance for prose, and very long turns are passed through unshortened.
