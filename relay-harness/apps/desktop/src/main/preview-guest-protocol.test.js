'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const protocol = require('./preview-guest-protocol.js');

const CHANNELS = [
  'rlhd-preview-start-pick',
  'rlhd-preview-cancel-pick',
  'rlhd-preview-element-picked',
  'rlhd-preview-annotation-captured',
  'rlhd-preview-annotation-theme',
  'rlhd-preview-human-input',
];

test('guest protocol exports its five host-owned channels and no leftover brand names', () => {
  const values = [
    protocol.START_PICK_CHANNEL,
    protocol.CANCEL_PICK_CHANNEL,
    protocol.ELEMENT_PICKED_CHANNEL,
    protocol.ANNOTATION_CAPTURED_CHANNEL,
    protocol.ANNOTATION_THEME_CHANNEL,
  ];
  assert.deepEqual(values, CHANNELS.slice(0, 5));
  for (const name of values) {
    assert.equal(name.includes(['t', '3'].join('')), false, name);
    assert.match(name, /^rlhd-preview-/);
  }
});

test('guest interface exposes only bounded annotation and human-input operations', () => {
  const sent = [];
  const renderer = {
    send(channel, ...args) {
      sent.push([channel, ...args]);
    },
  };
  const guest = protocol.createPreviewGuestInterface(renderer);
  assert.equal(protocol.PREVIEW_GUEST_INTERFACE_KEY, 'rlhdPreviewGuest');
  assert.deepEqual(Object.keys(guest), ['annotation', 'humanInput']);
  assert.deepEqual(Object.keys(guest.annotation), ['submit', 'cancel']);
  assert.deepEqual(Object.keys(guest.humanInput), ['report']);
  assert.equal(Object.isFrozen(guest), true);
  assert.equal(Object.isFrozen(guest.annotation), true);
  assert.equal(Object.isFrozen(guest.humanInput), true);
  assert.equal(guest.ipcRenderer, undefined);

  const annotation = { id: 'annotation_1' };
  const crop = { x: 1, y: 2, width: 3, height: 4 };
  guest.annotation.submit(annotation, crop, 'attach');
  guest.annotation.cancel();
  guest.humanInput.report({ kind: 'key', key: 'Enter', code: 'Enter' });
  assert.deepEqual(sent, [
    [protocol.ELEMENT_PICKED_CHANNEL, annotation, crop, 'attach'],
    [protocol.ELEMENT_PICKED_CHANNEL, null],
    ['rlhd-preview-human-input', { kind: 'key', key: 'Enter', code: 'Enter' }],
  ]);
});
