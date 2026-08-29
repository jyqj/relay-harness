// Relay Harness mark: an origin node handing a signal forward through two
// chevrons. Stroke geometry on a 40.6x28.2 grid, trimmed to the ink so the
// artwork needs no optical padding at any size. Color rides currentColor
// (wordmark ink).

import type { IconProps } from './icons/props.ts'

/** Path geometry shared with the wordmark, which nests the mark at its own scale. */
export const RELAY_MARK_VIEWBOX = '0 0 40.6 28.2'
/** Width-to-height ratio of {@link RELAY_MARK_VIEWBOX}. */
export const RELAY_MARK_RATIO = 40.6 / 28.2

/**
 * Draw the mark's three shapes into the caller's coordinate system.
 * @returns node and chevron elements sized for {@link RELAY_MARK_VIEWBOX}.
 */
export function relayMarkShapes() {
  return (
    <>
      <circle cx="5.5" cy="14.1" r="5.5" fill="currentColor" />
      <path
        d="M16.5 2.1 26.5 14.1 16.5 26.1"
        stroke="currentColor"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M28.5 2.1 38.5 14.1 28.5 26.1"
        stroke="currentColor"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  )
}

/**
 * Render the standalone mark.
 * @param props.size - width in px (default 24; height keeps the 40.6:28.2 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the mark svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function RelayMark({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size / RELAY_MARK_RATIO}
      className={className}
      viewBox={RELAY_MARK_VIEWBOX}
      fill="none"
      aria-hidden="true"
    >
      {relayMarkShapes()}
    </svg>
  )
}
