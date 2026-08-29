// @ts-check
'use strict';

/**
 * Rectangle and stroke arithmetic for the guest annotation overlay. Nothing here
 * touches the DOM: the preload reads the live geometry and hands it over, which
 * keeps the arithmetic testable outside a browser.
 */

/** Padding the screenshot rectangle leaves around the annotated content. */
const ANNOTATION_BOUNDS_PADDING = 20;
/** Below this, a marquee is a stray click rather than a region. */
const MIN_USABLE_RECT_SIZE = 3;

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} OverlayRect
 * @typedef {{ x: number, y: number }} OverlayPoint
 * @typedef {{ width: number, height: number }} OverlayViewport
 */

/**
 * Restate a `DOMRect` as the overlay's own rectangle shape.
 *
 * @param {{ left: number, top: number, width: number, height: number }} rect A measured element.
 * @returns {OverlayRect} The same rectangle in overlay coordinates.
 */
function rectFromDomRect(rect) {
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

/**
 * The rectangle a drag from one point to another covers, in any direction.
 *
 * @param {number} startX Where the drag began.
 * @param {number} startY Where the drag began.
 * @param {number} endX Where the pointer is now.
 * @param {number} endY Where the pointer is now.
 * @returns {OverlayRect} A rectangle with non-negative width and height.
 */
function normalizeRect(startX, startY, endX, endY) {
  return {
    x: Math.min(startX, endX),
    y: Math.min(startY, endY),
    width: Math.abs(endX - startX),
    height: Math.abs(endY - startY),
  };
}

/**
 * Whether a dragged rectangle is large enough to mean something.
 *
 * @param {OverlayRect} rect The rectangle the drag produced.
 * @returns {boolean} False for the near-zero rectangle a click leaves behind.
 */
function isUsableRect(rect) {
  return rect.width >= MIN_USABLE_RECT_SIZE && rect.height >= MIN_USABLE_RECT_SIZE;
}

/**
 * The padded rectangle covering every annotation, clipped to the viewport so the
 * screenshot request never asks for pixels the page does not have.
 *
 * @param {readonly OverlayRect[]} rects Every annotated rectangle.
 * @param {OverlayViewport} viewport The guest's visible size.
 * @param {number} [padding] Breathing room around the union.
 * @returns {OverlayRect | null} The union, or null when nothing is annotated.
 */
function unionRects(rects, viewport, padding = ANNOTATION_BOUNDS_PADDING) {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  const x = Math.max(0, left - padding);
  const y = Math.max(0, top - padding);
  const maxWidth = Math.max(1, viewport.width - x);
  const maxHeight = Math.max(1, viewport.height - y);
  return {
    x,
    y,
    width: Math.min(maxWidth, right - left + padding * 2),
    height: Math.min(maxHeight, bottom - top + padding * 2),
  };
}

/**
 * An SVG path through a freehand stroke, smoothed by drawing each segment as a
 * quadratic curve through the midpoint of the next.
 *
 * @param {readonly OverlayPoint[]} points The pointer samples, in order.
 * @returns {string} A `d` attribute; a lone point becomes a visible dot.
 */
function pathFromPoints(points) {
  if (points.length === 0) return '';
  if (points.length === 1) return `M ${points[0].x} ${points[0].y} l 0.01 0.01`;
  let path = `M ${points[0].x} ${points[0].y}`;
  for (let index = 1; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    path += ` Q ${current.x} ${current.y} ${(current.x + next.x) / 2} ${(current.y + next.y) / 2}`;
  }
  const last = points[points.length - 1];
  path += ` L ${last.x} ${last.y}`;
  return path;
}

/**
 * The rectangle a stroke occupies once its own width is accounted for.
 *
 * @param {readonly OverlayPoint[]} points The pointer samples.
 * @param {number} width The stroke width in pixels.
 * @returns {OverlayRect} The stroke's bounding box.
 */
function strokeBounds(points, width) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const padding = width + 3;
  const left = Math.min(...xs) - padding;
  const top = Math.min(...ys) - padding;
  const right = Math.max(...xs) + padding;
  const bottom = Math.max(...ys) + padding;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

module.exports = {
  ANNOTATION_BOUNDS_PADDING,
  MIN_USABLE_RECT_SIZE,
  isUsableRect,
  normalizeRect,
  pathFromPoints,
  rectFromDomRect,
  strokeBounds,
  unionRects,
};
