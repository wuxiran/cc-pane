export const TERMINAL_FIT_ALL_EVENT = "cc-panes:terminal-fit-all";

export function requestTerminalFitAll(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(TERMINAL_FIT_ALL_EVENT));
}
