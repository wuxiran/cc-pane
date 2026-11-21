export const TERMINAL_FIT_ALL_EVENT = "cc-panes:terminal-fit-all";

/** 「重建终端画面」快捷键/命令：detail.sessionId 指定哪个会话的主视图执行。 */
export const TERMINAL_REBUILD_DISPLAY_EVENT = "cc-panes:terminal-rebuild-display";

export function requestTerminalRebuildDisplay(sessionId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TERMINAL_REBUILD_DISPLAY_EVENT, { detail: { sessionId } }));
}

export function requestTerminalFitAll(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(TERMINAL_FIT_ALL_EVENT));
}
