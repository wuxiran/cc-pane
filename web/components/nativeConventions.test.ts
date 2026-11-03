/**
 * 原生手感约定防回潮静态测试（docs/46 §5.1）。
 * 只锁机器能判定的底线：可点元素不换手形光标、程序化滚动不用 smooth、主窗口首帧无占位。
 */
import { describe, expect, it } from "vitest";

interface NodeFs {
  readFileSync(path: string, encoding: "utf8"): string;
  readdirSync(path: string, options: { recursive: true; encoding: "utf8" }): string[];
}
interface NodeProcessSlice {
  cwd(): string;
  getBuiltinModule(id: "node:fs"): NodeFs;
}

const nodeProcess = (globalThis as { process?: NodeProcessSlice }).process;
if (!nodeProcess) throw new Error("本测试需要 Node 运行时读取源码");
const { readFileSync, readdirSync } = nodeProcess.getBuiltinModule("node:fs");
const webRoot = `${nodeProcess.cwd()}/web`;

const sources = readdirSync(webRoot, { recursive: true, encoding: "utf8" })
  .filter((file) => /\.tsx?$/.test(file) && !file.includes(".test.") && !file.startsWith("components/dev/"))
  .map((file) => ({ file, text: readFileSync(`${webRoot}/${file}`, "utf8") }));

describe("native conventions (anti-regression)", () => {
  it("可点元素不使用 cursor-pointer", () => {
    const offenders = sources
      .filter(({ text }) => text.includes("cursor-pointer"))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("程序化滚动不使用 behavior: smooth", () => {
    const offenders = sources
      .filter(({ text }) => /behavior:[^,\n]*["']smooth["']/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("macOS 上 UI 字体走系统字体，Inter 只在其它平台优先", () => {
    const css = readFileSync(`${webRoot}/assets/index.css`, "utf8");
    const mac = css.match(/:root\[data-platform="macos"\]\s*\{\s*--font-sans:([^;]+);/);
    expect(mac?.[1].trim().startsWith("-apple-system")).toBe(true);
    expect(mac?.[1]).not.toContain("Inter");
    expect(css).toContain('font-family: "Inter Variable";');
  });

  it("全局与 .app-scrollbar 的 ::-webkit-scrollbar 自绘只在非 macOS 生效", () => {
    const css = readFileSync(`${webRoot}/assets/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    // 有意保留的局部例外：隐藏滚动条、xterm v5 兜底、标签条可发现性
    const allowed = [".no-scrollbar", ".xterm-viewport", ".cc-tabbar-scroll"];
    const offenders = css
      .split("}")
      // 取每段最后一个 "{" 前的选择器，覆盖 @media 内嵌规则
      .map((rule) => rule.split("{").slice(-2, -1)[0] ?? "")
      .flatMap((selector) => selector.split(","))
      .map((selector) => selector.trim())
      .filter((selector) => selector.includes("::-webkit-scrollbar"))
      .filter((selector) => !selector.startsWith(':where(:root:not([data-platform="macos"]))'))
      .filter((selector) => !allowed.some((token) => selector.includes(token)));
    expect(offenders).toEqual([]);
  });

  it("index.html 首帧有底色、无 Loading 占位、关闭拼写检查", () => {
    const html = readFileSync(`${nodeProcess.cwd()}/index.html`, "utf8");
    expect(html).not.toContain("Loading CC-Panes");
    expect(html).toContain("prefers-color-scheme: light");
    expect(html).toContain('<body spellcheck="false">');
  });
});
