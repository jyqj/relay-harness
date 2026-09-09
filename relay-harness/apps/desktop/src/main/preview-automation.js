// @ts-check
'use strict';

/**
 * Browser-preview automation: the drive-the-page half of the preview
 * controller, which an agent reaches over IPC. Every call resolves to a
 * `{ ok }` result rather than throwing, because the caller is a tool invocation
 * that has to report a failure rather than crash the shell.
 */

/** Outer HTML cap for automationSnapshot (reference visibleText is 20_000). */
const AUTOMATION_SNAPSHOT_HTML_MAX_CHARS = 100_000;
/** WaitFor poll interval copied from the reference `Effect.sleep(100)`. */
const AUTOMATION_WAIT_POLL_MS = 100;
const AUTOMATION_WAIT_DEFAULT_TIMEOUT_MS = 15_000;

/**
 * The automation half of a preview controller.
 *
 * @param {object} host The controller's session table and shared results.
 * @param {Map<string, any>} host.sessions Live preview sessions, keyed by id.
 * @param {() => { ok: false, message: string }} host.unknownPreviewId Result for an id with no session.
 * @param {(error: unknown) => { ok: false, message: string }} host.failClosed Result for a thrown error.
 * @param {(contents: any) => any} host.ensureDebugger Attaches and returns the guest's CDP debugger.
 */
function createPreviewAutomation(host) {
  const { sessions, unknownPreviewId, failClosed, ensureDebugger } = host;

  /** The guest's CDP debugger, or a result explaining why there is none. */
  function requireDebugger(session) {
    const wc = session.view.webContents;
    const dbg = ensureDebugger(wc);
    if (!dbg || typeof dbg.sendCommand !== 'function') {
      return { wc, dbg: null, unavailable: { ok: false, message: 'debugger unavailable' } };
    }
    return { wc, dbg, unavailable: null };
  }

  return {
    async automationStatus(id) {
      const session = sessions.get(id);
      if (!session) return unknownPreviewId();
      const wc = session.view.webContents;
      const destroyed = typeof wc.isDestroyed === 'function' && wc.isDestroyed();
      return {
        ok: true,
        available: !destroyed,
        url: typeof wc.getURL === 'function' ? wc.getURL() : session.url,
        title: typeof wc.getTitle === 'function' ? wc.getTitle() : session.title,
        loading: typeof wc.isLoading === 'function' ? wc.isLoading() : session.loading === true,
      };
    },

    async automationSnapshot(id) {
      const session = sessions.get(id);
      if (!session) return unknownPreviewId();
      try {
        const wc = session.view.webContents;
        const page = typeof wc.executeJavaScript === 'function'
          ? await wc.executeJavaScript(`({
              title: document.title,
              url: location.href,
              html: ((document.documentElement && document.documentElement.outerHTML) || "").slice(0, ${AUTOMATION_SNAPSHOT_HTML_MAX_CHARS})
            })`)
          : { title: session.title, url: session.url, html: '' };
        let screenshot = null;
        if (typeof wc.capturePage === 'function') {
          const image = await Promise.resolve(wc.capturePage());
          const size = image && typeof image.getSize === 'function' ? image.getSize() : { width: 0, height: 0 };
          if (image && typeof image.toPNG === 'function') {
            const png = image.toPNG();
            screenshot = {
              mimeType: 'image/png',
              data: Buffer.isBuffer(png) ? png.toString('base64') : Buffer.from(png).toString('base64'),
              width: size.width,
              height: size.height,
            };
          }
        }
        return {
          ok: true,
          title: page && page.title,
          url: page && page.url,
          html: page && page.html,
          screenshot,
        };
      } catch (error) {
        return failClosed(error);
      }
    },

    async automationClick(id, input = {}) {
      const session = sessions.get(id);
      if (!session) return unknownPreviewId();
      try {
        const { wc, dbg, unavailable } = requireDebugger(session);
        if (unavailable) return unavailable;
        let x = input.x;
        let y = input.y;
        if (typeof input.selector === 'string' && input.selector.length > 0) {
          if (typeof wc.executeJavaScript !== 'function') {
            return { ok: false, message: 'element not found' };
          }
          const point = await wc.executeJavaScript(`(() => {
            const el = document.querySelector(${JSON.stringify(input.selector)});
            if (!el) return null;
            el.scrollIntoView({ block: "center", inline: "center" });
            const r = el.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          })()`);
          if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') {
            return { ok: false, message: 'element not found' };
          }
          x = point.x;
          y = point.y;
        }
        if (typeof x !== 'number' || typeof y !== 'number') {
          return { ok: false, message: 'missing click point' };
        }
        const mouse = { x, y, button: 'left', clickCount: 1 };
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', ...mouse });
        await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', ...mouse });
        return { ok: true };
      } catch (error) {
        return failClosed(error);
      }
    },

    async automationType(id, input = {}) {
      const session = sessions.get(id);
      if (!session) return unknownPreviewId();
      try {
        const { wc, dbg, unavailable } = requireDebugger(session);
        if (unavailable) return unavailable;
        if (typeof input.selector === 'string' && input.selector.length > 0
          && typeof wc.executeJavaScript === 'function') {
          await wc.executeJavaScript(
            `document.querySelector(${JSON.stringify(input.selector)})?.focus()`,
          );
        }
        const text = typeof input.text === 'string' ? input.text : '';
        await dbg.sendCommand('Input.insertText', { text });
        return { ok: true };
      } catch (error) {
        return failClosed(error);
      }
    },

    async automationPress(id, input = {}) {
      const session = sessions.get(id);
      if (!session) return unknownPreviewId();
      try {
        const { dbg, unavailable } = requireDebugger(session);
        if (unavailable) return unavailable;
        const key = typeof input.key === 'string' ? input.key : '';
        await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key });
        await dbg.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key });
        return { ok: true };
      } catch (error) {
        return failClosed(error);
      }
    },

    async automationScroll(id, input = {}) {
      const session = sessions.get(id);
      if (!session) return unknownPreviewId();
      try {
        const { dbg, unavailable } = requireDebugger(session);
        if (unavailable) return unavailable;
        await dbg.sendCommand('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: input.x ?? 0,
          y: input.y ?? 0,
          deltaX: input.deltaX ?? 0,
          deltaY: input.deltaY ?? 0,
        });
        return { ok: true };
      } catch (error) {
        return failClosed(error);
      }
    },

    async automationEvaluate(id, input = {}) {
      const session = sessions.get(id);
      if (!session) return unknownPreviewId();
      try {
        const wc = session.view.webContents;
        if (typeof wc.executeJavaScript !== 'function') {
          return { ok: false, message: 'evaluate unavailable' };
        }
        const value = await wc.executeJavaScript(input.expression);
        return { ok: true, value };
      } catch (error) {
        return failClosed(error);
      }
    },

    async automationWaitFor(id, input = {}) {
      const session = sessions.get(id);
      if (!session) return unknownPreviewId();
      const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : AUTOMATION_WAIT_DEFAULT_TIMEOUT_MS;
      const deadline = Date.now() + timeoutMs;
      const wc = session.view.webContents;
      try {
        for (;;) {
          const url = typeof wc.getURL === 'function' ? String(wc.getURL() ?? '') : '';
          const urlMatched = !input.urlIncludes || url.includes(String(input.urlIncludes));
          let selectorMatched = true;
          let textMatched = true;
          if ((input.selector || input.text) && typeof wc.executeJavaScript === 'function') {
            const probe = await wc.executeJavaScript(`(() => {
              const selectorMatched = ${input.selector ? `document.querySelector(${JSON.stringify(input.selector)}) !== null` : 'true'};
              const textMatched = ${input.text ? `(document.body && document.body.innerText || "").includes(${JSON.stringify(input.text)})` : 'true'};
              return { selectorMatched, textMatched };
            })()`);
            selectorMatched = Boolean(probe && probe.selectorMatched);
            textMatched = Boolean(probe && probe.textMatched);
          }
          if (urlMatched && selectorMatched && textMatched) return { ok: true };
          const remaining = deadline - Date.now();
          if (remaining <= 0) return { ok: false, message: 'timeout' };
          await new Promise((resolve) => {
            setTimeout(resolve, Math.min(AUTOMATION_WAIT_POLL_MS, remaining));
          });
        }
      } catch (error) {
        return failClosed(error);
      }
    },
  };
}

module.exports = {
  createPreviewAutomation,
};
