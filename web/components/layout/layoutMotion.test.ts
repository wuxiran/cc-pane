/**
 * 布局动画 token 化防回潮静态测试
 * ==================================
 * 守护 layout/ 相关动画规则（web/assets/index.css）：
 *   - .main-view-layer 主视图 cross-fade：只过渡 opacity（不做位移，避免布局抖动），
 *     时长/缓动必须走 var(--dur) + var(--ease-out)，不许回潮裸时长；
 *   - prefers-reduced-motion 降级段必须存在：.main-view-layer 专属收短 +
 *     全局规则（keyframe 归零、transition 收短到 60ms，"fewer/gentler, not zero"）。
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
  it(".main-view-layer：opacity cross-fade 走 var(--dur) + var(--ease-out)，不含位移", () => {
    const block = cssBlock(indexCss, ".main-view-layer");
    expect(block, "缺少 .main-view-layer 规则").not.toBe("");
    expect(block).toContain("transition: opacity var(--dur) var(--ease-out)");
    expect(block).not.toContain("transform");
    expect(block).not.toMatch(/\dms/); // 不许裸时长回潮
  });

  it("reduced-motion：.main-view-layer 有专属降级段", () => {
    const hit = reducedMotionSections(indexCss).some((section) =>
      section.includes(".main-view-layer"),
    );
    expect(hit, "缺少 .main-view-layer 的 prefers-reduced-motion 降级段").toBe(true);
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
