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

// 内容里的外链保留手形光标，这是平台约定的例外。
const POINTER_ALLOWLIST = new Set(["components/skill/LinkSkillManager.tsx"]);

describe("native conventions (anti-regression)", () => {
  it("可点元素不使用 cursor-pointer", () => {
    const offenders = sources
      .filter(({ file, text }) => text.includes("cursor-pointer") && !POINTER_ALLOWLIST.has(file))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("程序化滚动不使用 behavior: smooth", () => {
    const offenders = sources
      .filter(({ text }) => /behavior:[^,\n]*["']smooth["']/.test(text))
      .map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  it("index.html 首帧有底色、无 Loading 占位、关闭拼写检查", () => {
    const html = readFileSync(`${nodeProcess.cwd()}/index.html`, "utf8");
    expect(html).not.toContain("Loading CC-Panes");
    expect(html).toContain("prefers-color-scheme: light");
    expect(html).toContain('<body spellcheck="false">');
  });
});
