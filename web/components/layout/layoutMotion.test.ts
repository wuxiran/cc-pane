/**
 * 布局动画 token 化防回潮静态测试
 * ==================================
 * 守护 layout/ 相关动画规则（web/assets/index.css）：
 *   - .main-view-layer 主视图切换是直接切换（docs/46 §5）：不许回潮 CSS 过渡，
 *     原生应用不在同级视图间淡入淡出；
 *   - prefers-reduced-motion 全局规则（keyframe 归零、transition 收短到 60ms）。
 * 断言风格对齐 web/components/microInteractions.test.ts：直接读源码文本做静态检查。
 */
import { describe, it, expect } from "vitest";

interface NodeFsReadFileSync {
  readFileSync(path: string, encoding: "utf8"): string;
}

interface NodeProcessSlice {
  cwd(): string;
  getBuiltinModule(id: "node:fs"): NodeFsReadFileSync;
}

const nodeProcess = (globalThis as { process?: NodeProcessSlice }).process;
if (!nodeProcess) throw new Error("本测试需要 Node 运行时读取 index.css 源码");
const { readFileSync } = nodeProcess.getBuiltinModule("node:fs");

// vitest 恒以仓库根为 cwd（与 microInteractions.test.ts 同一口径）
const indexCss = readFileSync(`${nodeProcess.cwd()}/web/assets/index.css`, "utf8");

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

describe("layout motion tokens (anti-regression)", () => {
  it(".main-view-layer：主视图切换不带 CSS 过渡或 will-change（直接切换）", () => {
    expect(cssBlock(indexCss, ".main-view-layer")).toBe("");
  });

  it("SidebarTransition：侧栏显隐不带过渡（避免动画期间反复 refit 终端）", () => {
    const source = readFileSync(
      `${nodeProcess.cwd()}/web/components/layout/SidebarTransition.tsx`,
      "utf8",
    );
    expect(source).not.toContain("transition:");
    expect(source).not.toContain("onTransitionEnd");
  });

  it("reduced-motion：全局规则归零 keyframe 并收短 transition（fewer/gentler, not zero）", () => {
    const reduced = reducedMotionSections(indexCss).join("\n");
    expect(reduced).toContain("animation-duration: 0.01ms");
    expect(reduced).toContain("transition-duration: 60ms");
  });

  it("动效 token 存在且取值不变（--dur-fast/--dur/--dur-slow/--ease-out）", () => {
    expect(indexCss).toContain("--dur-fast: 120ms");
    expect(indexCss).toContain("--dur: 160ms");
    expect(indexCss).toContain("--dur-slow: 240ms");
    expect(indexCss).toContain("--ease-out: cubic-bezier(0.23, 1, 0.32, 1)");
  });
});
