/**
 * 弹出终端窗口 — 独立系统窗口中的纯终端视图
 * tabData 通过 Rust PopupDataStore（IPC）获取，避免 URL 传递大 JSON
 */

import { useEffect, useCallback, useRef, useState } from "react";
import { useTabViewStateStore } from "@/stores/useTabViewStateStore";
import { getCurrentWindow } from "@tauri-apps/api/window";
import TerminalView from "@/components/panes/TerminalView";
import { getPopupTabData } from "@/services/popupWindowService";
import type { PopupTabData } from "@/services/popupWindowService";

export default function PopupTerminalWindow() {
  const sessionCreatedRef = useRef(false);
  const [tabData, setTabData] = useState<PopupTabData | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 启动时通过 IPC 获取 tabData
  useEffect(() => {
    getPopupTabData()
      .then((data) => {
        if (data) {
          setTabData(data);
        } else {
          setError("No tab data available");
        }
      })
      .catch((err) => {
        setError(`Failed to get tab data: ${String(err)}`);
      });
  }, []);

  // 设置窗口标题
  useEffect(() => {
    if (!tabData) return;
    const currentWindow = getCurrentWindow();
    currentWindow.setTitle(tabData.title || "Terminal").catch(console.error);
  }, [tabData]);

  // B2-05：上报真实可见性。此前弹窗只传 isActive={true}，经 TerminalView 的
  // `isVisible ?? isActive` 回退变成永久自认可见——积压/降档/休眠全不生效，
  // 最小化半天也不降档。
  //
  // **上下文边界（自审修正）**：弹窗是独立 WebView，本 store 是弹窗自己
  // 那份——主窗口的聚合看不到这条上报。跨窗口聚合并不存在；行为仍正确是
  // 因为主窗口对弹出标签只渲染占位符（不挂 TerminalView），没有消费方。
  // 弹窗自己的降档/休眠在本上下文内自洽（owner 聚合只有 popup 一路）。
  useEffect(() => {
    const tabId = tabData?.tabId;
    if (!tabId) return;
    const { reportView, removeView } = useTabViewStateStore.getState();

    const sync = () => {
      const hidden = document.visibilityState === "hidden";
      reportView(tabId, "popup", hidden ? "hidden" : document.hasFocus() ? "active" : "visible");
    };
    sync();

    document.addEventListener("visibilitychange", sync);
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      removeView(tabId, "popup");
    };
  }, [tabData?.tabId]);

  const handleSessionCreated = useCallback(() => {
    sessionCreatedRef.current = true;
  }, []);

  if (error) {
    return (
      <div style={{ color: "var(--app-status-danger)", padding: 20, background: "var(--app-terminal-bg)", height: "100vh" }}>
        {error}
      </div>
    );
  }

  if (!tabData) {
    return (
      <div style={{ color: "var(--app-text-tertiary)", padding: 20, background: "var(--app-terminal-bg)", height: "100vh" }}>
        Loading...
      </div>
    );
  }


  return (
    <div className="h-screen w-screen overflow-hidden" style={{ background: "var(--app-terminal-bg)" }}>
      <TerminalView
        sessionId={tabData.sessionId}
        projectPath={tabData.projectPath}
        visibilityOwnerId={tabData.tabId}
        viewRole="popup"
        isActive={true}
        workspaceName={tabData.workspaceName}
        providerId={tabData.providerId}
        modelId={tabData.modelId}
        providerSelection={tabData.providerSelection}
        launchProfileId={tabData.launchProfileId}
        workspacePath={tabData.workspacePath}
        onSessionCreated={handleSessionCreated}
      />
    </div>
  );
}
