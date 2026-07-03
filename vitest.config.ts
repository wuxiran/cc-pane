import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { resolve } from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "web"),
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
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
        statements: 28,
        branches: 25,
        functions: 26,
        lines: 30,
      },
    },
  },
});
