/**
 * Copied from the external desktop `apps/web/src/keybindings.ts`:
 * `isTerminalClearShortcut`, `terminalDeleteShortcutData`,
 * `terminalNavigationShortcutData`, and `normalizeEventKey`.
 */
import { isMacPlatform } from './platform.ts'

/** The part of a `KeyboardEvent` shortcut matching reads. */
export interface ShortcutEventLike {
  /** Event type; anything but `keydown` matches nothing. */
  type?: string;
  /** The character or named key. */
  key: string;
  /** Whether Command (or Windows) is held. */
  metaKey: boolean;
  /** Whether Control is held. */
  ctrlKey: boolean;
  /** Whether Shift is held. */
  shiftKey: boolean;
  /** Whether Alt (or Option) is held. */
  altKey: boolean;
}

const TERMINAL_WORD_BACKWARD = "\u001bb";
const TERMINAL_WORD_FORWARD = "\u001bf";
const TERMINAL_LINE_START = "\u0001";
const TERMINAL_LINE_END = "\u0005";
const TERMINAL_DELETE_TO_LINE_START = "\u0015";

function normalizeEventKey(key: string): string {
  const normalized = key.toLowerCase();
  if (normalized === "esc") return "escape";
  return normalized;
}

/**
 * Whether a key event asks to clear the terminal — Control-L everywhere, and
 * Command-K on Apple platforms.
 * @param event - the key event.
 * @param platform - platform token, defaulting to the browser's.
 * @returns whether the terminal should clear.
 */
export function isTerminalClearShortcut(
  event: ShortcutEventLike,
  platform = navigator.platform,
): boolean {
  if (event.type !== undefined && event.type !== "keydown") {
    return false;
  }

  const key = event.key.toLowerCase();

  if (key === "l" && event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
    return true;
  }

  return (
    isMacPlatform(platform) &&
    key === "k" &&
    event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

/**
 * The bytes an Apple-platform delete shortcut sends: Command-Backspace deletes
 * to the start of the line. Other platforms leave the key to the shell.
 * @param event - the key event.
 * @param platform - platform token, defaulting to the browser's.
 * @returns the bytes to write to the pty, or null when no shortcut matched.
 */
export function terminalDeleteShortcutData(
  event: ShortcutEventLike,
  platform = navigator.platform,
): string | null {
  if (event.type !== undefined && event.type !== "keydown") {
    return null;
  }

  if (!isMacPlatform(platform)) {
    return null;
  }

  const key = normalizeEventKey(event.key);
  if (key !== "backspace") {
    return null;
  }

  return event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    ? TERMINAL_DELETE_TO_LINE_START
    : null;
}

/**
 * The bytes a caret-movement shortcut sends. Option-arrow moves by word and
 * Command-arrow moves to the line edge on Apple platforms; elsewhere both
 * Control-arrow and Alt-arrow move by word, matching the two conventions
 * Linux and Windows terminals split between.
 * @param event - the key event.
 * @param platform - platform token, defaulting to the browser's.
 * @returns the bytes to write to the pty, or null when no shortcut matched.
 */
export function terminalNavigationShortcutData(
  event: ShortcutEventLike,
  platform = navigator.platform,
): string | null {
  if (event.type !== undefined && event.type !== "keydown") {
    return null;
  }

  if (event.shiftKey) return null;

  const key = normalizeEventKey(event.key);
  if (key !== "arrowleft" && key !== "arrowright") {
    return null;
  }

  const moveWord = key === "arrowleft" ? TERMINAL_WORD_BACKWARD : TERMINAL_WORD_FORWARD;
  const moveLine = key === "arrowleft" ? TERMINAL_LINE_START : TERMINAL_LINE_END;

  if (isMacPlatform(platform)) {
    if (event.altKey && !event.metaKey && !event.ctrlKey) {
      return moveWord;
    }
    if (event.metaKey && !event.altKey && !event.ctrlKey) {
      return moveLine;
    }
    return null;
  }

  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    return moveWord;
  }

  if (event.altKey && !event.metaKey && !event.ctrlKey) {
    return moveWord;
  }

  return null;
}
