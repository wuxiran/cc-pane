import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "web"),
      // monaco-editor 的 package.json 只有 module 字段、没有 main/exports，
      // vite-node 的 SSR 解析会直接拒绝它；而 Vitest 4 对 vi.mock 的模块做导出
      // 形状分析时仍需完成解析。指向 ESM 入口即可（仅测试环境生效，构建走
      // vite.config.ts，不受本别名影响）。
      "monaco-editor": resolve(__dirname, "node_modules/monaco-editor/esm/vs/editor/editor.main.js"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    // The full Windows coverage job can briefly starve async UI tests while
    // hundreds of files share the runner. Keep a bounded but realistic limit.
    testTimeout: 10_000,
    setupFiles: ["./web/test/setup.ts"],
    include: ["web/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["web/**/*.{ts,tsx}"],
      exclude: [
        "web/test/**",
        "web/**/*.test.{ts,tsx}",
        "web/vite-env.d.ts",
        "web/main.tsx",
        "web/components/ui/**",
      ],
      // 阶梯式防退化：门槛设为当前真实基线，autoUpdate 让覆盖率上升时自动抬高门槛（棘轮），
      // 从而只防退化、随补测逐步收紧，直到重新逼近 80%。基线由 `npm run test:coverage` 实测得出。
      thresholds: {
        autoUpdate: true,
        statements: 74.66,
        branches: 67.71,
        functions: 73.88,
        lines: 77.5,
      },
    },
  },
});