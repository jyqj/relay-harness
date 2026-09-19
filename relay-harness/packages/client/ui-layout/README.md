# @relay-harness/rlh-client-ui-layout

English | [中文](README.zh.md)

Layout plugin owning AppFrame, main-page navigation, panel geometry, and theme presentation. It registers into `root` and declares `sidebar`, `shell.main`, `details`, `surfaces`, `shell.overlay`, `shell.titlebar.trailing`, and `shell.terminalDrawer`. Its MainContent registration owns `conversation` and keyed `shell.page`; product plugins contribute pages without acquiring the entire conversation or root.

## Main content and inspectors

The main area has a resident conversation and lazily mounted, resident visited pages. A registered page receives `active`. Hidden wrappers use native `hidden` plus `display: none`, excluding controls from keyboard focus and accessibility queries while preserving drafts and component identity. Unregistered pages are removed, and unknown selection falls back to conversation. `ctx.layout.mainNavigation` is a stable observable; `openMain(page)` changes central viewing state without selecting a Session. Explicit navigation dismisses inspectors and a narrow sidebar and transfers focus into the active main area. This navigation is not persisted or synchronized between clients.

Details and surfaces share one visible inspector position by intent: opening either closes the other while retaining their mounted subtrees. AppFrame invokes the column solver's inspector-priority policy. The requested inspector stays visible; the central area concedes space first and can yield the available width to it on a narrow frame. The non-prioritized pure solver still exposes its fixed center-floor concession policy. Consumers read solved widths, not stored preferences, for visibility. Neither policy deletes file buffers.

The sidebar starts at 280px and has a 56px collapsed rail. Portrait below 768px uses a sidebar overlay and full-screen tool details; landscape reflects physical device rotation rather than the keyboard-shrunk viewport. Sub-1024px frames hide the trailing titlebar cluster. Explicit main navigation closes a narrow sidebar overlay, making its selected content visible. The existing resize handles, pointer capture, and reduced-motion rules remain in the frame.

## Persistence and shell layers

Surfaces and terminal drawer persist their open state and last sizes in `rlhd.layout.panels`. Sidebar and details remain transient. Switching between distinct nonblank Sessions closes details; opening another inspector also closes it. The terminal drawer remains under the center column. Main pages share the original titlebar row through subgrid, with a 48px caption reserve.

AppFrame owns the caption drag band, the trailing titlebar cluster, and the click-through overlay layer. Full-frame modal entries mark their root with `data-shell-modal-overlay`, raising the overlay and disabling overlapping titlebar controls. The cluster clears native window controls, and squeezed conversation headers receive the existing width reserve and label density. Surfaces span all rows; details begin below the titlebar.

The theme presenter applies resolved palette variables, native `color-scheme`, dark-mode state, and one owned `theme-color` meta element. It removes its global writes when disposed. The browser entry exports plugin loading values, `LayoutController`, and public types; implementation components and the column solver stay package-internal.

## Model Experience

None, as layout state, focus, and navigation do not enter model requests.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- Main navigation, sidebar size, and details width are transient. A reload returns to the conversation and default sidebar; surface and terminal preferences persist.
- A narrow inspector can consume the central area. Closing it or explicitly selecting a main page restores the main content.
- Layout changes do not anchor text during reflow. Deep links and browser back/forward integration are not supplied by this navigation source.
