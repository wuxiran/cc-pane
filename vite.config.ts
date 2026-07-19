import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "web"),
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
      },
      output: {
        manualChunks: {
          "xterm": ["@xterm/xterm", "@xterm/addon-fit"],
          "radix": ["@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-context-menu", "@radix-ui/react-tooltip", "@radix-ui/react-alert-dialog"],
          "monaco-editor": ["monaco-editor"],
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 14200,
    strictPort: false,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      //
      // 仓库根目录堆着大量非前端产物，其中 .cargo/config.toml 把 Rust 的 target-dir
      // 指到了仓库根（实测 357GB / 22 万文件），且 tauri dev 期间 cargo 还在持续写入。
      // chokidar 默认只跳过 node_modules/.git，递归监听这些目录会吃光内存并让 dev
      // server 彻底停止响应（表现为窗口永久停在 "Loading CC-Panes..."）。
      // 新增顶层非前端目录时记得同步这里。
      ignored: [
        "**/src-tauri/**",
        "**/target/**",
        "**/target-package*/**",
        "**/cc-panes-mobile/**",
        "**/_archived_v1/**",
        "**/_reference/**",
        "**/ref/**",
        "**/.ccpanes/**",
        "**/coverage/**",
        "**/dist/**",
        "**/tmp/**",
        "**/test-workspace/**",
      ],
    },
  },
}));
