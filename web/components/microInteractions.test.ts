/**
 * 微交互标准 utility 防回潮静态测试
 * ==================================
 * 守护 web/assets/index.css 中定义的三个微交互 @utility（「三板斧」）：
 *   - ui-pressable：按压缩放 scale(0.97)，--dur-fast + --ease-out，
 *     prefers-reduced-motion 下禁用 transform；
 *   - ui-hoverable：color / background-color 过渡走 --dur-fast；
 *   - ui-selected：左侧 2px 选中指示条（inset box-shadow + var(--primary)）。
 * 断言风格对齐同目录 designTokens.test.ts：直接读源码文本做静态检查，
 * 防止 utility 被改名、删参数或丢失降级分支后调用方静默失效。
 *
 * 读取方式说明：vitest（css: false 默认）会把 CSS 的 ?raw / ?inline 导入
 * 掏空成空串，designTokens.test.ts 的 glob-raw 口径对 .css 不适用；
 * 仓库又未装 @types/node（无法直接 import node:fs），故经
 * process.getBuiltinModule（Node 22.3+，项目要求 Node 22+）取内置 fs，
 * 结构化类型在本地声明，不引入新的全局类型。
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

// jsdom 的 URL 解析会吃掉 file:///C:/... 的盘符段（import.meta.url 不可靠），
// 而 vitest 恒以仓库根为 cwd（npm scripts / CI 均从根目录调用），故走 cwd 相对路径。
const indexCss = readFileSync(`${nodeProcess.cwd()}/web/assets/index.css`, "utf8");

/** 抽取 `@utility <name> { ... }` 整块文本（按花括号配平），未定义时返回空串 */
function utilityBlock(css: string, name: string): string {
  const start = css.indexOf(`@utility ${name} {`);
  if (start === -1) return "";
  let depth = 0;
  for (let i = start; i < css.length; i++) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(start, i + 1);
    }
  }
  return "";
}

describe("micro-interaction utilities (anti-regression)", () => {
  it("读到 index.css 源码", () => {
    expect(indexCss.length).toBeGreaterThan(0);
  });

  it("ui-pressable / ui-hoverable / ui-selected 三个 utility 均已定义", () => {
    for (const name of ["ui-pressable", "ui-hoverable", "ui-selected"]) {
      expect(utilityBlock(indexCss, name), `缺少 @utility ${name} 定义`).not.toBe("");
    }
  });

  it("ui-pressable：active 缩放 0.97，走 --dur-fast + --ease-out", () => {
    const block = utilityBlock(indexCss, "ui-pressable");
    expect(block).toContain("scale(0.97)");
    expect(block).toContain("transition-property: transform");
    expect(block).toContain("var(--dur-fast)");
    expect(block).toContain("var(--ease-out)");
  });

  it("ui-pressable：prefers-reduced-motion 下禁用 transform", () => {
    const block = utilityBlock(indexCss, "ui-pressable");
    expect(block).toContain("prefers-reduced-motion: reduce");
    expect(block).toContain("transform: none");
  });

  it("ui-hoverable：color / background-color 过渡走 --dur-fast", () => {
    const block = utilityBlock(indexCss, "ui-hoverable");
    expect(block).toContain("color, background-color");
    expect(block).toContain("var(--dur-fast)");
  });

  it("ui-selected：左侧 2px inset 指示条，颜色 var(--primary)", () => {
    const block = utilityBlock(indexCss, "ui-selected");
    expect(block).toContain("box-shadow");
    expect(block).toContain("inset 2px 0 0 0 var(--primary)");
  });
});
