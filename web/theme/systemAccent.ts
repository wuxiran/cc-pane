/** 系统强调色应用到文档根；与 themeOverrides 的 accent 同一组 token。 */
const ACCENT_TOKENS = [
  "--app-accent",
  "--primary",
  "--ring",
  "--sidebar-primary",
  "--sidebar-ring",
  "--app-tab-active-border",
] as const;
const FOREGROUND_TOKENS = ["--primary-foreground", "--sidebar-primary-foreground"] as const;

/** 按 WCAG 相对亮度选前景色，系统强调色可能很浅。 */
export function accentForeground(hex: string): string {
  const channels = [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  return luminance > 0.45 ? "#111827" : "#ffffff";
}

export function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

export function applySystemAccent(color: string): void {
  const { style } = document.documentElement;
  for (const token of ACCENT_TOKENS) style.setProperty(token, color);
  for (const token of FOREGROUND_TOKENS) style.setProperty(token, accentForeground(color));
  style.setProperty("--app-active-bg", `color-mix(in srgb, ${color} 12%, transparent)`);
}

export function clearSystemAccent(): void {
  const { style } = document.documentElement;
  for (const token of [...ACCENT_TOKENS, ...FOREGROUND_TOKENS, "--app-active-bg"]) {
    style.removeProperty(token);
  }
}
