# Work and File Context

English | [中文](work-and-files.zh.md)

File Context is the shared file boundary for Chat and Work: it follows the conversation in Chat and the independent task in Work. This page focuses on persistent Work execution.

## 1. Work is not a Project

Work means “something to complete.” Users do not need to create a project, name a workspace, or configure a directory first. Each Work independently owns:

- its goal and conversation;
- introduced files and folders;
- plan, state, and confirmations;
- generated artifacts;
- checkpoints and local verification records.

## 2. Introducing files

Users may attach files in Chat or introduce files/folders before or during Work. Introduction creates a File Context entry for that conversation or Work rather than a Project.

```yaml
file_context_item:
  id: string
  display_name: string
  source: upload|local_path|folder|generated
  source_ref: string
  media_type: string
  fingerprint: string
  access: read_only|read_write
  status: pending|ready|unsupported|stale|removed
  user_note: string|null
  extracted_summary_ref: string|null
```

## 3. Read policy

- Read only explicitly introduced content by default.
- Inventory a folder first, then read files according to task relevance.
- Extract structure, metadata, and summaries for large files; page through bodies on demand.
- Explain unsupported binary or file formats in ordinary language rather than pretending to have read them.
- Mark changed fingerprints stale and confirm or refresh before use.

## 4. Access and writes

- A `read_only` input cannot be modified in place.
- Write generated results to the current Work artifact area by default.
- Confirm before overwriting sources, deleting, bulk rewriting, or writing beyond File Context scope.
- Artifacts record source files and generation steps so users can understand their origin.

## 5. User-interface requirements

- Keep the current Work's introduced-file manifest visible.
- Let users add, remove, refresh, or annotate files.
- Distinguish input material from Relay artifacts.
- Do not require ordinary users to configure developer concepts such as repository, workspace, or root; advanced local coding may introduce a folder as one File Context.

## 6. Relationship to Prompt Enhancement

Prompt Enhancement receives only the file manifest, user notes, and summaries relevant to the draft. It reads complete file bodies only when draft improvement requires them and never modifies files.
