/**
 * 弹出终端窗口 — 独立系统窗口中的纯终端视图
 * tabData 通过 Rust PopupDataStore（IPC）获取，避免 URL 传递大 JSON
 */

import { useEffect, useCallback, useRef, useState } from "react";
import { useTabViewStateStore } from "@/stores/useTabViewStateStore";
import { getCurrentWindow } from "@tauri-apps/api/window";
import TerminalView, { type TerminalViewHandle } from "@/components/panes/TerminalView";
import { AppToaster } from "@/components/ui/toast";
import { getPopupTabData } from "@/services/popupWindowService";
import type { PopupTabData } from "@/services/popupWindowService";
import { hideQuickTerminal, reportQuickTerminalSession } from "@/services/quickTerminalService";
import { settingsService } from "@/services/settingsService";

export default function PopupTerminalWindow() {
  const sessionCreatedRef = useRef(false);
  const terminalHandleRef = useRef<TerminalViewHandle>(null);
  const [tabData, setTabData] = useState<PopupTabData | null>(null);
  const [error, setError] = useState<string | null>(null);
  // F1 快捷终端（docs/105）：tabData.mode === "quick" 时为 Quake 式下拉窗口，
  // 额外行为：自动聚焦输入、失焦自动收起（受设置 autoHideOnBlur 控制）。
  const isQuick = tabData?.mode === "quick";

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

  // 上报真实可见性。此前弹窗只传 isActive={true}，经 TerminalView 的
  // `isVisible ?? isActive` 回退变成永久自认可见——积压/降档/休眠全不生效，
  // 最小化半天也不降档。
  //
  // **上下文边界**：弹窗是独立 WebView，本 store 是弹窗自己
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

  const handleSessionCreated = useCallback(
    (sessionId: string) => {
      sessionCreatedRef.current = true;
      // 快捷终端：会话建好后把光标送进终端（Quake 式呼出即可输入）
      if (isQuick) {
        requestAnimationFrame(() => terminalHandleRef.current?.focus());
      }
      // F1.4：把「这条会话住在快捷窗口里」登记到后端，主窗口才能定位到它的通知。
      // 带上 projectPath/title：接管建 tab 时需要，而这条会话不进 savedSessions。
      // 失败不阻断：登记的唯一作用是通知定位与接管，丢了不影响终端本身。
      if (isQuick && sessionId) {
        void reportQuickTerminalSession({
          sessionId,
          projectPath: tabData?.projectPath ?? "",
          title: tabData?.title,
        }).catch(console.error);
      }
    },
    [isQuick, tabData?.projectPath, tabData?.title],
  );

  // F1.4：快捷终端里的 shell 退出后清登记，否则主窗口会继续把已死会话
  // 当成「住在快捷窗口」，通知的「聚焦会话」点了只能唤出一个空窗口。
  // 窗口被关闭/销毁的路径由后端清（lib.rs CloseRequested 与 destroy_quick_terminal），
  // 这里只负责会话自己结束这一种。
  const handleSessionExited = useCallback(() => {
    if (!isQuick) return;
    void reportQuickTerminalSession(null).catch(console.error);
  }, [isQuick]);

  // 快捷终端：窗口每次可见/获焦时聚焦终端（热键 toggle 唤出、点击窗口）。
  useEffect(() => {
    if (!isQuick) return;
    const focusTerminal = () => terminalHandleRef.current?.focus();
    document.addEventListener("visibilitychange", focusTerminal);
    window.addEventListener("focus", focusTerminal);
    return () => {
      document.removeEventListener("visibilitychange", focusTerminal);
      window.removeEventListener("focus", focusTerminal);
    };
  }, [isQuick]);

  // 快捷终端：失焦自动收起（autoHideOnBlur，默认开）。读设置判定；
  // 设置读不到时不回退隐藏，避免误藏用户正在用的窗口。
  useEffect(() => {
    if (!isQuick) return;
    let cancelled = false;
    let autoHide = false;
    void settingsService
      .getSettings()
      .then((s) => {
        if (!cancelled) autoHide = s.quickTerminal?.autoHideOnBlur ?? false;
      })
      .catch(() => {});
    const onBlur = () => {
      if (!autoHide) return;
      // 瞬时失焦（窗口内部子元素抢焦）不算；确认真失焦后再藏。
      setTimeout(() => {
        if (document.hasFocus()) return;
        void hideQuickTerminal().catch(console.error);
      }, 120);
    };
    window.addEventListener("blur", onBlur);
    return () => {
      cancelled = true;
      window.removeEventListener("blur", onBlur);
    };
  }, [isQuick]);

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
      {/* 弹出窗口是独立 WebView：不挂 toaster 的话，右键「清空缓冲区」那条带确认按钮的提示显示不出来。 */}
      <AppToaster />
      <TerminalView
        ref={isQuick ? terminalHandleRef : undefined}
        sessionId={tabData.sessionId}
        projectPath={tabData.projectPath}
        visibilityOwnerId={tabData.tabId}
        viewRole="popup"
        leafFocused
        workspaceName={tabData.workspaceName}
        providerId={tabData.providerId}
        providerAccountId={tabData.providerAccountId}
        modelId={tabData.modelId}
        providerSelection={tabData.providerSelection}
        launchProfileId={tabData.launchProfileId}
        workspacePath={tabData.workspacePath}
        cliTool={tabData.cliTool}
        launchClaude={tabData.launchClaude}
        onSessionCreated={handleSessionCreated}
        onSessionExited={handleSessionExited}
      />
    </div>
  );
}
