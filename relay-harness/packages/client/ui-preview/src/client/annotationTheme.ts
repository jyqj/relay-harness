/** Read guest annotation theme fields from host `--rlw-alias-*` tokens. */

/** Theme object field names match the reference peel; CSS vars are `--rlhd-preview-*`. */
export interface PreviewAnnotationTheme {
  colorScheme: 'light' | 'dark'
  radius: string
  background: string
  foreground: string
  popover: string
  popoverForeground: string
  primary: string
  primaryForeground: string
  muted: string
  mutedForeground: string
  accent: string
  accentForeground: string
  border: string
  input: string
  ring: string
  fontSans: string
  fontMono: string
}

const DEFAULT_THEME: PreviewAnnotationTheme = {
  colorScheme: 'light',
  radius: '8px',
  background: 'rgb(255, 255, 255)',
  foreground: 'rgb(15, 17, 21)',
  popover: 'rgb(255, 255, 255)',
  popoverForeground: 'rgb(15, 17, 21)',
  primary: 'rgb(15, 17, 21)',
  primaryForeground: 'rgb(255, 255, 255)',
  muted: 'rgba(38, 49, 72, 0.06)',
  mutedForeground: 'rgb(97, 102, 107)',
  accent: 'rgba(38, 49, 72, 0.06)',
  accentForeground: 'rgb(15, 17, 21)',
  border: 'rgba(0, 0, 0, 0.1)',
  input: 'rgba(0, 0, 0, 0.1)',
  ring: 'rgb(65, 118, 230)',
  fontSans: 'system-ui, sans-serif',
  fontMono: 'ui-monospace, monospace',
}

function readVariable(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  return styles.getPropertyValue(name).trim() || fallback
}

/**
 * Collect live `--rlw-alias-*` values from the document element.
 * Empty computed values fall back to {@link DEFAULT_THEME}.
 * @returns theme fields for `previewSetAnnotationTheme`.
 */
export function readPreviewAnnotationTheme(): PreviewAnnotationTheme {
  const root = document.documentElement
  const styles = getComputedStyle(root)
  const dark = root.hasAttribute('data-ds-dark-theme')
    || styles.colorScheme.includes('dark')
  return {
    colorScheme: dark ? 'dark' : 'light',
    radius: readVariable(styles, '--rlw-alias-radius', DEFAULT_THEME.radius),
    background: readVariable(styles, '--rlw-alias-bg-layer-1', DEFAULT_THEME.background),
    foreground: readVariable(styles, '--rlw-alias-label-primary', DEFAULT_THEME.foreground),
    popover: readVariable(styles, '--rlw-alias-bg-layer-1', DEFAULT_THEME.popover),
    popoverForeground: readVariable(styles, '--rlw-alias-label-primary', DEFAULT_THEME.popoverForeground),
    primary: readVariable(styles, '--rlw-alias-button-primary-fill', DEFAULT_THEME.primary),
    primaryForeground: readVariable(
      styles,
      '--rlw-alias-button-primary-label',
      readVariable(styles, '--rlw-alias-label-primary-foreground', DEFAULT_THEME.primaryForeground),
    ),
    muted: readVariable(styles, '--rlw-alias-interactive-bg-hover', DEFAULT_THEME.muted),
    mutedForeground: readVariable(styles, '--rlw-alias-label-secondary', DEFAULT_THEME.mutedForeground),
    accent: readVariable(styles, '--rlw-alias-interactive-bg-hover', DEFAULT_THEME.accent),
    accentForeground: readVariable(styles, '--rlw-alias-label-primary', DEFAULT_THEME.accentForeground),
    border: readVariable(styles, '--rlw-alias-border-l2', DEFAULT_THEME.border),
    input: readVariable(styles, '--rlw-alias-border-l2', DEFAULT_THEME.input),
    ring: readVariable(styles, '--rlw-alias-state-business-primary', DEFAULT_THEME.ring),
    fontSans: readVariable(styles, '--rlw-font-family', styles.fontFamily || DEFAULT_THEME.fontSans),
    fontMono: readVariable(styles, '--rl-font-family-code', DEFAULT_THEME.fontMono),
  }
}
