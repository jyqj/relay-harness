# @relay-harness/rlh-client-ui-code-index-center

English | [中文](README.zh.md)

Web Settings Code Index Center following the currently selected Session and showing only that Workspace's file/chunk health, epochs, embedding generations, vector coverage, backlog, failures, BuildExplain, and compact debug hits. Refresh and reconcile are direct actions; destructive rebuild requires typing `REBUILD` and the Host independently verifies the token.

Session selection comes from the framework `useSessions` hook. Rebuild confirmation belongs to the opening Session: switching Session dismisses it and clears the token; reopening also requires typing `REBUILD` again. The browser entry keeps its component and cache implementation private.

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

Status cache publication is Session-scoped and owned by the latest admitted request. Connection reset retires pending owners as well as cached values, so late replies cannot restore invalidated state. Status reads wait for this store's pending maintenance requests for the same Session to settle, then bypass any old cache. Connection reset retains this wait barrier but retires cache publication owners. This does not serialize Host operations, other Sessions, or other clients, and does not cancel requests already dispatched.

Plugin unload permanently retires its cache instance and rejects new calls through retained callbacks. Waiting status reads recheck this lifetime after maintenance settles, so hot reload cannot resume them against a replacement plugin. Already-dispatched Host work is not cancelled.
