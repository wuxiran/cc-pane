// 全局 toast 只有一份实现：web/components/ui/toast.tsx。
//
// 之前业务直接 import 第三方 toast 库，样式由库在运行时注入；注入没生效的窗口里
// 提示会掉进文档流，以无样式文字出现在窗口左上角。收编后禁止再引入第二份 toast。
import { describe, expect, it } from "vitest";

const RAW_MODULES = import.meta.glob("../**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const FORBIDDEN_IMPORT = /from\s+["'](sonner|react-hot-toast|react-toastify)["']|import\(\s*["'](sonner|react-hot-toast|react-toastify)["']\s*\)/;

describe("toast single source", () => {
  it("no module imports a third-party toast library", () => {
    const offenders = Object.entries(RAW_MODULES)
      .filter(([path]) => !path.endsWith("test/toastSingleSource.test.ts"))
      .filter(([, source]) => FORBIDDEN_IMPORT.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("only the toast module mounts a toaster implementation", () => {
    const definers = Object.entries(RAW_MODULES)
      .filter(([, source]) => /export function AppToaster\b/.test(source))
      .map(([path]) => path);
    expect(definers).toEqual(["../components/ui/toast.tsx"]);
  });
});
