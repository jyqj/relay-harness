// @ts-check
'use strict';

const START_PICK_CHANNEL = 'rlhd-preview-start-pick';
const CANCEL_PICK_CHANNEL = 'rlhd-preview-cancel-pick';
const ELEMENT_PICKED_CHANNEL = 'rlhd-preview-element-picked';
const ANNOTATION_CAPTURED_CHANNEL = 'rlhd-preview-annotation-captured';
const ANNOTATION_THEME_CHANNEL = 'rlhd-preview-annotation-theme';
const HUMAN_INPUT_CHANNEL = 'rlhd-preview-human-input';
const PREVIEW_GUEST_INTERFACE_KEY = 'rlhdPreviewGuest';

/**
 * The only main-world capability exposed to an untrusted preview document.
 * Incoming annotation controls remain preload-private; the document can report
 * a completed annotation or trusted user input but cannot choose an IPC channel.
 * @param {{ send: (channel: string, ...args: unknown[]) => void }} renderer
 * @returns {{
 *   annotation: Readonly<{
 *     submit: (payload: unknown, crop: unknown, submission: unknown) => void,
 *     cancel: () => void,
 *   }>,
 *   humanInput: Readonly<{ report: (payload: unknown) => void }>,
 * }}
 */
function createPreviewGuestInterface(renderer) {
  const annotation = Object.freeze({
    submit(payload, crop, submission) {
      renderer.send(ELEMENT_PICKED_CHANNEL, payload, crop, submission);
    },
    cancel() {
      renderer.send(ELEMENT_PICKED_CHANNEL, null);
    },
  });
  const humanInput = Object.freeze({
    report(payload) {
      renderer.send(HUMAN_INPUT_CHANNEL, payload);
    },
  });
  return Object.freeze({ annotation, humanInput });
}

module.exports = {
  START_PICK_CHANNEL,
  CANCEL_PICK_CHANNEL,
  ELEMENT_PICKED_CHANNEL,
  ANNOTATION_CAPTURED_CHANNEL,
  ANNOTATION_THEME_CHANNEL,
  PREVIEW_GUEST_INTERFACE_KEY,
  createPreviewGuestInterface,
};
