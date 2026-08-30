// @ts-check
'use strict';

/**
 * The annotation overlay's chrome: the attributes that mark a node as ours and
 * the stylesheet the shadow root adopts. Every colour is a `--rlhd-preview-*`
 * variable the host writes, so the overlay follows the desktop theme.
 */

/** Marks a node the overlay owns, so hit-testing can skip its own chrome. */
const OVERLAY_ATTRIBUTE = 'data-rlhd-annotation-ui';
/** Carries the active tool on `<html>`, which the cursor rules read. */
const TOOL_ATTRIBUTE = 'data-rlhd-annotation-tool';
/** The overlay host sits above the page but below the browser's own UI. */
const Z_INDEX_OVERLAY = 2147483646;
/** Accent colour for outlines and the primary button. */
const PRIMARY = 'var(--rlhd-preview-primary)';
/** The translucent fill inside a selection outline. */
const PRIMARY_FILL = 'color-mix(in srgb, var(--rlhd-preview-primary) 10%, transparent)';
/** Outlines and labels, drawn over the page. */
const CONTENT_LAYER_Z_INDEX = 1;
/** Toolbar and editor, drawn over the outlines. */
const CHROME_LAYER_Z_INDEX = 10;

const OVERLAY_STYLES = `
:host, [${OVERLAY_ATTRIBUTE}] { font-family: var(--rlhd-preview-font-sans, system-ui, sans-serif); color: var(--rlhd-preview-foreground); box-sizing: border-box; }
*, *::before, *::after { box-sizing: border-box; }
.ann-toolbar {
  pointer-events: auto; position: fixed; top: 10px; left: 50%; transform: translateX(-50%);
  display: flex; gap: 2px; border-radius: var(--rlhd-preview-radius, 8px);
  border: 1px solid var(--rlhd-preview-border); padding: 4px;
  background: color-mix(in srgb, var(--rlhd-preview-popover) 95%, transparent);
  color: var(--rlhd-preview-popover-foreground); z-index: ${CHROME_LAYER_Z_INDEX};
  box-shadow: 0 8px 24px rgba(0,0,0,0.12);
}
.ann-editor {
  pointer-events: auto; position: fixed; display: none; max-height: calc(100vh - 16px);
  width: min(360px, calc(100vw - 16px)); flex-direction: column; overflow: hidden;
  border-radius: calc(var(--rlhd-preview-radius, 8px) + 4px);
  border: 1px solid var(--rlhd-preview-border);
  background: color-mix(in srgb, var(--rlhd-preview-popover) 96%, transparent);
  color: var(--rlhd-preview-popover-foreground); z-index: ${CHROME_LAYER_Z_INDEX};
  box-shadow: 0 16px 40px rgba(0,0,0,0.18);
}
.ann-row { display: flex; align-items: flex-start; gap: 8px; padding: 8px; }
.ann-btn {
  display: inline-flex; height: 28px; align-items: center; justify-content: center;
  border: 1px solid transparent; border-radius: var(--rlhd-preview-radius, 6px);
  padding: 0 8px; cursor: pointer;
  font: 500 12px var(--rlhd-preview-font-sans, system-ui, sans-serif);
  color: var(--rlhd-preview-foreground); background: transparent;
}
.ann-btn:hover { background: var(--rlhd-preview-accent); }
.ann-btn:disabled { pointer-events: none; opacity: 0.6; }
.ann-btn[data-active="true"] {
  background: color-mix(in srgb, var(--rlhd-preview-primary) 10%, transparent);
  color: var(--rlhd-preview-primary);
}
.ann-btn-primary {
  height: 32px; border-color: var(--rlhd-preview-primary);
  background: var(--rlhd-preview-primary); color: var(--rlhd-preview-primary-foreground);
}
.ann-icon { height: 32px; width: 32px; flex-shrink: 0; background: var(--rlhd-preview-muted);
  color: var(--rlhd-preview-muted-foreground); padding: 0; }
.ann-comment {
  min-height: 32px; max-height: 96px; min-width: 0; flex: 1; resize: none; overflow-y: hidden;
  border: 0; border-bottom: 1px solid transparent; background: transparent; padding: 6px 0;
  font: 14px/20px var(--rlhd-preview-font-sans, system-ui, sans-serif);
  color: var(--rlhd-preview-foreground); outline: none;
}
.ann-comment:focus { border-bottom-color: var(--rlhd-preview-primary); }
.ann-comment::placeholder { color: var(--rlhd-preview-muted-foreground); }
.ann-drag {
  display: none; height: 32px; width: 24px; flex-shrink: 0; cursor: grab; border: 0;
  background: transparent; padding: 0; font: 700 18px/20px var(--rlhd-preview-font-sans, system-ui);
  color: var(--rlhd-preview-muted-foreground);
}
.ann-styles {
  display: none; max-height: min(176px, calc(100vh - 180px)); overflow: auto;
  border-top: 1px solid var(--rlhd-preview-border);
  background: color-mix(in srgb, var(--rlhd-preview-muted) 40%, transparent); padding: 0 12px;
}
.ann-section { display: grid; gap: 4px; border-top: 1px solid var(--rlhd-preview-border); padding: 8px 0; }
.ann-field {
  display: grid; min-height: 28px; grid-template-columns: 82px minmax(0,1fr); align-items: center;
  gap: 8px; font: 500 12px var(--rlhd-preview-font-sans, system-ui); color: var(--rlhd-preview-muted-foreground);
}
.ann-control, .ann-field select, .ann-field input[type=number], .ann-field input[type=text], .ann-field input[type=range] {
  height: 28px; min-width: 0; width: 100%; border-radius: var(--rlhd-preview-radius, 6px);
  border: 1px solid var(--rlhd-preview-input); background: var(--rlhd-preview-background);
  padding: 0 8px; font: 12px var(--rlhd-preview-font-mono, ui-monospace, monospace);
  color: var(--rlhd-preview-foreground); outline: none;
}
.ann-unit { position: relative; min-width: 0; }
.ann-unit-label {
  pointer-events: none; position: absolute; top: 50%; right: 8px; transform: translateY(-50%);
  font: 12px var(--rlhd-preview-font-mono, ui-monospace, monospace); color: var(--rlhd-preview-muted-foreground);
}
.ann-label {
  position: fixed; pointer-events: none; white-space: nowrap; text-overflow: ellipsis;
  overflow: hidden; max-width: 280px; border-radius: var(--rlhd-preview-radius, 6px);
  background: var(--rlhd-preview-primary); color: var(--rlhd-preview-primary-foreground);
  padding: 4px 8px; font: 600 12px var(--rlhd-preview-font-sans, system-ui);
  z-index: ${CONTENT_LAYER_Z_INDEX}; box-shadow: 0 4px 12px rgba(0,0,0,0.16);
}
input[type=number]::-webkit-inner-spin-button, input[type=number]::-webkit-outer-spin-button { appearance: none; margin: 0; }
`;

/**
 * The rules that turn the page's cursor into a crosshair while a tool is armed,
 * while leaving the overlay's own chrome pointing normally.
 *
 * @returns {string} A stylesheet the overlay injects into the guest document.
 */
function cursorStyles() {
  return `html[${TOOL_ATTRIBUTE}] body, html[${TOOL_ATTRIBUTE}] body * { cursor: crosshair !important; } `
    + `[${OVERLAY_ATTRIBUTE}], [${OVERLAY_ATTRIBUTE}] * { cursor: default !important; }`;
}

module.exports = {
  CONTENT_LAYER_Z_INDEX,
  OVERLAY_ATTRIBUTE,
  OVERLAY_STYLES,
  PRIMARY,
  PRIMARY_FILL,
  TOOL_ATTRIBUTE,
  Z_INDEX_OVERLAY,
  cursorStyles,
};
