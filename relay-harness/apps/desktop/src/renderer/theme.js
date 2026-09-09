// @ts-check
function applyDarkAttribute(dark) {
  document.documentElement.toggleAttribute('data-rl-dark-theme', dark);
  document.body?.toggleAttribute('data-rl-dark-theme', dark);
}

function isBootTheme() {
  return document.documentElement.hasAttribute('data-boot-theme');
}

function applyTheme(theme) {
  if (!theme) {
    return;
  }
  const dark = theme.scheme === 'dark';
  applyDarkAttribute(dark);
  const root = document.documentElement;
  root.style.colorScheme = theme.scheme || 'dark';
  if (isBootTheme()) {
    document.body?.style.removeProperty('background');
    return;
  }
  if (theme.bg) {
    root.style.setProperty('--rlw-alias-bg-base', theme.bg);
  }
  if (theme.fg) {
    root.style.setProperty('--rlw-alias-label-primary', theme.fg);
  }
  if (theme.muted) {
    root.style.setProperty('--rlw-alias-label-tertiary', theme.muted);
    root.style.setProperty('--rlw-alias-label-secondary', theme.muted);
  }
  if (theme.accent) {
    root.style.setProperty('--rlw-alias-state-business-primary', theme.accent);
    root.style.setProperty('--rlw-alias-button-info-fill', theme.accent);
  }
  if (theme.line) {
    root.style.setProperty('--rlw-alias-border-l2', theme.line);
  }
  document.body?.style.setProperty('background', theme.bg || '');
}

function watchTheme() {
  const api = window.shell;
  if (api && typeof api.onTheme === 'function') {
    api.onTheme(applyTheme);
  }
  if (api && typeof api.getConfig === 'function') {
    Promise.resolve(api.getConfig())
      .then((config) => applyTheme(config.themeTokens))
      .catch(() => {});
  }
}

window.applyShellTheme = applyTheme;
window.watchShellTheme = watchTheme;
