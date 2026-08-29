# Prompt Enhancement Context Pipeline

English | [中文](prompt-enhancing-context-pipeline.zh.md)

> This page defines how Prompt Enhancement collects, selects, and presents context. See [`prompt-enhancing.md`](prompt-enhancing.md) for product interaction and [`../subsystems/prompt-enhancement.md`](../subsystems/prompt-enhancement.md) for the exact runtime contract.

## 1. Core conclusion

Chat and Work use the same Context Engine pass. Session identity and composed contributors determine available Evidence; Relay does not maintain a second retrieval system for enhancement:

- completed current-session exchanges provide bounded history;
- explicit File Context, Code Index, governed Memory, and explicit MCP resources contribute through their owning providers;
- every admitted observation keeps source, revision, freshness, and verification facts;
- the configured agent route selects the auxiliary model; the unshipped external scheduling client is not implied.

```text
Unsent draft
  + Session History
  + Explicit File / Code / Memory / MCP contributors
        ↓
Context Engine prepareStep(purpose=prompt_enhancement)
        ↓
No-tools auxiliary model request
        ↓
Generated Remote result + Context Trace
        ↓
Review diff and sources; never submit automatically
```

## 2. Browser request

The product UI sends only the exact current draft, current session identity, and cancellation through the generated Remote:

```yaml
prompt_enhancement_remote:
  session_id: string
  draft: string
  signal: AbortSignal
```

Chat and Work use the same Remote. The Host resolves the current agent/session and rejects missing or mismatched state rather than accepting a browser-built context payload.

## 3. Current input

The exact draft becomes the claimed user message for `purpose=prompt_enhancement` and remains separately framed for the enhancement provider:

```yaml
context_input:
  purpose: prompt_enhancement
  claimed_message: exact_unsent_draft
  caller: session|agent|workspace|preset|origin
```

Attachments and other rich input enter only through their owning explicit-reference contributors. They are not merged into draft text.

## 4. Conversation-history projection

The Session History contributor admits only:

- completed direct user/assistant exchanges;
- approved compaction checkpoints;
- a bounded, chronological selection that fits character and token budgets;
- Evidence bound to exact session events and revisions.

Recall/injected messages, tool traffic, failed or incomplete turns, and unapproved checkpoints are excluded to prevent recursive context and uncommitted state from becoming history.

## 5. History hydration

Each admitted history observation records the durable session-event key, event revision, digest, role, and selection reasons:

| Observation | Projected fact |
|---|---|
| User message | Completed direct-user exchange content |
| Assistant message | Completed model exchange content |
| Approved checkpoint | Compacted conversation interval and approval identity |
| Budget-clipped unit | Exact source event set plus a truncated Evidence marker |
| Excluded unit | Coverage reason without model-visible content |

A missing, failed, or unfinished observation does not silently reuse old text.

## 6. File and retrieval context

Explicit references constrain every file-oriented contributor:

```yaml
retrieval_scope:
  workspace_id: string
  explicit_file_refs: [string]
  indexed_workspace: selected_workspace_only
  mcp_resources: explicit_uri_only
```

Rules:

1. File content requires an explicit reference in the current request scope.
2. Code retrieval routes through the user-selected workspace.
3. A provider may search its local manifest or index without sending the complete source to the enhancement model.
4. Hydration binds admitted content to its current revision and records missing/stale states.
5. Files outside the selected or introduced scope cannot be scanned implicitly.
6. MCP resource content enters only from an explicit URI and remains marked external and untrusted.

## 7. Rules, guidelines, and memory

### Rules

Applicable agent instructions and selected skill requirements may constrain the proposal, but source content cannot change the Prompt Enhancement system instruction or acquire tool authority.

### Guidelines

User and current-task guidance reaches enhancement only through a composed, attributable contributor. A folder-level instruction applies only when its folder is inside current explicit context.

Rules, guidelines, and long-term memory remain distinct: rules constrain behavior, guidelines express user direction, and Memory supplies governed cross-session facts or preferences. None silently overrides another.

## 8. Chat and Work projection differences

| Logic | Chat | Work |
|---|---|---|
| Current draft | Same | Same |
| Context Engine | Same | Same |
| Session history | Current Chat session | Current Work session |
| File retrieval | Explicit references + selected workspace | Explicit references + selected workspace |
| Memory | Exact caller scope | Exact caller scope |
| MCP resources | Explicit URI only | Explicit URI only |
| Model route | Current configured agent route | Current configured agent route |
| Accept/undo | Browser draft transaction | Browser draft transaction |

Mode does not enable retrieval. Contributors decide from explicit purpose, caller identity, draft, and owned scope.

## 9. Empty-history handling

With no eligible history:

- the exact current draft still exists;
- explicit file, code, Memory, and MCP contributors still run under their own admission rules;
- a contributor with no applicable content adds nothing;
- the trace records the contributions and coverage that actually exist rather than inventing continuity.

A first Work therefore does not need fake Chat mode to retrieve explicit context.

## 10. Model request and browser result

After Context Engine preparation, the Host sends a separate request with no tools and a stable Prompt Enhancement instruction. The provider returns strict JSON:

```yaml
prompt_enhancement_result:
  originalDraft: string
  enhancedDraft: string
  assumptions: [string]
  openQuestions: [string]
  model: {provider, model}
  contextTrace: JsonValue|null
```

The generated Remote returns the complete proposal only after validation. The browser shows an original/enhanced diff, assumptions, questions, and admitted source explanations. Accept replaces the draft only when its value and monotonic revision still match the attempt; Undo uses another revision check. Cancellation, failure, session change, or a stale result preserves the current draft.

## 11. Adopted decisions

| Mechanism | Current decision |
|---|---|
| Shared Chat/Work context collection | Use one purpose-tagged Context Engine pass |
| Exact current draft | Keep as a separately framed input |
| Completed exchanges and approved checkpoints | Admit through Session History Context |
| File/code/memory/MCP retrieval | Reuse owning Context Engine contributors |
| Explicit files and external resources | Treat as first-class scoped inputs |
| Source explanation | Project existing Evidence into the result trace |
| Browser-selected model | Reject; Host uses the current configured agent route |
| Agent-loop execution | Reject; auxiliary request exposes no tools |
| Automatic draft replacement | Reject; require diff review and explicit Accept |
| Late unconditional replacement | Reject; use value + revision compare-and-set |
| Automatic submission | Reject; enhancement changes draft state only |
| Missing Context Engine fallback | Reject in shipped Web composition; miscomposition fails visibly |

## 12. Acceptance criteria

1. The same Context Engine pass serves the same draft and scope in Chat and Work.
2. First-use Work can retrieve explicitly introduced context without eligible history.
3. Files outside explicit/selected scope do not enter retrieval or the model request.
4. Completed exchanges and approved checkpoints remain attributable to durable events.
5. History is bounded and its omissions remain visible through coverage.
6. File, Code, Memory, History, and MCP Evidence retain distinct provenance.
7. The browser displays why, freshness, and verification for admitted sources.
8. Enhance creates no Work, executes no tool, and submits no message.
9. Cancellation, failure, and stale responses preserve the current draft.
