/**
 * 弹出终端窗口 — 独立系统窗口中的纯终端视图
 */

import { useEffect, useCallback, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import TerminalView from "@/components/panes/TerminalView";
import type { PopupTabData } from "@/services/popupWindowService";

interface PopupTerminalWindowProps {
  tabData: PopupTabData;
}

export default function PopupTerminalWindow({ tabData }: PopupTerminalWindowProps) {
  const sessionCreatedRef = useRef(false);

  // 窗口关闭前通知主窗口回收标签
  useEffect(() => {
    const currentWindow = getCurrentWindow();
    const unlisten = currentWindow.onCloseRequested(async () => {
      await emit("popup-terminal-reclaim", {
        tabId: tabData.tabId,
        paneId: tabData.paneId,
        sessionId: tabData.sessionId,
      });
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [tabData.tabId, tabData.paneId, tabData.sessionId]);

  // 设置窗口标题
  useEffect(() => {
    const currentWindow = getCurrentWindow();
    currentWindow.setTitle(tabData.title || "Terminal").catch(console.error);
  }, [tabData.title]);

  const handleSessionCreated = useCallback(() => {
    sessionCreatedRef.current = true;
  }, []);

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
