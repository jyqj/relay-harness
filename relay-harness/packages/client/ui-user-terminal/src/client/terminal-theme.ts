import type { GhosttyColor, GhosttyTheme } from './ghostty/core.ts'
import { DEFAULT_TERMINAL_FONT_FAMILY, DEFAULT_TERMINAL_FONT_SIZE } from './ghostty/surface.ts'

/** Copied from ThreadTerminalDrawer `parseTerminalColor`. */
function parseTerminalColor(value: string, fallback: GhosttyColor): GhosttyColor {
  if (typeof document === 'undefined') return fallback

  const canvas = document.createElement('canvas')
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) return fallback

  context.clearRect(0, 0, 1, 1)
  context.fillStyle = value
  context.fillRect(0, 0, 1, 1)
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
  if (alpha === 0) return fallback

  return {
    r: red ?? fallback.r,
    g: green ?? fallback.g,
    b: blue ?? fallback.b,
  }
}

/** Copied from ThreadTerminalDrawer `normalizeComputedColor`. */
function normalizeComputedColor(value: string | null | undefined, fallback: string): string {
  const normalizedValue = value?.trim().toLowerCase()
  if (
    !normalizedValue ||
    normalizedValue === 'transparent' ||
    normalizedValue === 'rgba(0, 0, 0, 0)' ||
    normalizedValue === 'rgba(0 0 0 / 0)'
  ) {
    return fallback
  }
  return value ?? fallback
}

/**
 * The surface treats an omitted family or size as "use the built-in default".
 * @param family - the configured family, possibly blank.
 * @param size - the configured point size.
 * @returns surface font options, with the family omitted when it is blank.
 */
export function terminalFontOptions(family: string, size: number): { family?: string; size: number } {
  const trimmed = family.trim()
  return trimmed.length > 0 ? { family: trimmed, size } : { size }
}

/**
 * Copied from `terminalThemeFromApp`. Dark also accepts this desktop's
 * `data-rl-dark-theme` because the web client does not set `html.dark`.
 * @param mountElement - the pane host, or body when omitted.
 * @returns a Ghostty theme.
 */
export function terminalThemeFromApp(mountElement?: HTMLElement | null): GhosttyTheme {
  const isDark =
    document.documentElement.classList.contains('dark') ||
    document.body.hasAttribute('data-rl-dark-theme')
  const fallbackBackground = isDark ? 'rgb(14, 18, 24)' : 'rgb(255, 255, 255)'
  const fallbackForeground = isDark ? 'rgb(237, 241, 247)' : 'rgb(28, 33, 41)'
  const drawerSurface =
    mountElement?.closest('.thread-terminal-drawer') ??
    document.querySelector('.thread-terminal-drawer') ??
    document.body
  const drawerStyles = getComputedStyle(drawerSurface)
  const bodyStyles = getComputedStyle(document.body)
  const background = normalizeComputedColor(
    drawerStyles.backgroundColor,
    normalizeComputedColor(bodyStyles.backgroundColor, fallbackBackground),
  )
  const foreground = normalizeComputedColor(
    drawerStyles.color,
    normalizeComputedColor(bodyStyles.color, fallbackForeground),
  )

  return {
    background: parseTerminalColor(
      background,
      isDark ? { r: 14, g: 18, b: 24 } : { r: 255, g: 255, b: 255 },
    ),
    foreground: parseTerminalColor(
      foreground,
      isDark ? { r: 237, g: 241, b: 247 } : { r: 28, g: 33, b: 41 },
    ),
    cursor: isDark ? { r: 180, g: 203, b: 255 } : { r: 38, g: 56, b: 78 },
    // Matches the xterm selection overlays this renderer replaced; the text
    // color underneath is left unchanged for contrast in both themes.
    selectionBackground: isDark ? 'rgba(180, 203, 255, 0.25)' : 'rgba(37, 63, 99, 0.2)',
  }
}

function isResolvedFontFamily(value: string): boolean {
  return value !== '' && !value.includes('var(')
}

function resolvedFontFamily(el: HTMLElement): string {
  const probe = el.ownerDocument.createElement('span')
  probe.style.fontFamily = 'var(--rlw-font-family-terminal, var(--rl-font-family-code))'
  el.appendChild(probe)
  const computed = getComputedStyle(probe).fontFamily.trim()
  probe.remove()
  if (isResolvedFontFamily(computed)) return computed
  const styles = getComputedStyle(el)
  const terminal = styles.getPropertyValue('--rlw-font-family-terminal').trim()
  if (isResolvedFontFamily(terminal)) return terminal
  const code = styles.getPropertyValue('--rl-font-family-code').trim()
  if (isResolvedFontFamily(code)) return code
  return DEFAULT_TERMINAL_FONT_FAMILY
}

function resolvedFontSize(el: HTMLElement): number {
  const raw = getComputedStyle(el).getPropertyValue('--rlw-font-size-code').trim()
  const parsed = Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TERMINAL_FONT_SIZE
}

/** The family used when no theme variable resolves to a usable one. */
export const FALLBACK_TERMINAL_FONT_FAMILY = DEFAULT_TERMINAL_FONT_FAMILY

/** The font a terminal pane resolves to from its theme variables. */
export type XtermFont = {
  /** CSS `font-family` value. */
  fontFamily: string
  /** Point size in pixels. */
  fontSize: number
}

/**
 * Resolve the terminal font from an element's cascade. The family is measured
 * through a probe span so a `var()` chain resolves to a real family list, and
 * anything still unresolved falls back to the built-in defaults.
 * @param el - the pane host to read the cascade from.
 * @returns the resolved family and size.
 */
export function readXtermFont(el: HTMLElement): XtermFont {
  return {
    fontFamily: resolvedFontFamily(el),
    fontSize: resolvedFontSize(el),
  }
}
