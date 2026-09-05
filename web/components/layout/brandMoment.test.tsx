/**
 * 冷启动品牌瞬间（brand moment）静态契约 + 一次性语义测试
 * ==========================================================
 * 守护对象：
 *   - web/components/layout/brandMoment.css：logo 微动画 + 五区错峰落位的
 *     keyframes / 类名 / animation-delay 错峰值 / fill-mode / reduced-motion 段；
 *   - web/components/layout/brandMomentOnce.ts：一次性闸门（模块级 flag +
 *     sessionStorage），StrictMode 双渲染一致、HMR 不重播、第二次 mount 不播；
 *   - web/components/layout/AppShell.tsx：五区挂类与 CSS 类名对齐。
 *
 * CSS 断言手法对齐 layout/layoutMotion.test.ts：node:fs 直接读源码文本。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface NodeFsReadFileSync {
  readFileSync(path: string, encoding: "utf8"): string;
}

interface NodeProcessSlice {
  cwd(): string;
  getBuiltinModule(id: "node:fs"): NodeFsReadFileSync;
}

const nodeProcess = (globalThis as { process?: NodeProcessSlice }).process;
if (!nodeProcess) throw new Error("本测试需要 Node 运行时读取 brandMoment.css 源码");
const { readFileSync } = nodeProcess.getBuiltinModule("node:fs");

const brandMomentCss = readFileSync(
  `${nodeProcess.cwd()}/web/components/layout/brandMoment.css`,
  "utf8",
);
const appShellSource = readFileSync(
  `${nodeProcess.cwd()}/web/components/layout/AppShell.tsx`,
  "utf8",
);

/** 抽取 `selector { ... }` 块文本（花括号配平），未定义时返回空串 */
function cssBlock(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`);
  if (start === -1) return "";
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  return "";
}

/** 抽取全部 `@media (prefers-reduced-motion: reduce) { ... }` 段（花括号配平） */
function reducedMotionSections(css: string): string[] {
  const sections: string[] = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf("@media (prefers-reduced-motion: reduce)", from);
    if (start === -1) return sections;
    const open = css.indexOf("{", start);
    let depth = 0;
    for (let i = open; i < css.length; i++) {
      if (css[i] === "{") depth += 1;
      else if (css[i] === "}") {
        depth -= 1;
        if (depth === 0) {
          sections.push(css.slice(start, i + 1));
          from = i + 1;
          break;
        }
      }
    }
  }
}

// 五区时序表（与 brandMoment.css 注释中的总账一致）：zone 时长 = --dur-slow = 240ms。
const ZONE_DUR_MS = 240;
const ZONE_ORDER = [
  { zone: "titlebar", delayExpr: "0ms", delayMs: 0 },
  { zone: "activitybar", delayExpr: "var(--brand-moment-stagger)", delayMs: 80 },
  { zone: "content", delayExpr: "calc(var(--brand-moment-stagger) * 2)", delayMs: 160 },
  { zone: "rightdock", delayExpr: "calc(var(--brand-moment-stagger) * 3)", delayMs: 240 },
  { zone: "statusbar", delayExpr: "calc(var(--brand-moment-stagger) * 4)", delayMs: 320 },
] as const;

describe("brandMoment.css 五区落位时序", () => {
  it("定义 zone 与 logo 两个 keyframes，形态为 opacity + translateY(4px) / scale(0.96)", () => {
    const zone = cssBlock(brandMomentCss, "@keyframes brand-moment-zone-in");
    expect(zone, "缺少 @keyframes brand-moment-zone-in").not.toBe("");
    expect(zone).toContain("opacity: 0");
    expect(zone).toContain("translateY(4px)");
    expect(zone).toContain("translateY(0)");

    const logo = cssBlock(brandMomentCss, "@keyframes brand-moment-logo-in");
    expect(logo, "缺少 @keyframes brand-moment-logo-in").not.toBe("");
    expect(logo).toContain("scale(0.96)");
    expect(logo).toContain("scale(1)");
  });

  it.each(ZONE_ORDER)(
    "brand-moment-zone--$zone：both fill + --dur-slow + --ease-out，delay=$delayExpr",
    ({ zone, delayExpr }) => {
      const block = cssBlock(brandMomentCss, `.brand-moment .brand-moment-zone--${zone}`);
      expect(block, `缺少 .brand-moment-zone--${zone} 规则`).not.toBe("");
      expect(block).toContain("brand-moment-zone-in");
      expect(block).toContain("var(--dur-slow)");
      expect(block).toContain("var(--ease-out)");
      expect(block).toContain("both"); // animation-fill-mode: both（防首帧闪烁）
      expect(block).toContain(`animation-delay: ${delayExpr}`);
    },
  );

  it("错峰步长 80ms，落在 60-80ms 设计区间", () => {
    expect(brandMomentCss).toContain("--brand-moment-stagger: 80ms");
  });

  it("五区顺序为 TitleBar → ActivityBar → 主区 → RightDock → StatusBar（delay 严格递增）", () => {
    for (let i = 1; i < ZONE_ORDER.length; i++) {
      expect(ZONE_ORDER[i].delayMs).toBeGreaterThan(ZONE_ORDER[i - 1].delayMs);
    }
    expect(ZONE_ORDER[0].zone).toBe("titlebar");
  });

  it("总时长 ≤ 600ms：最后一区 delay 320 + duration 240 = 560ms", () => {
    const last = ZONE_ORDER[ZONE_ORDER.length - 1];
    expect(last.zone).toBe("statusbar");
    expect(last.delayMs + ZONE_DUR_MS).toBeLessThanOrEqual(600);
  });

  it("logo 微动画：命中首页 logo（img[alt=\"CC-Panes\"]），300ms、与主区同拍起步", () => {
    const block = cssBlock(brandMomentCss, '.brand-moment img[alt="CC-Panes"]');
    expect(block, "缺少 logo 微动画规则").not.toBe("");
    expect(block).toContain("brand-moment-logo-in");
    expect(block).toContain("var(--brand-moment-logo-dur)");
    expect(brandMomentCss).toContain("--brand-moment-logo-dur: 300ms");
    expect(block).toContain("both");
    // delay = 2 × stagger = 160ms，与主区同拍；logo 结束 460ms < 600ms 预算
    expect(brandMomentCss).toContain(
      "--brand-moment-logo-delay: calc(var(--brand-moment-stagger) * 2)",
    );
    expect(160 + 300).toBeLessThanOrEqual(600);
  });

  it("reduced-motion：media query 段内 zone 与 logo 全部 animation: none", () => {
    const sections = reducedMotionSections(brandMomentCss);
    expect(sections.length, "缺少 prefers-reduced-motion 降级段").toBeGreaterThan(0);
    const joined = sections.join("\n");
    expect(joined).toContain(".brand-moment .brand-moment-zone");
    expect(joined).toContain('.brand-moment img[alt="CC-Panes"]');
    expect(joined).toContain("animation: none");
  });

  it("作用域卫生：无裸 hex，规则选择器全部挂在 .brand-moment scope 下", () => {
    expect(brandMomentCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    const stripped = brandMomentCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const selectors = stripped.match(/^[ \t]*[^{}\s@;][^{\n]*\{/gm) ?? [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      const sel = selector.trim();
      if (/^(from|to|[\d.]+%)\s*\{$/.test(sel)) continue; // keyframes 帧选择器豁免
      expect(sel).toMatch(/^\.brand-moment/);
    }
  });
});

describe("AppShell 五区挂类接线", () => {
  it("AppShell 引入 brandMoment.css 与一次性闸门，并按 zone 类名包裹五区", () => {
    expect(appShellSource).toContain('import "./brandMoment.css"');
    expect(appShellSource).toContain("shouldPlayBrandMoment");
    for (const { zone } of ZONE_ORDER) {
      expect(appShellSource).toContain(`brand-moment-zone--${zone}`);
    }
  });
});

describe("brandMomentOnce 一次性语义", () => {
  beforeEach(() => {
    vi.resetModules();
    sessionStorage.clear();
  });

  it("首次判定可播且重复判定一致（StrictMode 双渲染安全），标记后不再播", async () => {
    const mod = await import("./brandMomentOnce");
    expect(mod.shouldPlayBrandMoment()).toBe(true);
    // commit 前第二次判定（StrictMode 双调用）必须仍为 true，不能提前消费机会
    expect(mod.shouldPlayBrandMoment()).toBe(true);
    mod.markBrandMomentPlayed();
    expect(mod.shouldPlayBrandMoment()).toBe(false);
  });

  it("第二次 mount 不播：标记后模块级 flag 立即生效", async () => {
    const mod = await import("./brandMomentOnce");
    expect(mod.shouldPlayBrandMoment()).toBe(true);
    mod.markBrandMomentPlayed();
    // 同一 JS 上下文内的再次挂载（如 AppShell 因异常边界重挂）
    expect(mod.shouldPlayBrandMoment()).toBe(false);
  });

  it("HMR 重载模块后不重播：sessionStorage 记住已播过", async () => {
    const first = await import("./brandMomentOnce");
    first.markBrandMomentPlayed();
    // 模拟 Vite HMR：模块 registry 重置，sessionStorage 仍在
    vi.resetModules();
    const second = await import("./brandMomentOnce");
    expect(second.shouldPlayBrandMoment()).toBe(false);
  });

  it("总时长常量与 CSS 预算一致（560ms 动画 + 余量，≤ 600ms 级）", async () => {
    const mod = await import("./brandMomentOnce");
    expect(mod.BRAND_MOMENT_TOTAL_MS).toBeGreaterThanOrEqual(560);
    expect(mod.BRAND_MOMENT_TOTAL_MS).toBeLessThanOrEqual(700);
  });
});
