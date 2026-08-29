// @ts-check
'use strict';

/**
 * Pure readers for git's status and numstat output. Nothing here runs git or
 * touches the filesystem: the callers in `git.js` own the process, and these
 * turn its bytes into the shapes the Source Control pane renders.
 */

/**
 * Git-for-Windows `core.protectNTFS` rejects these device names in any path
 * component, including `NUL.txt` and trailing dots/spaces.
 * @param {unknown} rel
 * @returns {boolean}
 */
function isNtfsReservedGitPath(rel) {
  const normalized = String(rel || '').replaceAll('\\', '/');
  if (!normalized) return false;
  return normalized.split('/').some((part) => {
    const stem = part.replace(/[. ]+$/g, '').split('.')[0];
    return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem);
  });
}

/**
 * A working tree with nothing in it.
 * @returns {{ files: { path: string, insertions: number, deletions: number }[], insertions: number, deletions: number }}
 */
function emptyWorkingTree() {
  return { files: [], insertions: 0, deletions: 0 };
}

/**
 * The status a directory outside any repository reports.
 * @returns {object} A status whose every count is zero and `isRepo` false.
 */
function notARepoStatus() {
  return {
    isRepo: false,
    refName: null,
    hasWorkingTreeChanges: false,
    workingTree: emptyWorkingTree(),
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    aheadOfDefaultCount: 0,
    aheadUnreliable: false,
    pr: null,
    isDefaultRef: false,
    hasPrimaryRemote: false,
  };
}

/**
 * Read a porcelain v2 `branch.ab` header.
 * @param {unknown} value The header's value, such as `+2 -1`.
 * @returns {{ ahead: number, behind: number }} Zeroes when the header is absent or malformed.
 */
function parseBranchAb(value) {
  const match = /^\+(\d+)\s+-(\d+)$/.exec(String(value || '').trim());
  if (!match) return { ahead: 0, behind: 0 };
  return { ahead: Number(match[1]), behind: Number(match[2]) };
}

/**
 * The path one porcelain v2 entry names. A rename reports its destination,
 * which is the path the pane shows.
 * @param {string} line One line of `git status --porcelain=v2`.
 * @returns {string | null} The path, or null for a line that names none.
 */
function parsePorcelainV2Path(line) {
  if (line.startsWith('? ') || line.startsWith('! ')) {
    const simple = line.slice(2).trim();
    return simple.length > 0 ? simple : null;
  }
  if (!(line.startsWith('1 ') || line.startsWith('2 ') || line.startsWith('u '))) {
    return null;
  }
  const tabIndex = line.indexOf('\t');
  if (tabIndex >= 0) {
    const fromTab = line.slice(tabIndex + 1);
    const [filePath] = fromTab.split('\t');
    return filePath?.trim().length ? filePath.trim() : null;
  }
  const parts = line.trim().split(/\s+/g);
  const filePath = parts.at(-1) ?? '';
  return filePath.length > 0 ? filePath : null;
}

/**
 * Whether a `git diff HEAD` failure is the one a repository with no commits
 * yet produces, which the caller answers by diffing the index instead.
 * @param {unknown} stderr The command's stderr.
 * @returns {boolean} True for the unborn-HEAD failure.
 */
function isUnbornHeadStderr(stderr) {
  const lower = String(stderr || '').toLowerCase();
  return lower.includes('unknown revision') && lower.includes('path not in the working tree');
}

/**
 * Read `git diff --numstat`. A binary file's `-` counts as zero, and a rename
 * is recorded under its destination.
 * @param {unknown} stdout The command's stdout.
 * @returns {{ path: string, insertions: number, deletions: number }[]} One entry per line.
 */
function parseNumstatEntries(stdout) {
  const entries = [];
  for (const line of String(stdout || '').split(/\r?\n/g)) {
    if (line.trim().length === 0) continue;
    const [addedRaw, deletedRaw, ...pathParts] = line.split('\t');
    const rawPath = pathParts.length > 1
      ? (pathParts.at(-1) ?? '').trim()
      : pathParts.join('\t').trim();
    if (rawPath.length === 0) continue;
    const added = addedRaw === '-' ? 0 : Number.parseInt(addedRaw ?? '0', 10);
    const deleted = deletedRaw === '-' ? 0 : Number.parseInt(deletedRaw ?? '0', 10);
    const renameArrowIndex = rawPath.indexOf(' => ');
    const normalizedPath = renameArrowIndex >= 0
      ? rawPath.slice(renameArrowIndex + ' => '.length).trim()
      : rawPath;
    entries.push({
      path: normalizedPath.length > 0 ? normalizedPath : rawPath,
      insertions: Number.isFinite(added) ? added : 0,
      deletions: Number.isFinite(deleted) ? deleted : 0,
    });
  }
  return entries;
}

/**
 * Sum numstat entries per path, which an unborn HEAD needs because the staged
 * and unstaged diffs are read separately and can name the same file.
 * @param {{ path: string, insertions: number, deletions: number }[]} rows Entries to merge.
 * @returns {{ path: string, insertions: number, deletions: number }[]} One entry per path.
 */
function mergeNumstatMaps(rows) {
  const map = new Map();
  for (const entry of rows) {
    const existing = map.get(entry.path) ?? { insertions: 0, deletions: 0 };
    existing.insertions += entry.insertions;
    existing.deletions += entry.deletions;
    map.set(entry.path, existing);
  }
  return Array.from(map.entries()).map(([filePath, stat]) => ({
    path: filePath,
    insertions: stat.insertions,
    deletions: stat.deletions,
  }));
}

/**
 * Combine the diff's line counts with status's file list. A file status names
 * but the diff does not — an untracked one — is listed with no counts, and
 * paths Windows cannot check out are dropped from both.
 * @param {{ path: string, insertions: number, deletions: number }[]} numstatEntries Parsed numstat.
 * @param {readonly string[]} porcelainPaths Paths from porcelain v2.
 * @returns {{ files: { path: string, insertions: number, deletions: number }[], insertions: number, deletions: number }} The working tree, sorted by path.
 */
function buildWorkingTree(numstatEntries, porcelainPaths) {
  const fileStatMap = new Map();
  let insertions = 0;
  let deletions = 0;
  for (const entry of numstatEntries) {
    if (isNtfsReservedGitPath(entry.path)) continue;
    fileStatMap.set(entry.path, { insertions: entry.insertions, deletions: entry.deletions });
  }
  const files = Array.from(fileStatMap.entries()).map(([filePath, stat]) => {
    insertions += stat.insertions;
    deletions += stat.deletions;
    return { path: filePath, insertions: stat.insertions, deletions: stat.deletions };
  });
  for (const filePath of porcelainPaths) {
    if (fileStatMap.has(filePath) || isNtfsReservedGitPath(filePath)) continue;
    files.push({ path: filePath, insertions: 0, deletions: 0 });
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, insertions, deletions };
}

/**
 * Parse `git status --porcelain=v1 -z`. Rename/copy origin fields are skipped.
 * @param {string} stdout
 * @returns {{ path: string, xy: string }[]}
 */
function parsePorcelainZ(stdout) {
  const entries = [];
  const parts = String(stdout || '').split('\0');
  let i = 0;
  while (i < parts.length) {
    const rec = parts[i];
    i += 1;
    if (!rec || rec.length < 3) continue;
    const xy = rec.slice(0, 2);
    let filePath = rec.slice(3);
    if (xy.includes('R') || xy.includes('C')) {
      const dest = parts[i] || filePath;
      i += 1;
      filePath = dest;
    }
    entries.push({ path: filePath, xy });
  }
  return entries;
}

module.exports = {
  buildWorkingTree,
  emptyWorkingTree,
  isNtfsReservedGitPath,
  isUnbornHeadStderr,
  mergeNumstatMaps,
  notARepoStatus,
  parseBranchAb,
  parseNumstatEntries,
  parsePorcelainV2Path,
  parsePorcelainZ,
};
