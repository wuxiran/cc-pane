/**
 * 重依赖懒加载边界守护。
 *
 * monaco-editor / @monaco-editor/react 一旦在入口静态图出现，构建产物里 ~950kB(gzip)
 * 的 monaco chunk 就会被 index.html modulepreload，首屏强制下载。这里用源码扫描
 * 钉住边界，防止后续改动把静态 import 加回来（bundle 预算脚本守产物，本测试守源码）。
 */
import { describe, expect, it } from "vitest";

// @ts-expect-error 测试运行在 Node；前端 tsconfig 刻意不引入 @types/node。
import { readFileSync } from "node:fs";

function readWebFile(relativePath: string): string {
  // 与 colorGuard.test.ts 一致：vitest 从仓库根启动，直接读 cwd 相对路径。
  return readFileSync(`web/${relativePath}`, "utf8");
}

/** 静态值导入（`import type` 会被擦除，不构成运行时依赖，允许存在）。 */
function staticValueImports(source: string, specifier: string): string[] {
  return source
    .split("\n")
    .filter((line) => {
      if (!line.includes(`from "${specifier}"`) && !line.includes(`import "${specifier}"`)) return false;
      return !/^\s*import\s+type\b/.test(line) && !/^\s*\/\//.test(line);
    });
}

describe("heavy dependency lazy boundaries", () => {
  it("main.tsx does not statically import monaco", () => {
    const main = readWebFile("main.tsx");
    expect(staticValueImports(main, "monaco-editor")).toEqual([]);
    expect(staticValueImports(main, "@monaco-editor/react")).toEqual([]);
  });

  it("EditorView loads monaco through the lazy boundary module", () => {
    const source = readWebFile("components/editor/EditorView.tsx");
    expect(staticValueImports(source, "@monaco-editor/react")).toEqual([]);
    expect(staticValueImports(source, "monaco-editor")).toEqual([]);
    expect(source).toContain('lazyWithRetry');
    expect(source).toContain('import("./MonacoCodeEditor")');
    expect(source).toContain("<Suspense");
  });

  it("the monaco boundary module owns loader.config", () => {
    const boundary = readWebFile("components/editor/MonacoCodeEditor.tsx");
    expect(boundary).toContain("loader.config({ monaco })");
  });

  it("codemirror stays behind the JsonEditor lazy boundary", () => {
    const panel = readWebFile("components/providers/ProviderFormPanel.tsx");
    expect(panel).toContain('import("@/components/editor/JsonEditor")');
    expect(staticValueImports(panel, "codemirror")).toEqual([]);
    expect(staticValueImports(panel, "@codemirror/state")).toEqual([]);
  });

  it("recharts stays behind the HomeUsageStats lazy boundary", () => {
    const settings = readWebFile("components/settings/SettingsPaneContent.tsx");
    expect(settings).toContain('import("@/components/home/HomeUsageStats")');
  });

  it("mermaid is only dynamically imported", () => {
    const block = readWebFile("components/editor/MermaidBlock.tsx");
    expect(block).toContain('import("mermaid")');
    expect(staticValueImports(block, "mermaid")).toEqual([]);
  });
});
