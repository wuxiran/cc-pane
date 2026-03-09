import ReactDOM from "react-dom/client";
import "@/i18n";
import App from "./App";
import "./assets/index.css";

// 全局未捕获错误处理（调试白屏用）
window.addEventListener("error", (e) => {
  console.error("[GLOBAL ERROR]", e.error);
  const root = document.getElementById("root");
  if (root && !root.hasChildNodes()) {
    root.innerHTML = `<pre style="color:red;padding:20px;font-size:13px;">${e.error?.stack || e.message}</pre>`;
  }
});

window.addEventListener("unhandledrejection", (e) => {
  console.error("[UNHANDLED REJECTION]", e.reason);
});

try {
  ReactDOM.createRoot(document.getElementById("root")!).render(<App />);
} catch (e) {
  console.error("[RENDER CRASH]", e);
  const root = document.getElementById("root");
  if (root) {
    root.innerHTML = `<pre style="color:red;padding:20px;font-size:13px;">Render crash: ${e instanceof Error ? e.stack : e}</pre>`;
  }
}
