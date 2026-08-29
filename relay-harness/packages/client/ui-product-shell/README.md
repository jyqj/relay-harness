# Client Product Shell

English | [中文](README.zh.md)

Shared browser product shell for the Chat, Work, and Library navigation model.

Simple Mode suppresses advanced model/preset/plugin/trajectory controls but keeps the Context Inspector provenance surface visible. Work reads existing Goal, Plan, Jobs, Trajectory, Deliverables, Approval, Question, and Session projections; Library opens the existing Files and governance Settings surfaces. Deliverable links are normalized and confined to the current Session workspace before navigation.

## Model Experience

### No direct model request

#### What the model sees

Nothing from this package. `productMode`, Work, and Library are browser projections over existing Host and Session state.

#### Token effect

Zero tokens. Changing the product shell never appends a Session event or prepares model context.

#### KV Cache effect

None. The shell changes visible controls and navigation without changing a model request or cache prefix.

## Known Limitations and Deferred Work

- The sidebar remains the current top-level navigation host; Work and Library are compact sidebar pages rather than independent center-column routes.
- Product mode has no Host push event yet. Successful writes fold locally, and reconnect reloads the persisted value.
