# @relay-harness/rlh-client-ui-code-index-center

English | [中文](README.zh.md)

Web Settings Code Index Center following the currently selected Session and showing only that Workspace's file/chunk health, epochs, embedding generations, vector coverage, backlog, failures, BuildExplain, and compact debug hits. Refresh and reconcile are direct actions; destructive rebuild requires typing `REBUILD` and the Host independently verifies the token.

## Model Experience

### No direct model request

#### What the model sees

Nothing directly. No `user/message` is added; this package observes or manages already-derived context/index state and never assembles a model request.

#### Token effect

Zero tokens directly. Later context retrieval may change only after an explicit index or governance operation.

#### KV Cache effect

No request-prefix or cache-key change is introduced by this package.

## Known Limitations and Deferred Work

- A blank/no-directory Session has no index target; the UI asks the user to select a Workspace instead of falling back to another cache entry.

- Search debug intentionally returns compact candidate metadata and never hydrates source bodies.
