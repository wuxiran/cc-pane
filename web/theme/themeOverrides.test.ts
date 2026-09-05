// @ts-expect-error Tests run in Node; the frontend tsconfig intentionally omits @types/node.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ACCENT_PRESETS,
  accentPreset,
  buildOverrideDeclarations,
  buildThemeExport,
  canonicalThemeOverrides,
  collectEffectiveTokens,
  EXPORT_TOKEN_LIST,
  hasAnyOverride,
  OVERRIDE_TOKEN_TARGETS,
  PANEL_BG_BASE,
  PANEL_LIGHTNESS_MAX,
  PANEL_LIGHTNESS_MIN,
  RADIUS_OVERRIDE_MAX,
  RADIUS_OVERRIDE_MIN,
  serializeThemeExport,
  SHAPE_BASE_RADIUS,
} from "@/theme/themeOverrides";
import { THEME_PRESETS } from "@/theme/themePresets";
import { THEME_SHAPE_CODES } from "@/theme/themeShapes";

const HEX_RE = /^#[0-9a-f]{3,8}$/i;

describe("canonicalThemeOverrides", () => {
  it("拒绝非对象与缺失/非法 baseThemeId", () => {
    expect(canonicalThemeOverrides(null)).toBeNull();
    expect(canonicalThemeOverrides("deep-ink")).toBeNull();
    expect(canonicalThemeOverrides({})).toBeNull();
    expect(canonicalThemeOverrides({ baseThemeId: "nope", accent: "blue" })).toBeNull();
  });

  it("拒绝全部字段缺省的空微调（不沉淀空壳）", () => {
    expect(canonicalThemeOverrides({ baseThemeId: "deep-ink" })).toBeNull();
    expect(
      canonicalThemeOverrides({ baseThemeId: "deep-ink", accent: "unknown-preset" }),
    ).toBeNull();
  });

  it("保留合法字段并钳制范围", () => {
    expect(
      canonicalThemeOverrides({
        baseThemeId: "deep-ink",
        accent: "blue",
        radius: 99,
        panelLightnessDelta: -99,
      }),
    ).toEqual({
      baseThemeId: "deep-ink",
      accent: "blue",
      radius: RADIUS_OVERRIDE_MAX,
      panelLightnessDelta: PANEL_LIGHTNESS_MIN,
    });
    expect(
      canonicalThemeOverrides({ baseThemeId: "warm-gray", panelLightnessDelta: 99.6 }),
    ).toEqual({ baseThemeId: "warm-gray", panelLightnessDelta: PANEL_LIGHTNESS_MAX });
  });

  it("radius 允许 0（直角化），panelLightnessDelta 取整", () => {
    expect(canonicalThemeOverrides({ baseThemeId: "deep-ink", radius: 0 })).toEqual({
      baseThemeId: "deep-ink",
      radius: RADIUS_OVERRIDE_MIN,
    });
    expect(
      canonicalThemeOverrides({ baseThemeId: "deep-ink", panelLightnessDelta: 2.6 }),
    ).toEqual({ baseThemeId: "deep-ink", panelLightnessDelta: 3 });
  });
});

describe("hasAnyOverride", () => {
  it("识别空与非空", () => {
    expect(hasAnyOverride(null)).toBe(false);
    expect(hasAnyOverride({ baseThemeId: "deep-ink" })).toBe(false);
    expect(hasAnyOverride({ baseThemeId: "deep-ink", radius: 0 })).toBe(true);
  });
});

describe("buildOverrideDeclarations", () => {
  it("accent 按主题分组取变体并展开到 accent 系 token", () => {
    const dark = buildOverrideDeclarations({ baseThemeId: "deep-ink", accent: "amber" });
    const light = buildOverrideDeclarations({ baseThemeId: "classic-white", accent: "amber" });
    const preset = accentPreset("amber")!;

    expect(dark["--app-accent"]).toBe(preset.dark.color);
    expect(dark["--primary"]).toBe(preset.dark.color);
    expect(dark["--ring"]).toBe(preset.dark.color);
    expect(dark["--primary-foreground"]).toBe(preset.dark.foreground);
    expect(dark["--app-active-bg"]).toBe(
      `color-mix(in srgb, ${preset.dark.color} 12%, transparent)`,
    );
    expect(light["--app-accent"]).toBe(preset.light.color);
    expect(light["--primary-foreground"]).toBe(preset.light.foreground);
  });

  it("radius 覆盖 --radius 与 --shape-radius-*（比例派生，经 var() 引用）", () => {
    const declarations = buildOverrideDeclarations({ baseThemeId: "deep-ink", radius: 0.6 });
    expect(declarations["--radius"]).toBe("0.6rem");
    expect(declarations["--shape-radius-sm"]).toBe("calc(var(--radius) * 0.5)");
    expect(declarations["--shape-radius-md"]).toBe("calc(var(--radius) * 0.75)");
    expect(declarations["--shape-radius-lg"]).toBe("var(--radius)");
    expect(declarations["--shape-radius-xl"]).toBe("calc(var(--radius) * 1.5)");
  });

  it("panelLightnessDelta 正提亮负压暗，基值取该主题镜像；0 不出声明", () => {
    const lighten = buildOverrideDeclarations({
      baseThemeId: "deep-ink",
      panelLightnessDelta: 5,
    });
    expect(lighten["--app-panel-bg"]).toBe(
      `color-mix(in srgb, ${PANEL_BG_BASE["deep-ink"]} 95%, white)`,
    );
    const darken = buildOverrideDeclarations({
      baseThemeId: "sky-blue",
      panelLightnessDelta: -3,
    });
    expect(darken["--app-panel-bg"]).toBe(
      `color-mix(in srgb, ${PANEL_BG_BASE["sky-blue"]} 97%, black)`,
    );
    const zero = buildOverrideDeclarations({
      baseThemeId: "sky-blue",
      panelLightnessDelta: 0,
    });
    expect(zero["--app-panel-bg"]).toBeUndefined();
  });

  it("空微调不出任何声明；所有声明键都在 OVERRIDE_TOKEN_TARGETS 内", () => {
    expect(buildOverrideDeclarations({ baseThemeId: "deep-ink" })).toEqual({});
    const full = buildOverrideDeclarations({
      baseThemeId: "nord-frost",
      accent: "teal",
      radius: 0.25,
      panelLightnessDelta: 4,
    });
    for (const token of Object.keys(full)) {
      expect(OVERRIDE_TOKEN_TARGETS).toContain(token);
    }
  });
});

describe("buildThemeExport 结构", () => {
  it("含主题名/token 表/时间戳/形状/微调，overrides 与主题一致才随包导出", () => {
    const tokens = Object.fromEntries(EXPORT_TOKEN_LIST.map((token) => [token, "x"]));
    const payload = buildThemeExport({
      themeId: "tokyo-night",
      themeName: "夜泊蓝",
      shape: "carbon",
      overrides: { baseThemeId: "tokyo-night", accent: "blue", radius: 0.3 },
      exportedAt: "2026-09-05T12:00:00.000Z",
      tokens,
    });

    expect(payload.app).toBe("cc-panes");
    expect(payload.kind).toBe("cc-panes-theme");
    expect(payload.version).toBe(1);
    expect(payload.exportedAt).toBe("2026-09-05T12:00:00.000Z");
    expect(payload.theme).toEqual({ id: "tokyo-night", name: "夜泊蓝", group: "dark" });
    expect(payload.shape).toBe("carbon");
    expect(payload.overrides).toEqual({
      baseThemeId: "tokyo-night",
      accent: "blue",
      radius: 0.3,
    });
    expect(Object.keys(payload.tokens).sort()).toEqual([...EXPORT_TOKEN_LIST].sort());

    const roundTripped = JSON.parse(serializeThemeExport(payload));
    expect(roundTripped).toEqual(payload);
  });

  it("overrides 依附其他主题时导出为 null（未生效的微调不算有效主题）", () => {
    const payload = buildThemeExport({
      themeId: "deep-ink",
      themeName: "午夜蓝",
      shape: "soft",
      overrides: { baseThemeId: "warm-gray", accent: "red" },
      exportedAt: "2026-09-05T12:00:00.000Z",
      tokens: {},
    });
    expect(payload.overrides).toBeNull();
  });
});

describe("collectEffectiveTokens", () => {
  it("按清单逐项取值并裁剪空白（jsdom 无级联时为空串）", () => {
    const tokens = collectEffectiveTokens(["--app-accent", "--radius"]);
    expect(Object.keys(tokens).sort()).toEqual(["--app-accent", "--radius"]);
    expect(typeof tokens["--app-accent"]).toBe("string");
  });
});

// ---- 镜像契约：TS 镜像表与 CSS 真源防漂移 ----

const appCss = readFileSync("web/assets/index.css", "utf8");
const previewCss = readFileSync("web/components/theme/miniUiPreview.css", "utf8");

// 注释里可能含花括号（如 body{font-size}），朴素块解析前先剥注释。
const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const appCssClean = stripComments(appCss);
const previewCssClean = stripComments(previewCss);

function blockOf(css: string, selector: string): string {
  const start = css.indexOf(selector);
  if (start < 0) return "";
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  return css.slice(open + 1, close);
}

function parseTokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(block))) out[match[1]] = match[2].trim();
  return out;
}

describe("PANEL_BG_BASE 镜像契约", () => {
  it.each(THEME_PRESETS.map((preset) => preset.id))(
    "%s 与 miniUiPreview.css 作用域 --app-panel-bg 一致（后者已对 index.css 有契约）",
    (themeId) => {
      const scope = parseTokens(blockOf(previewCssClean, `.mini-ui-scope[data-theme="${themeId}"]`));
      expect(scope["--app-panel-bg"]).toBeDefined();
      expect(PANEL_BG_BASE[themeId]).toBe(scope["--app-panel-bg"]);
    },
  );
});

describe("SHAPE_BASE_RADIUS 镜像契约", () => {
  it.each(THEME_SHAPE_CODES)("%s 与 index.css :root[data-shape] --radius 一致", (shape) => {
    const scope = parseTokens(blockOf(appCssClean, `:root[data-shape="${shape}"]`));
    expect(scope["--radius"]).toBeDefined();
    expect(SHAPE_BASE_RADIUS[shape]).toBeCloseTo(parseFloat(scope["--radius"]), 5);
  });
});

describe("ACCENT_PRESETS 色板约束", () => {
  it("8-12 色、id 唯一、明/暗变体均为合法 hex", () => {
    expect(ACCENT_PRESETS.length).toBeGreaterThanOrEqual(8);
    expect(ACCENT_PRESETS.length).toBeLessThanOrEqual(12);
    const ids = new Set(ACCENT_PRESETS.map((preset) => preset.id));
    expect(ids.size).toBe(ACCENT_PRESETS.length);
    for (const preset of ACCENT_PRESETS) {
      for (const variant of [preset.light, preset.dark]) {
        expect(variant.color, `${preset.id} color 非法`).toMatch(HEX_RE);
        expect(variant.foreground, `${preset.id} foreground 非法`).toMatch(HEX_RE);
      }
      expect(preset.labelKey).toMatch(/^theme\.custom\.accents\./);
    }
  });
});
