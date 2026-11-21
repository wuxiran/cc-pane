import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      { find: "@", replacement: resolve(__dirname, "web") },
      // 与 vite.config.ts 同口径：lucide-react → 实心款映射层。必须用精确正则，
      // 字符串别名会连 shim 自己引用的 lucide-react/dist/... 深路径一起改写。
      { find: /^lucide-react$/, replacement: resolve(__dirname, "web/components/icons/lucideSolidShim.ts") },
      // monaco-editor 的 package.json 只有 module 字段、没有 main/exports，
      // vite-node 的 SSR 解析会直接拒绝它；而 Vitest 4 对 vi.mock 的模块做导出
      // 形状分析时仍需完成解析。指向 ESM 入口即可（仅测试环境生效，构建走
      // vite.config.ts，不受本别名影响）。
      { find: /^monaco-editor$/, replacement: resolve(__dirname, "node_modules/monaco-editor/esm/vs/editor/editor.main.js") },
    ],
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
        statements: 79.18,
        branches: 72.22,
        functions: 76.66,
        lines: 81.99,
      },
    },
  },
});