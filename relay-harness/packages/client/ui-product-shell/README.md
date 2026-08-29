# Client Product Shell

Shared browser product shell for the Chat, Work, and Library navigation model.

## Model Experience

- Fresh state is Simple mode, read from the Host `productMode` Remote.
- Work derives Goal, Plan, Jobs, Trajectory, Deliverables, and Approval summaries from the selected Session's existing projections.
- Library launches the real Files surface or a registered Memory, Skills, MCP, or Code Index settings section.
- Developer Mode restores advanced model, Agent preset, plugin, trajectory, context-inspector, and raw diagnostic entries without unloading their owning plugins.

## Known Limitations

- The sidebar remains the current top-level navigation host; Work and Library are compact sidebar pages rather than independent center-column routes.
- Product mode has no Host push event yet. Successful writes fold locally, and reconnect reloads the persisted value.
