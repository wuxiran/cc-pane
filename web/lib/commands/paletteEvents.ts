// 搜索面板（命令面板）的开关事件。单独成文件：侧栏等入口只要派发事件，
// 不必为此把整个 CommandPalette 模块拉进依赖图。
export const COMMAND_PALETTE_TOGGLE_EVENT = "cc-panes:command-palette-toggle";

export function toggleCommandPalette(): void {
  window.dispatchEvent(new Event(COMMAND_PALETTE_TOGGLE_EVENT));
}
