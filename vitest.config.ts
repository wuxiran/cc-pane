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
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
