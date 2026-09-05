import {
  isThemeId,
  themeGroup,
  type ThemeGroup,
  type ThemeId,
} from "@/theme/themePresets";
import type { ThemeShape } from "@/theme/themeShapes";

/* ==========================================================================
 * 主题自定义微调（theme overrides）
 *
 * 数据模型：用户在当前预设主题上叠加少量安全 token 微调（accent 预设色 /
 * 圆角基准 / 面板明度偏移），持久化在 localStorage，运行时以 documentElement
 * inline style 覆盖（inline 优先级高于 .dark 与 :root[data-theme] 样式表块，
 * 因此暗色主题的同名 token 同样被覆盖；静态 CSS 与 designTokens 契约不变）。
 *
 * 数值来源约束：
 * - accent 存预设 id，真正色值查 ACCENT_PRESETS 映射（按主题明/暗分组取变体），
 *   不在 store / localStorage 里沉淀裸 hex。
 * - PANEL_BG_BASE / SHAPE_BASE_RADIUS 是 index.css 的 TS 镜像，与
 *   miniUiPreview.css → index.css 的契约链同源，漂移由 themeOverrides.test.ts
 *   的契约用例强制拦截。
 * ========================================================================== */

export const THEME_OVERRIDES_STORAGE_KEY = "theme-overrides";

/** 圆角滑杆范围（rem），与任务约束 0–1rem 一致。 */
export const RADIUS_OVERRIDE_MIN = 0;
export const RADIUS_OVERRIDE_MAX = 1;
/** 面板明度偏移范围（百分点），正 = 提亮，负 = 压暗。 */
export const PANEL_LIGHTNESS_MIN = -5;
export const PANEL_LIGHTNESS_MAX = 5;

export interface ThemeOverrides {
  /** 微调依附的预设主题；切到其他主题时覆盖不生效（保留以便切回恢复）。 */
  baseThemeId: ThemeId;
  /** accent 预设色板 id（见 ACCENT_PRESETS），缺省 = 跟随主题。 */
  accent?: string;
  /** 圆角基准 --radius，单位 rem。 */
  radius?: number;
  /** 面板明度偏移（百分点，-5 ~ +5）。 */
  panelLightnessDelta?: number;
}

interface AccentVariant {
  /** 预设色值（色板映射豁免裸 hex 约束；渲染/应用均经 token 间接）。 */
  color: string;
  /** 压在 accent 实底上的前景色（--primary-foreground 等）。 */
  foreground: string;
}

export interface AccentPreset {
  id: string;
  labelKey: string;
  light: AccentVariant;
  dark: AccentVariant;
}

/**
 * accent 预设色板（10 色）。每个预设给明/暗两个变体：亮色主题用压暗版保证
 * panel 上对比度，暗色主题用提亮版。应用时按 baseThemeId 所在分组取变体。
 */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  {
    id: "blue",
    labelKey: "theme.custom.accents.blue",
    light: { color: "#2563EB", foreground: "#FFFFFF" },
    dark: { color: "#5E99F6", foreground: "#0B1526" },
  },
  {
    id: "indigo",
    labelKey: "theme.custom.accents.indigo",
    light: { color: "#4F46E5", foreground: "#FFFFFF" },
    dark: { color: "#8B8CF8", foreground: "#12132B" },
  },
  {
    id: "violet",
    labelKey: "theme.custom.accents.violet",
    light: { color: "#7C3AED", foreground: "#FFFFFF" },
    dark: { color: "#A78BFA", foreground: "#17102B" },
  },
  {
    id: "magenta",
    labelKey: "theme.custom.accents.magenta",
    light: { color: "#C026D3", foreground: "#FFFFFF" },
    dark: { color: "#E879F9", foreground: "#2B0E30" },
  },
  {
    id: "pink",
    labelKey: "theme.custom.accents.pink",
    light: { color: "#DB2777", foreground: "#FFFFFF" },
    dark: { color: "#F472B6", foreground: "#2B0E1D" },
  },
  {
    id: "red",
    labelKey: "theme.custom.accents.red",
    light: { color: "#DC2626", foreground: "#FFFFFF" },
    dark: { color: "#F87171", foreground: "#2A0E0E" },
  },
  {
    id: "amber",
    labelKey: "theme.custom.accents.amber",
    light: { color: "#B45309", foreground: "#FFFFFF" },
    dark: { color: "#E9A916", foreground: "#211A09" },
  },
  {
    id: "green",
    labelKey: "theme.custom.accents.green",
    light: { color: "#178A5E", foreground: "#FFFFFF" },
    dark: { color: "#4ADE80", foreground: "#0C1F14" },
  },
  {
    id: "teal",
    labelKey: "theme.custom.accents.teal",
    light: { color: "#0F766E", foreground: "#FFFFFF" },
    dark: { color: "#2DD4BF", foreground: "#07201D" },
  },
  {
    id: "slate",
    labelKey: "theme.custom.accents.slate",
    light: { color: "#475569", foreground: "#FFFFFF" },
    dark: { color: "#94A3B8", foreground: "#101820" },
  },
] as const;

const ACCENT_PRESET_MAP = new Map(ACCENT_PRESETS.map((preset) => [preset.id, preset]));

export function accentPreset(id: string | null | undefined): AccentPreset | undefined {
  return id ? ACCENT_PRESET_MAP.get(id) : undefined;
}

/**
 * 各主题 --app-panel-bg 基值镜像（来源 index.css 主题块，与 miniUiPreview.css
 * 作用域同值；themeOverrides.test.ts 的契约用例对 miniUiPreview.css 强制同步）。
 * 明度偏移以 color-mix 叠加在基值上，避免运行时读取 computed style。
 */
export const PANEL_BG_BASE: Record<ThemeId, string> = {
  "deep-ink": "#2E3137",
  "cyber-purple": "#322e3a",
  "amber-gold": "#35312a",
  "classic-white": "#FFFFFF",
  "warm-gray": "#fffefd",
  "sky-blue": "#fbfdff",
  "nord-frost": "#313948",
  "tokyo-night": "#282A41",
  "rice-paper": "#FFFFFF",
  "mint-mist": "#FFFFFF",
};

/**
 * 各形态 --radius 基准镜像（来源 index.css :root[data-shape] 块），仅用于
 * 圆角滑杆在未微调时的初始落位；契约用例对 index.css 强制同步。
 */
export const SHAPE_BASE_RADIUS: Record<ThemeShape, number> = {
  soft: 0.5,
  slab: 0.25,
  sharp: 0,
  glass: 0.75,
  panel: 0,
  carbon: 0.375,
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 解析持久化/外部输入为合法 overrides；无有效字段或结构非法时返回 null。 */
export function canonicalThemeOverrides(value: unknown): ThemeOverrides | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const baseThemeId = typeof raw.baseThemeId === "string" ? raw.baseThemeId : null;
  if (!isThemeId(baseThemeId)) return null;
  const overrides: ThemeOverrides = { baseThemeId };
  if (typeof raw.accent === "string" && accentPreset(raw.accent)) {
    overrides.accent = raw.accent;
  }
  if (typeof raw.radius === "number" && Number.isFinite(raw.radius)) {
    overrides.radius = clamp(raw.radius, RADIUS_OVERRIDE_MIN, RADIUS_OVERRIDE_MAX);
  }
  if (
    typeof raw.panelLightnessDelta === "number"
    && Number.isFinite(raw.panelLightnessDelta)
  ) {
    overrides.panelLightnessDelta = clamp(
      Math.round(raw.panelLightnessDelta),
      PANEL_LIGHTNESS_MIN,
      PANEL_LIGHTNESS_MAX,
    );
  }
  return hasAnyOverride(overrides) ? overrides : null;
}

export function hasAnyOverride(overrides: ThemeOverrides | null): boolean {
  return Boolean(
    overrides
      && (overrides.accent !== undefined
        || overrides.radius !== undefined
        || overrides.panelLightnessDelta !== undefined),
  );
}

/**
 * 把 overrides 展开为 CSS custom property 声明表（token → 值）。
 * 同一份声明既写 documentElement inline style，也写 MiniUiPreview 作用域
 * inline style（预览框镜像见 MiniUiPreview.tsx）。
 */
export function buildOverrideDeclarations(
  overrides: ThemeOverrides,
): Record<string, string> {
  const declarations: Record<string, string> = {};
  const group: ThemeGroup = themeGroup(overrides.baseThemeId);

  const preset = accentPreset(overrides.accent);
  if (preset) {
    const variant = preset[group];
    declarations["--app-accent"] = variant.color;
    declarations["--primary"] = variant.color;
    declarations["--ring"] = variant.color;
    declarations["--sidebar-primary"] = variant.color;
    declarations["--sidebar-ring"] = variant.color;
    declarations["--app-tab-active-border"] = variant.color;
    declarations["--primary-foreground"] = variant.foreground;
    declarations["--sidebar-primary-foreground"] = variant.foreground;
    // 选中底色跟随 accent 色相，透明度取各主题现有 0.10–0.16 的折中。
    declarations["--app-active-bg"] = `color-mix(in srgb, ${variant.color} 12%, transparent)`;
  }

  if (overrides.radius !== undefined) {
    const radius = clamp(overrides.radius, RADIUS_OVERRIDE_MIN, RADIUS_OVERRIDE_MAX);
    // --shape-radius-* 恒由形态块定义并优先于 --radius 生效（@theme inline 的
    // var(--shape-radius-*, …) 回退链），必须一并覆盖，否则滑杆在界面上无效。
    // 比例对齐 soft 基准：sm=0.5R，md=0.75R，lg=R，xl=1.5R。
    declarations["--radius"] = `${radius}rem`;
    declarations["--shape-radius-sm"] = `calc(var(--radius) * 0.5)`;
    declarations["--shape-radius-md"] = `calc(var(--radius) * 0.75)`;
    declarations["--shape-radius-lg"] = "var(--radius)";
    declarations["--shape-radius-xl"] = `calc(var(--radius) * 1.5)`;
  }

  if (overrides.panelLightnessDelta !== undefined && overrides.panelLightnessDelta !== 0) {
    const delta = clamp(
      Math.round(overrides.panelLightnessDelta),
      PANEL_LIGHTNESS_MIN,
      PANEL_LIGHTNESS_MAX,
    );
    const base = PANEL_BG_BASE[overrides.baseThemeId];
    declarations["--app-panel-bg"] = delta > 0
      ? `color-mix(in srgb, ${base} ${100 - delta}%, white)`
      : `color-mix(in srgb, ${base} ${100 + delta}%, black)`;
  }

  return declarations;
}

/** buildOverrideDeclarations 可能写出的全部 token，供应用方整组清除。 */
export const OVERRIDE_TOKEN_TARGETS: readonly string[] = [
  "--app-accent",
  "--primary",
  "--ring",
  "--sidebar-primary",
  "--sidebar-ring",
  "--app-tab-active-border",
  "--primary-foreground",
  "--sidebar-primary-foreground",
  "--app-active-bg",
  "--radius",
  "--shape-radius-sm",
  "--shape-radius-md",
  "--shape-radius-lg",
  "--shape-radius-xl",
  "--app-panel-bg",
];

/** 导出时收集的有效 token 表（mini UI 镜像 17 项 + 形态 6 项 + 圆角基准）。 */
export const EXPORT_TOKEN_LIST: readonly string[] = [
  "--app-bg-deep",
  "--app-sidebar",
  "--app-tabbar",
  "--app-content",
  "--app-panel-bg",
  "--app-border",
  "--app-active-bg",
  "--app-accent",
  "--app-text-primary",
  "--app-text-secondary",
  "--app-text-tertiary",
  "--app-tab-highlight",
  "--app-terminal-bg",
  "--app-terminal-fg",
  "--app-status-success",
  "--primary",
  "--primary-foreground",
  "--radius",
  "--shape-radius-sm",
  "--shape-radius-md",
  "--shape-radius-lg",
  "--shape-radius-xl",
  "--shape-border-width",
  "--shape-shadow",
  "--shape-backdrop-blur",
];

/** 从 documentElement computed style 收集有效 token 值（浏览器运行时）。 */
export function collectEffectiveTokens(
  tokens: readonly string[] = EXPORT_TOKEN_LIST,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof window === "undefined" || typeof document === "undefined") return out;
  const computed = window.getComputedStyle(document.documentElement);
  for (const token of tokens) {
    out[token] = computed.getPropertyValue(token).trim();
  }
  return out;
}

export interface ThemeExportPayload {
  app: "cc-panes";
  kind: "cc-panes-theme";
  version: 1;
  /** ISO 时间戳。 */
  exportedAt: string;
  theme: {
    id: ThemeId;
    /** 导出时的本地化主题名。 */
    name: string;
    group: ThemeGroup;
  };
  shape: ThemeShape;
  /** 当前生效的微调（无则为 null）；baseThemeId 恒等于 theme.id。 */
  overrides: ThemeOverrides | null;
  /** 有效 token 表（预设 + 微调后的运行时值）。 */
  tokens: Record<string, string>;
}

export interface BuildThemeExportInput {
  themeId: ThemeId;
  themeName: string;
  shape: ThemeShape;
  overrides: ThemeOverrides | null;
  exportedAt: string;
  tokens: Record<string, string>;
}

/** 组装导出 JSON（纯函数，便于结构测试；剪贴板写入由调用方负责）。 */
export function buildThemeExport(input: BuildThemeExportInput): ThemeExportPayload {
  const overrides = input.overrides && input.overrides.baseThemeId === input.themeId
    ? input.overrides
    : null;
  return {
    app: "cc-panes",
    kind: "cc-panes-theme",
    version: 1,
    exportedAt: input.exportedAt,
    theme: {
      id: input.themeId,
      name: input.themeName,
      group: themeGroup(input.themeId),
    },
    shape: input.shape,
    overrides,
    tokens: { ...input.tokens },
  };
}

export function serializeThemeExport(payload: ThemeExportPayload): string {
  return JSON.stringify(payload, null, 2);
}
