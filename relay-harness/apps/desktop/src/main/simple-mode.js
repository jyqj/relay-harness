// @ts-check
'use strict';

/**
 * Simple mode: the shell's answer to "I only want to talk to the agent". When
 * it is on, the desktop chrome drops the entries that only make sense to
 * someone extending the product — the plugin market, MCP and skills — so the
 * menu bar and tray carry nothing but the workspace, settings and the Harness
 * process itself.
 *
 * The web UI reads the same flag off `publicConfig`, which is why this lives in
 * config rather than in the menu code that consumes it.
 */

/**
 * Whether the shell should present its reduced surface.
 *
 * @param {{ simpleMode?: unknown } | null | undefined} config A loaded desktop config.
 * @returns {boolean} True only when the flag is explicitly on.
 */
function isSimpleMode(config) {
  return Boolean(config && config.simpleMode === true);
}

/**
 * Whether a menu entry is one simple mode hides. An entry opts in by carrying
 * `advanced: true`; everything else is part of the reduced surface.
 *
 * @param {{ advanced?: unknown }} entry One menu or tray template entry.
 * @returns {boolean} True when the entry is extension-facing.
 */
function isAdvancedEntry(entry) {
  return Boolean(entry) && entry.advanced === true;
}

/**
 * Drop the `advanced` flag Electron does not understand, descending into a
 * submenu the same way the caller descends into the template.
 *
 * @param {{ advanced?: unknown, submenu?: unknown }} entry One template entry.
 * @param {boolean} simpleMode Whether the reduced surface is on.
 * @returns {object} The entry Electron can build from.
 */
function cleanEntry(entry, simpleMode) {
  const { advanced: _advanced, ...rest } = entry;
  if (!Array.isArray(rest.submenu)) return rest;
  return { ...rest, submenu: shellMenuEntries(rest.submenu, simpleMode) };
}

/**
 * A menu template with the advanced entries removed, or the template unchanged
 * when simple mode is off. Submenus are filtered the same way, and separators
 * that end up leading, trailing or doubled are dropped, so removing an entry
 * never leaves a stray rule behind.
 *
 * @param {readonly object[]} entries The template a menu was going to build from.
 * @param {boolean} simpleMode Whether the reduced surface is on.
 * @returns {object[]} The entries to build, always without the `advanced` marker.
 */
function shellMenuEntries(entries, simpleMode) {
  const kept = simpleMode ? entries.filter((entry) => !isAdvancedEntry(entry)) : [...entries];
  const trimmed = [];
  for (const entry of kept) {
    const isSeparator = Boolean(entry) && entry.type === 'separator';
    if (isSeparator && (trimmed.length === 0 || trimmed.at(-1).type === 'separator')) continue;
    trimmed.push(entry);
  }
  while (trimmed.length > 0 && trimmed.at(-1).type === 'separator') trimmed.pop();
  return trimmed.map((entry) => cleanEntry(entry, simpleMode));
}

module.exports = {
  isAdvancedEntry,
  isSimpleMode,
  shellMenuEntries,
};
