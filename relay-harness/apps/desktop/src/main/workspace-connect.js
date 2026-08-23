'use strict';

/**
 * Shared page-driving engine plus the workspace-connect walk.
 *
 * This module is the packaged half of the QA surface: the launch smoke
 * (`RLH_SMOKE=1`, run against the installed app by `npm run smoke:packaged`)
 * needs `connectConfiguredWorkspace` to unlock the workspace before it can
 * hit-test the branch/git titlebar controls, so unlike the full QA walkers
 * (`release-ui-walk.js`, `composer-official-qa.js`) these helpers ship inside
 * the installer. `release-ui-walk.js` re-exports them to keep its own callers
 * unchanged.
 */

/**
 * In-page helpers for the Electron release walk. Kept as a string so
 * executeJavaScript can eval them without a Node closure.
 */
const PAGE_HELPERS = `
function rlhShown(el) {
  if (!el) return false;
  if (el.closest('[aria-hidden="true"]')) return false;
  const box = el.getBoundingClientRect();
  if (box.width < 1 || box.height < 1) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none';
}
function rlhLabel(el) {
  return ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || ''))
    .replace(/\\s+/g, ' ').trim();
}
function rlhFind(pattern, root) {
  const re = new RegExp(pattern, 'i');
  const scope = root || document;
  return Array.from(scope.querySelectorAll(
    'button, [role="button"], [role="menuitem"], [role="tab"], [role="searchbox"], [role="textbox"], input, textarea, a'
  )).find((el) => rlhShown(el) && re.test(rlhLabel(el))) || null;
}
function rlhSetValue(el, value) {
  if (!el) return false;
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (!setter) return false;
  const tracker = el._valueTracker;
  if (tracker) tracker.setValue('');
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}
function rlhDialog() {
  return Array.from(document.querySelectorAll('[role="dialog"]')).find(rlhShown) || null;
}
function rlhDialogNamed(pattern) {
  const re = new RegExp(pattern, 'i');
  return Array.from(document.querySelectorAll('[role="dialog"]')).filter(rlhShown).find((el) => {
    const labelled = el.getAttribute('aria-labelledby');
    const title = labelled ? ((document.getElementById(labelled) && document.getElementById(labelled).textContent) || '') : '';
    const aria = el.getAttribute('aria-label') || '';
    return re.test(aria) || re.test(title);
  }) || null;
}
function rlhHeading(pattern, root) {
  const re = new RegExp(pattern, 'i');
  const scope = root || document;
  return Array.from(scope.querySelectorAll('h1, h2, h3')).find((el) =>
    rlhShown(el) && re.test((el.textContent || '').trim())) || null;
}
`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(probe, timeoutMs, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await probe();
    if (last) return last;
    await sleep(intervalMs);
  }
  return last;
}

function pageEval(wc, fn) {
  return wc.executeJavaScript(`(() => { ${PAGE_HELPERS}; return (${fn.toString()})(); })()`);
}

function pageScript(wc, body, args) {
  return wc.executeJavaScript(`(() => {
    ${PAGE_HELPERS}
    const args = ${JSON.stringify(args || {})};
    ${body}
  })()`);
}

function clickNamed(wc, pattern, rootSelector) {
  return pageScript(wc, `
    const root = args.rootSelector ? document.querySelector(args.rootSelector) : document;
    const el = rlhFind(args.pattern, root || document);
    if (!el || el.disabled) return false;
    el.click();
    return true;
  `, { pattern, rootSelector: rootSelector || null });
}

async function pressEnter(wc) {
  const key = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
  await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
}

function makeRecorder(steps) {
  return (name, ok, detail, optional = false) => {
    const row = {
      name,
      ok: Boolean(ok),
      detail: detail == null ? '' : String(detail).slice(0, 400),
    };
    if (optional) row.optional = true;
    steps.push(row);
    console.log(`[RLH_QA] ${ok ? 'PASS' : (optional ? 'SKIP' : 'FAIL')} ${name}${row.detail ? ` — ${row.detail}` : ''}`);
  };
}

/**
 * Connect the configured desktop workspace through the in-app directory picker.
 *
 * @param {Electron.WebContents} wc
 * @param {{ workspacePath: string, pressEscape: Function }} helpers
 * @param {(name: string, ok: boolean, detail?: string, optional?: boolean) => void} rec
 */
async function connectConfiguredWorkspace(wc, helpers, rec) {
  const workspacePath = helpers.workspacePath;
  rec('workspace.path', Boolean(workspacePath), workspacePath || 'missing', true);
  if (!workspacePath) {
    rec('workspace.connected', false, 'helpers.workspacePath missing');
    return false;
  }

  const clicked = await clickNamed(wc, '^add workspace$|^添加工作区$');
  rec('workspace.addClicked', Boolean(clicked), '', true);
  await sleep(300);
  await pageEval(wc, () => {
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) =>
      rlhShown(el) && /add workspace|添加工作区/i.test(rlhLabel(el)));
    if (!item) return false;
    item.click();
    return true;
  });

  const picker = await waitUntil(() => pageEval(wc, () =>
    Boolean(rlhDialogNamed('select workspace directory|选择工作区目录'))), 10_000);
  rec('workspace.picker', Boolean(picker), picker ? '' : 'directory picker missing');
  if (!picker) {
    rec('workspace.connected', false, 'picker did not open');
    return false;
  }

  await clickNamed(wc, 'edit path|编辑路径');
  await sleep(250);
  const filled = await pageScript(wc, `
    const dialog = rlhDialogNamed('select workspace directory|选择工作区目录');
    if (!dialog) return false;
    const input = Array.from(dialog.querySelectorAll('input, textarea')).find(rlhShown)
      || rlhFind('edit path|编辑路径', dialog);
    if (!input) return false;
    input.focus();
    return rlhSetValue(input, args.path);
  `, { path: workspacePath });
  if (!filled) {
    rec('workspace.connected', false, 'path editor missing');
    return false;
  }
  await pressEnter(wc);
  const openReady = await waitUntil(() => pageScript(wc, `
    const dialog = rlhDialogNamed('select workspace directory|选择工作区目录');
    if (!dialog) return null;
    const btn = Array.from(dialog.querySelectorAll('button')).find((el) =>
      rlhShown(el) && /^(open|打开)$/i.test(rlhLabel(el)) && !el.disabled);
    return btn || null;
  `), 12_000);
  if (openReady) {
    await pageScript(wc, `
      const dialog = rlhDialogNamed('select workspace directory|选择工作区目录');
      const btn = dialog && Array.from(dialog.querySelectorAll('button')).find((el) =>
        rlhShown(el) && /^(open|打开)$/i.test(rlhLabel(el)) && !el.disabled);
      if (!btn) return false;
      btn.click();
      return true;
    `);
  } else {
    // Fallback: confirm with Enter when Open stays disabled longer than expected.
    await pressEnter(wc);
  }
  let pickerClosed = await waitUntil(() => pageEval(wc, () =>
    !rlhDialogNamed('select workspace directory|选择工作区目录')), 12_000);
  if (!pickerClosed) {
    await pressEnter(wc);
    pickerClosed = await waitUntil(() => pageEval(wc, () =>
      !rlhDialogNamed('select workspace directory|选择工作区目录')), 8_000);
  }
  const connected = await waitUntil(() => pageEval(wc, () => {
    const ta = document.querySelector('[data-composer-card] textarea');
    return Boolean(ta && !ta.disabled);
  }), 15_000);
  if (connected && !pickerClosed) {
    // Workspace already unlocked; dismiss a stuck directory dialog so chrome is usable.
    await pageEval(wc, () => {
      const dialog = rlhDialogNamed('select workspace directory|选择工作区目录');
      if (!dialog) return false;
      const close = Array.from(dialog.querySelectorAll('button')).find((el) =>
        rlhShown(el) && /^(open|打开|cancel|取消|close|关闭)$/i.test(rlhLabel(el)));
      if (close) {
        close.click();
        return true;
      }
      return false;
    });
    if (typeof helpers.pressEscape === 'function') {
      for (let i = 0; i < 4; i += 1) {
        await helpers.pressEscape(wc);
        await sleep(100);
      }
    }
    pickerClosed = await waitUntil(() => pageEval(wc, () =>
      !rlhDialogNamed('select workspace directory|选择工作区目录')), 5_000);
  }
  rec('workspace.pickerClosed', Boolean(pickerClosed), pickerClosed ? '' : 'picker stayed open', true);
  rec(
    'workspace.connected',
    Boolean(connected),
    connected ? workspacePath : 'session still locked',
  );
  return Boolean(connected);
}

module.exports = {
  PAGE_HELPERS,
  sleep,
  waitUntil,
  pageEval,
  pageScript,
  clickNamed,
  pressEnter,
  makeRecorder,
  connectConfiguredWorkspace,
};
