# @relay-harness/rlh-mcp-servers-file

English | [中文](README.zh.md)

Owns `$RLH_HOME/mcp-servers.yaml` (or an explicit `path`) and mounts one [`@relay-harness/rlh-mcp-client`](../mcp-client/README.md) child for each enabled record. The document is a YAML object with a `servers` array; each record carries a unique `id`, `serverName`, `enabled`, and either stdio (`command`, `args`, `env`, `cwd`) or Streamable HTTP (`url`, `headers`) fields that match the mcp-client Config. Writes use the atomic-write lock; a watcher remounts children after an external edit. The `mcpServersFile` service exposes `listManaged`, `upsert`, `remove`, `setEnabled`, `remount`, and `authorize`. `authorize` runs MCP HTTP OAuth (PKCE) in the system browser, writes `Authorization: Bearer …` on that record, and remounts so the child's tools are live. HTTP endpoints must be absolute HTTP(S), contain no URL credentials/fragment/secret query keys, and use headers for credentials. Secret-looking env, header, and legacy URL values are masked on `listManaged`; a blank or `********` upsert keeps the stored value.

OAuth metadata, client registration, and token exchange require successful HTTP responses before their JSON fields can authorize further work. HTTP-status and JSON-validation diagnostics do not include response bodies. A created callback listener is closed when registration or token exchange fails. The loopback callback requires GET and a matching state before consuming either a code or an authorization error; invalid traffic leaves the active login intact. Only one wait is allowed, timeout permits a new wait, and idempotent close rejects the pending wait and clears its timer. Browser-launch exceptions cannot leave an unobserved callback rejection. Browser hand-off awaits the shared `rlh-native-command` runner with a ten-second cancellation deadline, rather than starting an unobserved detached child. Targets must be HTTP(S) URLs without embedded credentials or fragments. Windows uses a quoted PowerShell literal instead of `cmd /c start`; native command errors are replaced with a body-free diagnostic. Native Windows execution is separate release evidence, not established by the offline argv tests.

An OAuth result is bound to the HTTP URL that started the login. Before storing a bearer, the mutation reloads the document under its cross-process file lock, rejects deleted/non-HTTP/changed endpoints, and preserves newer unrelated fields and rows. Mutations refuse unreadable or malformed documents rather than overwriting them from the in-memory fallback; read-side refresh still retains the last valid document.

Each service instance admits startup only once; another start is rejected before a second background owner is created. Shutdown closes admission synchronously. Its idempotent disposer returns one promise that drains boot and previously admitted mutations, closes the watcher, and waits for every child disposer even if another fails. Reconciliation does not mount replacements after closure, and OAuth results arriving later cannot persist. The service aborts its active OAuth lifetime before draining authorization tasks. The signal reaches network requests, native browser hand-off, and callback waiting; every HTTP request also has a thirty-second cancellation deadline covering response-body consumption. Injected runtimes must honor cancellation; teardown does not silently detach an uncooperative implementation.

OAuth JSON bodies are limited to 1 MiB: declared length is checked early and streamed decoded bytes are counted independently, including when a server omits or understates the length. Readers release their locks and cancel abandoned bodies; challenge and HTTP-error bodies are discarded without buffering. Listener close also destroys its own active connections, so an incomplete callback request cannot hold shutdown open. A listener whose bound address fails validation is closed before startup rejects.

Both managed-list projections are detached snapshots, including nested headers, environment maps, arguments, and reconnect settings. Mutating a returned snapshot cannot change the live service document or mounted child configuration. The raw projection intentionally retains secret values; detachment is an ownership guarantee, not a redaction or authorization boundary.

Once the watcher finishes its initial scan, it queues a fresh disk read to recover edits made after the startup snapshot but before subscription. This reconciliation uses the same serialized operation queue as subsequent file events and is not admitted after shutdown. Watcher deduplication compares a parsed external document with the current in-memory document, not a historical self-written payload. Restoring an earlier configuration therefore remains a real update. Invalid external YAML retains the last valid live configuration without rewriting the file; deletion clears the managed list and recreation is observed by the same watcher.

Watcher error events are contained and reported without echoing error details; the current configuration remains available and later valid file events can still apply. Background boot failures are observed even before a caller awaits readiness, while callers awaiting readiness still receive the original failure. Background read/parse diagnostics never include YAML excerpts or configuration values.

Authorization-server discovery follows [RFC 8414 Sections 3.1 and 3.3](https://www.rfc-editor.org/rfc/rfc8414.html#section-3): the well-known prefix is inserted before the issuer path, and returned metadata must carry exactly the discovered issuer string. Issuer URLs require HTTPS and reject credentials, query components, and fragments before metadata retrieval. These checks do not claim complete support for every OAuth discovery extension.

Protected-resource metadata must identify the exact requested resource before its authorization-server list is used, including when the metadata URL came from a challenge header. Fallback discovery preserves the non-root resource path and query. These identity checks follow [RFC 9728 Section 3](https://www.rfc-editor.org/rfc/rfc9728.html#section-3).

The advertised authorization-server and scope collections must be arrays whose members are non-empty strings; malformed collections fail before listener admission. Selection still uses the first advertised issuer and scope rather than automatically requesting every disclosed scope.

Authorization, registration, and token endpoints must be absolute HTTPS URLs without credentials or fragments, validated before listener creation. The OAuth transport does not automatically follow redirects for probes, metadata, registration, or token requests; servers must expose the intended final endpoint directly. This prevents a later redirect from bypassing admission or forwarding a grant to another location.

OAuth resource URLs require HTTPS except explicit `127.0.0.1`, `localhost`, and `[::1]` HTTP development origins. Plain-HTTP protected-resource metadata is allowed only on the same origin as such a resource; HTTPS metadata may be explicitly delegated to another origin. Both locations reject embedded credentials and fragments before network admission. This OAuth policy does not change the general managed transport URL schema.

## Model Experience

None, as this package only mounts already-defined mcp-client instances and never assembles prompts, tools, or provider requests itself.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **No import from Cursor or Claude `.mcp.json`** — the document format is reserved for a later importer; this package only reads its own YAML.
- **Composition-owned mcp-client rows stay outside this file** — hand-written `cordis.patch.yml` instances are not rewritten here.
- **OAuth access tokens expire** — there is no refresh-token renewal; sign in again from Settings when the server returns 401.
