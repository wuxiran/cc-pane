// shape 允许列表的 Rust↔TS 镜像守卫。
//
// 两份允许列表手工维护：Rust 侧 `ThemeSettings::merge_missing_defaults` 的
// matches! 字面量（settings.rs）与 TS 侧 THEME_SHAPE_CODES。漏改任何一侧都是
// **双向静默回落 soft**：只加 TS → 保存后 Rust 把值改写回 "soft" 落盘；
// 只加 Rust → canonicalThemeShape 在前端静默回落。没有报错、没有日志。
// 做法照抄 daemonEventContract.test.ts：真扫 Rust 源码，而不是抄一份常量自证。
import { describe, it, expect } from "vitest";
// Vite raw import 读源码，避开 node:fs（web 的 tsconfig 不含 node 类型）
import rustSettings from "../../cc-panes-core/src/models/settings.rs?raw";
import { THEME_SHAPE_CODES, DEFAULT_THEME_SHAPE } from "./themeShapes";

// 定位到 ThemeSettings 的 matches!：settings.rs 里 merge_missing_defaults 有
// 十来个同名实现，`self.shape.as_str()` 是 shape 校验独有的锚点。
function extractRustShapeAllowlist(): string[] {
  const anchor = "self.shape.as_str()";
  const start = rustSettings.indexOf(anchor);
  expect(start, `settings.rs 里找不到 ${anchor}——shape 校验被移动或重写，同步更新本测试`).toBeGreaterThanOrEqual(0);
  // 锚点自带 `()`，闭合括号要从锚点**之后**找（matches! 的收尾括号）
  const literalsStart = start + anchor.length;
  const end = rustSettings.indexOf(")", literalsStart);
  expect(end).toBeGreaterThan(literalsStart);
  const block = rustSettings.slice(literalsStart, end);
  return [...block.matchAll(/"(\w+)"/g)].map((m) => m[1]);
}

describe("shape 允许列表 Rust↔TS 镜像", () => {
  it("Rust matches! 字面量与 THEME_SHAPE_CODES 完全一致（含顺序无关比较）", () => {
    const rustCodes = extractRustShapeAllowlist();
    expect(rustCodes.length, "Rust 侧 shape 允许列表为空——抽取锚点失效").toBeGreaterThan(0);
    expect([...rustCodes].sort()).toEqual([...THEME_SHAPE_CODES].sort());
  });

  it("Rust default_theme_shape 与 TS DEFAULT_THEME_SHAPE 一致", () => {
    const match = rustSettings.match(
      /fn default_theme_shape\(\) -> String \{\s*"(\w+)"\.to_string\(\)/,
    );
    expect(match, "settings.rs 里找不到 default_theme_shape——函数被移动或重写，同步更新本测试").not.toBeNull();
    expect(match![1]).toBe(DEFAULT_THEME_SHAPE);
  });
});
