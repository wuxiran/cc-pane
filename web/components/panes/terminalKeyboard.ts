type TerminalKeyboardEvent = Pick<
  KeyboardEvent,
  "type" | "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"
>;

export function isTerminalPasteShortcut(
  event: TerminalKeyboardEvent,
  isMac: boolean,
): boolean {
  if (event.type !== "keydown") return false;
  if (event.altKey) return false;
  if (event.key !== "v" && event.key !== "V") return false;

  if (isMac) {
    return event.metaKey && !event.ctrlKey;
  }

  return event.ctrlKey && !event.metaKey;
}

/**
 * Copy chords the terminal may claim (only when a selection exists — otherwise
 * Ctrl+C must stay SIGINT). Cmd+C on macOS; on Linux/Windows both Ctrl+C and the
 * conventional terminal Ctrl+Shift+C.
 */
export function isTerminalCopyShortcut(
  event: TerminalKeyboardEvent,
  isMac: boolean,
): boolean {
  if (event.type !== "keydown") return false;
  if (event.altKey) return false;
  if (event.key !== "c" && event.key !== "C") return false;

  if (isMac) {
    return event.metaKey && !event.ctrlKey && !event.shiftKey;
  }

  return event.ctrlKey && !event.metaKey;
}
