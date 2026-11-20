// 原生窗口底色：WebView 还没重绘的区域露出的就是它，必须和当前主题一致。
export const WINDOW_BACKGROUND_DARK = "#181818";
export const WINDOW_BACKGROUND_LIGHT = "#F6F7F9";

/** 当前主题的 --background 是 6 位 hex 就用它，否则按明暗回落到默认底色。 */
export function resolveWindowBackgroundColor(token: string, isDark: boolean): string {
  const value = token.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
  return isDark ? WINDOW_BACKGROUND_DARK : WINDOW_BACKGROUND_LIGHT;
}
