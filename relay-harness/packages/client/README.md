# client/ — web-GUI browser half

English | [中文](README.zh.md)

The browser side of the rlh web GUI: shell boot, browser-host communication, shared UI services, and feature plugins. Authoring rules live in [AGENTS.md](AGENTS.md); the host half is [`host/`](../host/README.md). All except `test-runtime` are **product** packages named `@relay-harness/rlh-client-<name>`.

| Package | Purpose |
|---|---|
| [`web/`](web/README.md) | Boots the browser shell from the client entry graph. |
| [`ui-renderer/`](ui-renderer/README.md) | Binds slot data to React and mounts the assembled application after client boot settles. |
| [`modules/`](modules/README.md) | Loads browser-side client modules. |
| [`connection/`](connection/README.md) | Maintains browser-host RPC communication and event delivery. |
| [`runtime/`](runtime/README.md) | Provides shared client services for sessions, workspaces, and UI composition. |
| [`hmr/`](hmr/README.md) | Refreshes client plugins during development. |
| [`locale/`](locale/README.md) | Provides localization preferences and message dictionaries. |
| [`test-runtime/`](../test-support/client-runtime/README.md) | Provides shared repository test support for client feature packages. |
| [`ui-slots/`](ui-slots/README.md) | Defines how UI features register and compose extension slots. |
| [`ui-theme/`](ui-theme/README.md) | Applies the selected color theme. |
| [`ui-primitives/`](ui-primitives/README.md) | Provides shared React controls, icons, and content renderers. |
| [`ui-attachment/`](ui-attachment/README.md) | Registers composer and message-image attachment presentation. |
| [`ui-layout/`](ui-layout/README.md) | Arranges the main application regions. |
| [`ui-surfaces/`](ui-surfaces/README.md) | Owns the right-panel surface shell, its tab strip, and the per-session surfaces store. |
| [`ui-user-terminal/`](ui-user-terminal/README.md) | Runs user PTY terminals in the conversation drawer and the Terminal surface. |
| [`ui-preview/`](ui-preview/README.md) | Previews http(s) documents in the desktop-only Browser surface. |
| [`ui-files/`](ui-files/README.md) | Provides the workspace file tree and single-file preview surfaces. |
| [`ui-diff/`](ui-diff/README.md) | Presents workspace changes and unified hunks in the Diff surface. |
| [`ui-agents-panel/`](ui-agents-panel/README.md) | Lists the current session's subagents and background jobs in the Agents surface. |
| [`ui-sidebar/`](ui-sidebar/README.md) | Presents workspace and session navigation. |
| [`ui-product-shell/`](ui-product-shell/README.md) | Composes Chat, Work, and Library navigation with persisted Simple/Developer mode. |
| [`ui-brand-official/`](ui-brand-official/README.md) | Fills the generic browser-brand slots with the official name and marks. |
| [`ui-titlebar/`](ui-titlebar/README.md) | Toggles the terminal drawer and the surfaces column from the titlebar. |
| [`ui-git/`](ui-git/README.md) | Adds commit, push, and change-request actions to the titlebar. |
| [`ui-issue-orchestration/`](ui-issue-orchestration/README.md) | Presents the Remote issue orchestration snapshot as a titlebar badge and operator cards. |
| [`ui-workspace/`](ui-workspace/README.md) | Provides workspace selection and creation surfaces. |
| [`ui-session-tree/`](ui-session-tree/README.md) | Renders the workspace's session fork lineage as a canvas tree overlay. |
| [`ui-directory-picker-native/`](ui-directory-picker-native/README.md) | Answers workspace directory picks through the local Host's OS chooser. |
| [`ui-directory-picker-browse/`](ui-directory-picker-browse/README.md) | Fills ui-workspace's directory-flow holes with an in-app directory browser dialog. |
| [`ui-conversation/`](ui-conversation/README.md) | Presents the active conversation and its input surface. |
| [`ui-context-inspector/`](ui-context-inspector/README.md) | Opens a conversation-header drawer over the Context Inspector session projection. |
| [`ui-message-edit/`](ui-message-edit/README.md) | Turns the latest user message into an edit that forks a child session and resends. |
| [`ui-message-feedback/`](ui-message-feedback/README.md) | Adds Like/Dislike ratings and notes to finalized assistant messages. |
| [`ui-deliverables/`](ui-deliverables/README.md) | Registers the produced-files row and inline file mentions that close a finished turn. |
| [`ui-tool/`](ui-tool/README.md) | Composes Tool call trees and keyed per-Tool views. |
| [`ui-workflow-run/`](ui-workflow-run/README.md) | Replays durable workflow runs as nested Chat disclosures with live-only child navigation. |
| [`ui-goal/`](ui-goal/README.md) | Presents and manages the current goal. |
| [`ui-trajectory/`](ui-trajectory/README.md) | Presents alternate views of agent activity. |
| [`ui-commands/`](ui-commands/README.md) | Provides session-aware command discovery and dispatch. |
| [`ui-input-trigger/`](ui-input-trigger/README.md) | Coordinates inline command and reference suggestions. |
| [`ui-skill/`](ui-skill/README.md) | Adds skill references to inline suggestions. |
| [`ui-reference/`](ui-reference/README.md) | Unified Web `@file` / `@session` reference source. |
| [`ui-subagent/`](ui-subagent/README.md) | Provides subagent navigation, child transcript states, and inline references. |
| [`ui-jobs/`](ui-jobs/README.md) | Lists this session's background jobs in the conversation header. |
| [`ui-model-selection/`](ui-model-selection/README.md) | Provides model selection in conversation surfaces. |
| [`ui-permission-presets/`](ui-permission-presets/README.md) | Configures default permissions and switches the current session's access. |
| [`ui-plan/`](ui-plan/README.md) | Presents active plan-mode status and its exit control. |
| [`ui-prompt-enhancement/`](ui-prompt-enhancement/README.md) | Enhances an unsent draft through the Host Remote without submitting it. |
| [`ui-settings-plugins/`](ui-settings-plugins/README.md) | Owns the Plugins settings section, its tab extension point, and configurable host-plane plugin cards. |
| [`ui-user-questions/`](ui-user-questions/README.md) | Presents interactive questions requested by the agent. |
| [`ui-agent-preset/`](ui-agent-preset/README.md) | Selects a session's agent preset and authors preset compositions. |
| [`ui-settings/`](ui-settings/README.md) | Hosts the settings interface and its extension areas. |
| [`ui-settings-general/`](ui-settings-general/README.md) | Provides the general settings section. |
| [`ui-settings-models/`](ui-settings-models/README.md) | Provides model-provider configuration and DeepSeek onboarding. |
| [`ui-settings-mcp/`](ui-settings-mcp/README.md) | Provides the MCP server settings section. |
| [`ui-settings-skills/`](ui-settings-skills/README.md) | Provides the skills settings section over the live Agent's layered skill catalog. |
| [`ui-code-index-center/`](ui-code-index-center/README.md) | Provides the Code Index settings page for the current workspace's index health. |
| [`ui-memory-center/`](ui-memory-center/README.md) | Provides the Memory settings page for memory governance and review. |
| [`ui-settings-plugin-inventory/`](ui-settings-plugin-inventory/README.md) | Contributes the read-only Host Loader inventory tab to Plugins settings. |
| [`ui-settings-remote/`](ui-settings-remote/README.md) | Contributes the desktop-only phone Remote popup beside Settings. |

Each child reference owns its contract and detailed behavior. The [slot system standard](../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) and [web client architecture note](../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) own the cross-package composition and loading decisions.

The subsystem reference is [client-modules.md](../../docs/subsystems/client-modules.md); the [slot system standard](../../.agents/notes/implemented/architecture/2026-07-22-slot-type-chain-implementation.md) is the definitive slot model, and the [web client architecture note](../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) owns the loading chain and object layer.
