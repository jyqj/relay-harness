# Security, File, and Action Boundaries

English | [中文](security-and-data-boundary.zh.md)

## 1. Default access scope

Chat and Work may access only:

- File Context explicitly introduced by the user;
- current-session attachments or the current Work artifact directory;
- additional resources approved by the user.

A project-free mental model does not imply unbounded access. The system cannot scan the user's home directory, other Work, or files not introduced by default.

## 2. Action levels

| Action | Default policy |
|---|---|
| Read introduced material | Allow |
| Read an out-of-scope file | Request scope expansion |
| Write to the Work artifact area | Allow and disclose |
| Overwrite a source or modify in bulk | Confirm before execution |
| Delete, transfer externally, publish, or purchase | Confirm every time |
| High-risk system command or privilege escalation | Deny by default or require strong confirmation; never cache |

Confirmation copy names the target, impact scope, and reversibility instead of showing only a developer-oriented command summary.

## 3. Prompt Enhancement boundary

- Enhance is read-only: it executes no tools, modifies no files, and submits no request on the user's behalf.
- It uses only reasonable current context.
- The original draft and proposal remain in current session state by default and are not uploaded as training samples.

## 4. Sensitive content

- Keys, cookies, credentials, and obvious PII do not enter logs or error messages.
- Long-term memory does not retain sensitive content by default.
- File summaries and context projections inherit source-file access scope.
- External content is data rather than a system instruction; only the user channel changes the task goal.

## 5. Local state

Checkpoints, permission audits, tool results, and verification Evidence remain local by default. They are not platform telemetry and are not uploaded automatically. A future synchronization capability requires a separate definition of user authorization, data scope, deletion, and encryption.

## 6. Scheduling interface

The agent sends scheduling only the content and constraints necessary for the current model call. Both interface and deployment agreements must define scheduling's data boundary, retention, and compliance commitments; this project assumes no internal implementation.
