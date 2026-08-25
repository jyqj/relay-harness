'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  isUsableRect,
  normalizeRect,
  pathFromPoints,
  rectFromDomRect,
  strokeBounds,
  unionRects,
} = require('./preview-guest-geometry.js');

const VIEWPORT = { width: 1000, height: 800 };

test('rectFromDomRect restates a DOMRect in overlay coordinates', () => {
  assert.deepEqual(
    rectFromDomRect({ left: 10, top: 20, width: 30, height: 40, right: 40, bottom: 60 }),
    { x: 10, y: 20, width: 30, height: 40 },
  );
});

test('normalizeRect covers a drag made in any direction', () => {
  const downRight = normalizeRect(10, 10, 40, 50);
  const upLeft = normalizeRect(40, 50, 10, 10);
  assert.deepEqual(downRight, { x: 10, y: 10, width: 30, height: 40 });
  assert.deepEqual(downRight, upLeft);
});

test('isUsableRect rejects the near-zero rectangle a click leaves behind', () => {
  assert.equal(isUsableRect({ x: 0, y: 0, width: 2, height: 40 }), false);
  assert.equal(isUsableRect({ x: 0, y: 0, width: 40, height: 2 }), false);
  assert.equal(isUsableRect({ x: 0, y: 0, width: 3, height: 3 }), true);
});

test('unionRects returns null when nothing is annotated', () => {
  assert.equal(unionRects([], VIEWPORT), null);
});

test('unionRects pads the union of every annotation', () => {
  const union = unionRects([
    { x: 100, y: 100, width: 50, height: 50 },
    { x: 200, y: 300, width: 10, height: 10 },
  ], VIEWPORT, 20);
  assert.deepEqual(union, { x: 80, y: 80, width: 150, height: 250 });
});

test('unionRects clamps the padded union to the viewport', () => {
  const union = unionRects([{ x: 10, y: 10, width: 990, height: 790 }], VIEWPORT, 20);
  assert.equal(union.x, 0);
  assert.equal(union.y, 0);
  assert.equal(union.width, VIEWPORT.width);
  assert.equal(union.height, VIEWPORT.height);
});

test('pathFromPoints draws a visible dot for a single sample', () => {
  assert.equal(pathFromPoints([]), '');
  assert.equal(pathFromPoints([{ x: 5, y: 6 }]), 'M 5 6 l 0.01 0.01');
});

test('pathFromPoints smooths a stroke through segment midpoints', () => {
  const path = pathFromPoints([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }]);
  assert.equal(path, 'M 0 0 Q 10 0 15 5 L 20 10');
});

test('strokeBounds grows the box by the stroke width', () => {
  assert.deepEqual(
    strokeBounds([{ x: 10, y: 10 }, { x: 30, y: 40 }], 2),
    { x: 5, y: 5, width: 30, height: 40 },
  );
});
