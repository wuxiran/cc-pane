// 终端字体规范化：xterm.js 按主字体测量固定格宽，若字体链缺少中文等宽
// fallback，CJK 字形会由浏览器随机 fallback 到非等宽字体，宽度与格宽不匹配
// 导致中文重叠碎裂。这里对不含 CJK 字体的链自动补 fallback，存量配置免迁移。

export const DEFAULT_TERMINAL_FONT_FAMILY =
  '"Maple Mono NF CN", "Maple Mono", "Cascadia Code", "Cascadia Mono", "JetBrains Mono", Consolas, "Sarasa Mono SC", "Microsoft YaHei UI", "PingFang SC", monospace';

// 追加到用户字体链末尾的 CJK fallback（generic monospace 之前）。
const CJK_FALLBACK_FONTS =
  '"Maple Mono NF CN", "Sarasa Mono SC", "Microsoft YaHei UI", "PingFang SC", "Noto Sans SC"';

// 小写子串匹配：命中任一即认为字体链已具备 CJK 渲染能力。
const CJK_CAPABLE_HINTS = [
  "maple mono nf cn",
  "sarasa",
  "yahei",
  "pingfang",
  "noto sans sc",
  "noto sans cjk",
  "noto serif sc",
  "noto serif cjk",
  "source han",
  "simhei",
  "simsun",
  "nsimsun",
  "dengxian",
  "fangsong",
  "kaiti",
  "harmonyos",
  "wenquanyi",
  "heiti",
  "songti",
  "mono cn",
  "mono sc",
  "mono tc",
  "sc mono",
  "lxgw",
  "微软雅黑",
  "苹方",
  "黑体",
  "宋体",
  "等线",
];

// 打包的 CJK 等宽 webfont（web/assets/index.css 的 @font-face），默认字体链首项。
const BUNDLED_CJK_WEBFONT = "maple mono nf cn";

// macOS 原生等宽字体走系统字体渲染路径，比打包 webfont 锐利；webfont 仍留在
// 链中继续兜 CJK 字形，中英混排的格宽对齐不受影响。
const MACOS_PREFERRED_MONO_FONTS = '"SF Mono", Menlo';

function stripFontQuotes(family: string): string {
  return family.replace(/["']/g, "").trim().toLowerCase();
}

function detectPlatform(): string | undefined {
  if (typeof document === "undefined") return undefined;
  return document.documentElement.dataset.platform;
}

/// macOS 上把系统等宽字体提到打包 webfont 之前。仅在字体链首项仍是打包 webfont
/// 时生效——那代表用户没主动挑字体；用户显式选定的首项一律保持不动。
export function preferPlatformMonoFonts(
  fontFamily: string,
  platform: string | undefined = detectPlatform(),
): string {
  if (platform !== "macos") return fontFamily;

  const families = fontFamily.split(",").map((f) => f.trim()).filter(Boolean);
  if (families.length === 0) return fontFamily;
  if (stripFontQuotes(families[0]) !== BUNDLED_CJK_WEBFONT) return fontFamily;

  return [MACOS_PREFERRED_MONO_FONTS, ...families].join(", ");
}

export function fontFamilyHasCjkFallback(fontFamily: string): boolean {
  const lower = fontFamily.toLowerCase();
  return CJK_CAPABLE_HINTS.some((hint) => lower.includes(hint));
}

export function normalizeTerminalFontFamily(value?: string | null): string {
  const trimmed = value?.trim();
  if (!trimmed) return preferPlatformMonoFonts(DEFAULT_TERMINAL_FONT_FAMILY);
  if (fontFamilyHasCjkFallback(trimmed)) return preferPlatformMonoFonts(trimmed);

  // 在末尾的 generic monospace 之前插入 CJK fallback，保持 generic 兜底在最后。
  const families = trimmed.split(",").map((f) => f.trim()).filter(Boolean);
  const genericIndex = families.findIndex((f) => /^monospace$/i.test(f));
  if (genericIndex >= 0) {
    families.splice(genericIndex, 0, CJK_FALLBACK_FONTS);
  } else {
    families.push(CJK_FALLBACK_FONTS, "monospace");
  }
  return families.join(", ");
}
