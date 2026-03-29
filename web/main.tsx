import { enableMapSet } from "immer";
enableMapSet();

// Monaco Editor: 使用本地打包资源，不从 CDN 加载（Release CSP 会阻止 CDN 脚本）
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
loader.config({ monaco });

import ReactDOM from "react-dom/client";
import "@/i18n";
import App from "./App";
import "./assets/index.css";
import { error as logError } from "@tauri-apps/plugin-log";
import { errorToString } from "@/utils/errorUtils";

// 全局未捕获错误处理（调试白屏用）
window.addEventListener("error", (e) => {
  console.error("[GLOBAL ERROR]", e.error);
  logError(`[GLOBAL ERROR] ${errorToString(e.error)}`).catch(() => {});
  const root = document.getElementById("root");
  if (root && !root.hasChildNodes()) {
    root.innerHTML = `<pre style="color:red;padding:20px;font-size:13px;">${e.error?.stack || e.message}</pre>`;
  }
});

window.addEventListener("unhandledrejection", (e) => {
  console.error("[UNHANDLED REJECTION]", e.reason);
  logError(`[UNHANDLED REJECTION] ${errorToString(e.reason)}`).catch(() => {});
});

try {
  ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
} catch (e) {
  console.error("[RENDER CRASH]", e);
  logError(`[RENDER CRASH] ${errorToString(e)}`).catch(() => {});
  const root = document.getElementById("root");
  if (root) {
    root.innerHTML = `<pre style="color:red;padding:20px;font-size:13px;">Render crash: ${e instanceof Error ? e.stack : e}</pre>`;
  }
}
