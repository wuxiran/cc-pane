import { enableMapSet } from "immer";
enableMapSet();

// Monaco Editor 不再在入口静态配置：loader.config({ monaco }) 已移入懒加载边界
// web/components/editor/MonacoCodeEditor.tsx，monaco-editor chunk 只在打开编辑器时才拉取。

import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import i18n from "@/i18n";
import App from "./App";
import "./assets/index.css";
import { recordFrontendCrash } from "@/utils/frontendCrashLog";
import { installAppMenuPasteHandler } from "@/utils/appMenuPaste";
import { isolateSpecialWindowShape } from "@/stores/useThemeStore";
// 模块加载即在 React 挂载前恢复 UI 密度（dataset.density），与主题同通道避免首帧跳变
import "@/stores/useDensityStore";

const appPlatform = (() => {
  const platform = navigator.platform.toLowerCase();
  if (platform.startsWith("mac")) return "macos";
  if (platform.startsWith("win")) return "windows";
  if (platform.includes("linux")) return "linux";
  return "unknown";
})();
document.documentElement.dataset.platform = appPlatform;

installAppMenuPasteHandler();

// 全局未捕获错误处理（调试白屏用）
window.addEventListener("error", (e) => {
  console.error("[GLOBAL ERROR]", e.error);
  recordFrontendCrash({
    source: "window-error",
    error: e.error ?? e.message,
    extra: {
      message: e.message,
      filename: e.filename,
      lineno: e.lineno,
      colno: e.colno,
    },
  }).catch(() => {});
  const root = document.getElementById("root");
  if (root && !root.hasChildNodes()) {
    root.innerHTML = `<pre style="color:red;padding:20px;font-size:13px;">${e.error?.stack || e.message}</pre>`;
  }
});

window.addEventListener("unhandledrejection", (e) => {
  console.error("[UNHANDLED REJECTION]", e.reason);
  recordFrontendCrash({
    source: "unhandled-rejection",
    error: e.reason,
  }).catch(() => {});
});

async function renderRoot() {
  const mode = new URLSearchParams(window.location.search).get("mode");
  if (appPlatform === "linux") {
    try {
      const { getDisplayServer } = await import("@/services/platformService");
      const displayServer = await getDisplayServer();
      if (displayServer) document.documentElement.dataset.displayServer = displayServer;
    } catch {
      // Web mode and older hosts may not expose this optional diagnostics command.
    }
  }
  if (mode === "ccchan" || mode === "popup" || mode === "webgl-lab") {
    isolateSpecialWindowShape();
  }
  const root = ReactDOM.createRoot(document.getElementById("root")!);

  if (mode === "ccchan") {
    const { CCChanApp } = await import("./ccchan/CCChanApp");
    const { default: ErrorBoundary } = await import("@/components/ErrorBoundary");
    // Lightweight fallback sized for the 120x120 transparent ccchan window —
    // the default ErrorBoundary UI (icon + button + p-8) would be clipped here.
    const ccchanFallback = (
      <div
        style={{
          width: 120,
          height: 120,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          fontSize: 11,
          lineHeight: 1.4,
          color: "#ef4444",
          background: "transparent",
          padding: 8,
          userSelect: "none",
        }}
      >
        {i18n.t("ccchan:fallbackLoadFailed")}
      </div>
    );
    root.render(
      <ErrorBoundary fallback={ccchanFallback}>
        <CCChanApp />
      </ErrorBoundary>,
    );
  } else if (mode === "popup") {
    const { default: PopupTerminalWindow } = await import("@/components/PopupTerminalWindow");
    root.render(<PopupTerminalWindow />);
  } else if (mode === "webgl-lab") {
    // WebGL 花屏复现台（诊断工具）：录制回放 + GPU/WebView2 采集 + 图集诊断。
    const { default: WebglReproLab } = await import("@/components/dev/WebglReproLab");
    root.render(<WebglReproLab />);
  } else {
    // 装 WebGL 诊断台的开发者键盘和弦（Ctrl+Alt+Shift+R 录制 / G 打开诊断台）。
    const [{ installTerminalCastShortcuts }, { toast }] = await Promise.all([
      import("@/utils/terminalCast"),
      import("sonner"),
    ]);
    installTerminalCastShortcuts((m) => toast(m));
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  }
}

renderRoot().catch((e) => {
  console.error("[RENDER CRASH]", e);
  recordFrontendCrash({
    source: "render-root-crash",
    error: e,
  }).catch(() => {});
  const root = document.getElementById("root");
  if (root) {
    root.innerHTML = `<pre style="color:red;padding:20px;font-size:13px;">Render crash: ${e instanceof Error ? e.stack : e}</pre>`;
  }
});
