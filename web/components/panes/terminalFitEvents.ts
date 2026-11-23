export const TERMINAL_FIT_ALL_EVENT = "cc-panes:terminal-fit-all";

/** 「重建终端画面」快捷键/命令：detail.sessionId 指定哪个会话的主视图执行。 */
export const TERMINAL_REBUILD_DISPLAY_EVENT = "cc-panes:terminal-rebuild-display";

export function requestTerminalRebuildDisplay(sessionId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TERMINAL_REBUILD_DISPLAY_EVENT, { detail: { sessionId } }));
}

/** 「修复显示」（轻量：重新排版 + 重绘 + 让 CLI 重画，不清 buffer、不弹确认）。状态栏按钮用。 */
export const TERMINAL_REPAIR_DISPLAY_EVENT = "cc-panes:terminal-repair-display";

export function requestTerminalRepairDisplay(sessionId: string): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(TERMINAL_REPAIR_DISPLAY_EVENT, { detail: { sessionId } }));
}

export function requestTerminalFitAll(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(TERMINAL_FIT_ALL_EVENT));
}
