/**
 * 弹出终端窗口 — 独立系统窗口中的纯终端视图
 * tabData 通过 Rust PopupDataStore（IPC）获取，避免 URL 传递大 JSON
 */

import { useEffect, useCallback, useRef, useState } from "react";
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

  const handleSessionCreated = useCallback(() => {
    sessionCreatedRef.current = true;
  }, []);

  if (error) {
    return (
      <div style={{ color: "#ef4444", padding: 20, background: "#1a1a1a", height: "100vh" }}>
        {error}
      </div>
    );
  }

  if (!tabData) {
    return (
      <div style={{ color: "#888", padding: 20, background: "#1a1a1a", height: "100vh" }}>
        Loading...
      </div>
    );
  }

  return (
    <div className="h-screen w-screen overflow-hidden" style={{ background: "#1a1a1a" }}>
      <TerminalView
        sessionId={tabData.sessionId}
        projectPath={tabData.projectPath}
        isActive={true}
        workspaceName={tabData.workspaceName}
        providerId={tabData.providerId}
        workspacePath={tabData.workspacePath}
        onSessionCreated={handleSessionCreated}
      />
    </div>
  );
}
