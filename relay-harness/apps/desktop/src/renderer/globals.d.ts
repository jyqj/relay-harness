/** Capabilities exposed by the role-restricted preload; each page receives only its role's subset. */
interface Window {
  shell?: Partial<import('../preload/index.js').ShellApi>;
  applyShellTheme?: (theme: { scheme?: string; bg?: string; fg?: string; muted?: string; accent?: string; line?: string }) => void;
  watchShellTheme?: () => void;
  __rlhShellMaximized?: boolean;
  __rlhShellChromeBound?: boolean;
}

/** Helpers supplied by workspace-connect's PAGE_HELPERS before serialized page callbacks execute. */
declare function rlhShown(element: Element | null): boolean;
declare function rlhLabel(element: Element): string;
declare function rlhDialogNamed(pattern: string): HTMLElement | null;
