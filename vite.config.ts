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
        // 函数形式 manualChunks：对象形式会把「被列出模块的依赖」一并抓进 chunk，
        // 实测 vite 的 __vitePreload 共享 helper 被拖进 monaco-editor chunk，导致入口
        // chunk 静态 import 它、monaco 重新变成首屏 modulepreload，懒加载失效。
        // onlyExplicitManualChunks 关掉这种依赖传递合并，只有显式命中的模块进组。
        onlyExplicitManualChunks: true,
        manualChunks(id) {
          // monaco 只经懒加载边界（editor/MonacoCodeEditor.tsx）动态引用，
          // 该 chunk 不再进入首屏 modulepreload 图。
          // 必须带上 loader 的依赖链（@monaco-editor/loader → state-local）：
          // state-local 不命中时落进 MonacoCodeEditor chunk（懒加载边界），
          // loader 在模块求值期就调它的 .create —— monaco chunk ⇄ 边界 chunk
          // 互相静态引用成环，生产包打开编辑器即崩 "Cannot read properties
          // of undefined (reading 'create')"（2026-09-05 debug 打包实锤）。
          if (
            id.includes("node_modules/monaco-editor/")
            || id.includes("node_modules/@monaco-editor/")
            || id.includes("node_modules/state-local/")
          ) {
            return "monaco-editor";
          }
          if (id.includes("node_modules/@xterm/")) return "xterm";
          // @radix-ui 不做独立分包：Radix 组件在模块求值期即调用 React.forwardRef，
          // 独立 chunk 会与入口（React 所在）形成循环依赖——radix 先求值时 React
          // 绑定未初始化，生产包启动即崩 "Cannot read properties of undefined
          // (reading 'forwardRef')"（2026-09-05 debug 打包实锤，dev server 无 manualChunks
          // 故从不复现）。并入入口 chunk 消除环，首屏 gzip 成本仅 ~26kB。
          return undefined;
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
        // Rust target-dir 在 .cargo/config.toml 里被指到仓库根并带 -target 后缀
        // (cc-book-target / cc-context-target / ...), chokidar 默认会监听它们,
        // cargo 持续写入 build/*.exe 期间会撞 Windows 文件锁触发 EBUSY 让 Vite 退出。
        // 加 *-target 通配兜底,新增 target 目录不再需要改这里。
        "**/*-target/**",
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
