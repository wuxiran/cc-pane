/**
 * 终端回滚历史（scrollback）的钳制与默认值。
 *
 * 独立纯模块：设置面板（TerminalSection）与 store 都要用，放 store 里会让
 * 组件测试单独加载时踩进 useSettingsStore ↔ useWallpaperStore 的模块级订阅环。
 */

export const TERMINAL_SCROLLBACK_MIN = 200;
export const TERMINAL_SCROLLBACK_MAX = 100_000;
export const TERMINAL_SCROLLBACK_DEFAULT = 20_000;

export function normalizeTerminalScrollback(scrollback?: number | null): number {
  if (!Number.isFinite(scrollback)) return TERMINAL_SCROLLBACK_DEFAULT;
  return Math.min(
    TERMINAL_SCROLLBACK_MAX,
    Math.max(TERMINAL_SCROLLBACK_MIN, Math.round(scrollback as number)),
  );
}
