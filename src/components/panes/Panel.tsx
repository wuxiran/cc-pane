import { useState, useMemo, useEffect, useCallback, useRef, memo } from "react";
import { X, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { handleErrorSilent } from "@/utils";
import type { Panel as PanelType, Tab } from "@/types";
import { usePanesStore, useFullscreenStore, useFileTreeStore } from "@/stores";
import { terminalService, popOutTab } from "@/services";
import type { PopupTabData } from "@/services/popupWindowService";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import TabBar from "./TabBar";
import TabContentRenderer from "./TabContentRenderer";
import type { TerminalViewHandle } from "./TerminalView";

interface PanelProps {
  pane: PanelType;
}

export default memo(function Panel({ pane }: PanelProps) {
  const { t } = useTranslation("panes");
  const activePaneId = usePanesStore((s) => s.activePaneId);
  const selectTab = usePanesStore((s) => s.selectTab);
  const closeTab = usePanesStore((s) => s.closeTab);
  const togglePinTab = usePanesStore((s) => s.togglePinTab);
  const renameTab = usePanesStore((s) => s.renameTab);
  const addTab = usePanesStore((s) => s.addTab);
  const splitRight = usePanesStore((s) => s.splitRight);
  const splitDown = usePanesStore((s) => s.splitDown);
  const splitAndMoveTab = usePanesStore((s) => s.splitAndMoveTab);
  const closeTabsToLeft = usePanesStore((s) => s.closeTabsToLeft);
  const closeTabsToRight = usePanesStore((s) => s.closeTabsToRight);
  const closeOtherTabs = usePanesStore((s) => s.closeOtherTabs);
  const setActivePane = usePanesStore((s) => s.setActivePane);
  const updateTabSession = usePanesStore((s) => s.updateTabSession);
  const markTabPoppedOut = usePanesStore((s) => s.markTabPoppedOut);
  const isTabPoppedOut = usePanesStore((s) => s.isTabPoppedOut);

  const isFullscreen = useFullscreenStore((s) => s.isFullscreen);
  const fullscreenPaneId = useFullscreenStore((s) => s.fullscreenPaneId);
  const enterFullscreen = useFullscreenStore((s) => s.enterFullscreen);
  const exitFullscreen = useFullscreenStore((s) => s.exitFullscreen);

  const terminalRefs = useRef<Map<string, TerminalViewHandle>>(new Map());

  // Dirty tab 确认状态
  const [dirtyConfirmTabId, setDirtyConfirmTabId] = useState<string | null>(null);
  const [dirtyConfirmBatch, setDirtyConfirmBatch] = useState<{
    tabIds: string[];
    action: () => void;
  } | null>(null);

  const isActivePane = activePaneId === pane.id;
  const isFullscreenPanel = isFullscreen && fullscreenPaneId === pane.id;

  const activeTab = useMemo(
    () => pane.tabs.find((t) => t.id === pane.activeTabId),
    [pane.tabs, pane.activeTabId]
  );

  // 全屏时 ESC 退出
  useEffect(() => {
    function handleKeydown(e: KeyboardEvent) {
      if (isFullscreenPanel && e.key === "Escape") {
        e.preventDefault();
        exitFullscreen();
      }
    }
    document.addEventListener("keydown", handleKeydown);
    return () => document.removeEventListener("keydown", handleKeydown);
  }, [isFullscreenPanel, exitFullscreen]);

  const handleSelectTab = useCallback(
    (tabId: string) => selectTab(pane.id, tabId),
    [pane.id, selectTab]
  );

  // 执行单个 tab 关闭（不检查 dirty）
  const doCloseTab = useCallback(
    (tabId: string) => {
      const tab = pane.tabs.find((t) => t.id === tabId);
      if (tab?.sessionId) {
        terminalService.killSession(tab.sessionId).catch((e) => handleErrorSilent(e, "kill session"));
      }
      closeTab(pane.id, tabId);
    },
    [pane.id, pane.tabs, closeTab]
  );

  // 关闭 tab（检查 dirty）
  const handleCloseTab = useCallback(
    (tabId: string) => {
      const tab = pane.tabs.find((t) => t.id === tabId);
      if (!tab || tab.pinned) return;
      if (tab.dirty) {
        setDirtyConfirmTabId(tabId);
        return;
      }
      doCloseTab(tabId);
    },
    [pane.tabs, doCloseTab]
  );

  // 确认关闭 dirty tab
  const handleConfirmCloseDirty = useCallback(() => {
    if (dirtyConfirmTabId) {
      doCloseTab(dirtyConfirmTabId);
      setDirtyConfirmTabId(null);
    }
  }, [dirtyConfirmTabId, doCloseTab]);

  // 批量关闭辅助：检查是否有 dirty tabs，有则弹确认
  const doBatchClose = useCallback(
    (tabsToClose: typeof pane.tabs, action: () => void) => {
      const dirtyTabs = tabsToClose.filter((t) => t.dirty && !t.pinned);
      if (dirtyTabs.length > 0) {
        setDirtyConfirmBatch({
          tabIds: dirtyTabs.map((t) => t.id),
          action: () => {
            tabsToClose.filter((t) => !t.pinned).forEach((t) => {
              if (t.sessionId) terminalService.killSession(t.sessionId).catch((e) => handleErrorSilent(e, "kill session"));
            });
            action();
          },
        });
        return;
      }
      tabsToClose.filter((t) => !t.pinned).forEach((t) => {
        if (t.sessionId) terminalService.killSession(t.sessionId).catch((e) => handleErrorSilent(e, "kill session"));
      });
      action();
    },
    []
  );

  // 确认批量关闭
  const handleConfirmBatchClose = useCallback(() => {
    if (dirtyConfirmBatch) {
      dirtyConfirmBatch.action();
      setDirtyConfirmBatch(null);
    }
  }, [dirtyConfirmBatch]);

  const handleCloseTabsToLeft = useCallback(
    (tabId: string) => {
      const targetIdx = pane.tabs.findIndex((t) => t.id === tabId);
      const tabsToClose = pane.tabs.slice(0, targetIdx);
      doBatchClose(tabsToClose, () => closeTabsToLeft(pane.id, tabId));
    },
    [pane.id, pane.tabs, closeTabsToLeft, doBatchClose]
  );

  const handleCloseTabsToRight = useCallback(
    (tabId: string) => {
      const targetIdx = pane.tabs.findIndex((t) => t.id === tabId);
      const tabsToClose = pane.tabs.slice(targetIdx + 1);
      doBatchClose(tabsToClose, () => closeTabsToRight(pane.id, tabId));
    },
    [pane.id, pane.tabs, closeTabsToRight, doBatchClose]
  );

  const handleCloseOtherTabs = useCallback(
    (tabId: string) => {
      const tabsToClose = pane.tabs.filter((t) => t.id !== tabId);
      doBatchClose(tabsToClose, () => closeOtherTabs(pane.id, tabId));
    },
    [pane.id, pane.tabs, closeOtherTabs, doBatchClose]
  );

  const handleTogglePin = useCallback(
    (tabId: string) => togglePinTab(pane.id, tabId),
    [pane.id, togglePinTab]
  );

  const handleRename = useCallback(
    (tabId: string, newTitle: string) => renameTab(pane.id, tabId, newTitle),
    [pane.id, renameTab]
  );

  const handleAddTab = useCallback(
    () => addTab(pane.id, "", ""),
    [pane.id, addTab]
  );

  const handleSplitRight = useCallback(
    () => splitRight(pane.id),
    [pane.id, splitRight]
  );

  const handleSplitDown = useCallback(
    () => splitDown(pane.id),
    [pane.id, splitDown]
  );

  const handleSplitAndMoveRight = useCallback(
    (tabId: string) => splitAndMoveTab(pane.id, tabId, "right"),
    [pane.id, splitAndMoveTab]
  );

  const handleSplitAndMoveDown = useCallback(
    (tabId: string) => splitAndMoveTab(pane.id, tabId, "down"),
    [pane.id, splitAndMoveTab]
  );

  const handleFullscreen = useCallback(
    (tabId: string) => enterFullscreen(pane.id, tabId),
    [pane.id, enterFullscreen]
  );

  const handleSessionCreated = useCallback(
    (tabId: string, sessionId: string) => updateTabSession(pane.id, tabId, sessionId),
    [pane.id, updateTabSession]
  );

  const handlePanelClick = useCallback(
    () => setActivePane(pane.id),
    [pane.id, setActivePane]
  );

  const handleRevealInExplorer = useCallback(
    (tab: Tab) => {
      if (tab.contentType === "editor" && tab.filePath && tab.projectPath) {
        useFileTreeStore.getState().revealFile(tab.projectPath, tab.filePath);
      }
    },
    []
  );

  // 弹出标签为独立窗口
  const handlePopOutTab = useCallback(
    async (tabId: string) => {
      const tab = pane.tabs.find((t) => t.id === tabId);
      if (!tab || tab.contentType !== "terminal" || !tab.sessionId) return;
      // 先断开主窗口 xterm 输出
      terminalService.detachOutput(tab.sessionId);
      terminalService.detachExit(tab.sessionId);
      // 标记弹出状态
      markTabPoppedOut(tabId);
      // 创建弹出窗口
      const data: PopupTabData = {
        tabId,
        paneId: pane.id,
        sessionId: tab.sessionId,
        projectPath: tab.projectPath,
        title: tab.title,
        workspaceName: tab.workspaceName,
        providerId: tab.providerId,
        workspacePath: tab.workspacePath,
      };
      try {
        await popOutTab(data);
      } catch (err) {
        console.error("Failed to pop out tab:", err);
      }
    },
    [pane.id, pane.tabs, markTabPoppedOut]
  );

  // 保存 terminal ref
  const setTerminalRef = useCallback((tabId: string, ref: TerminalViewHandle | null) => {
    if (ref) {
      terminalRefs.current.set(tabId, ref);
    } else {
      terminalRefs.current.delete(tabId);
    }
  }, []);

  // Notch 浮动布局：标签栏高度计算
  const TAB_BAR_HEIGHT = { normal: 38, compact: 30, dense: 26 } as const;
  const density = pane.tabs.length <= 3 ? 'normal' : pane.tabs.length <= 6 ? 'compact' : 'dense';
  const tabBarHeight = TAB_BAR_HEIGHT[density];

  return (
    <div
      className={`flex flex-col h-full overflow-hidden transition-shadow duration-300 ${
        isFullscreenPanel ? "fixed inset-0 z-[9999]" : ""
      }`}
      style={{
        background: "var(--app-panel-bg)",
        backdropFilter: `blur(var(--app-glass-blur))`,
        WebkitBackdropFilter: `blur(var(--app-glass-blur))`,
      }}
      onClick={handlePanelClick}
    >
      {/* 内容区 + 浮动标签栏 (Notch 布局) */}
      <div
        className="flex-1 relative overflow-hidden"
        style={{ '--notch-bar-height': `${tabBarHeight}px` } as React.CSSProperties}
      >
        {/* 浮动标签栏 */}
        <div className="absolute top-0 left-0 right-0 z-10">
          <TabBar
            paneId={pane.id}
            tabs={pane.tabs}
            activeId={pane.activeTabId}
            onSelect={handleSelectTab}
            onClose={handleCloseTab}
            onTogglePin={handleTogglePin}
            onRename={handleRename}
            onAdd={handleAddTab}
            onSplitRight={handleSplitRight}
            onSplitDown={handleSplitDown}
            onFullscreen={handleFullscreen}
            onSplitAndMoveRight={handleSplitAndMoveRight}
            onSplitAndMoveDown={handleSplitAndMoveDown}
            onCloseTabsToLeft={handleCloseTabsToLeft}
            onCloseTabsToRight={handleCloseTabsToRight}
            onCloseOtherTabs={handleCloseOtherTabs}
            onRevealInExplorer={handleRevealInExplorer}
            onPopOutTab={handlePopOutTab}
          />
        </div>

        {/* Tab 内容（paddingTop 给标签栏留空间） */}
        {pane.tabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{
              display: tab.id === pane.activeTabId ? "flex" : "none",
              flexDirection: "column",
            }}
          >
            <TabContentRenderer
              tab={tab}
              isActive={tab.id === pane.activeTabId && isActivePane}
              paneId={pane.id}
              isPoppedOut={isTabPoppedOut(tab.id)}
              onSessionCreated={(sid) => handleSessionCreated(tab.id, sid)}
              onTerminalRef={(ref) => setTerminalRef(tab.id, ref)}
            />
          </div>
        ))}

        {/* 空状态 — 深色背景与终端一致，确保毛玻璃标签可见 */}
        {(!activeTab || !activeTab.projectPath) && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center select-none overflow-hidden"
            style={{ background: "#1a1a1a", paddingTop: tabBarHeight }}
          >
            {/* 点阵背景 */}
            <div
              className="absolute inset-0 opacity-[0.03]"
              style={{
                backgroundImage: 'radial-gradient(rgba(255,255,255,0.8) 1px, transparent 1px)',
                backgroundSize: '24px 24px',
              }}
            />

            {/* 图标容器 */}
            <div
              className="relative w-28 h-28 rounded-3xl flex items-center justify-center mb-8 transition-transform duration-700"
              style={{
                background: "rgba(255,255,255,0.06)",
                border: "1px solid rgba(255,255,255,0.1)",
              }}
            >
              <Terminal className="w-12 h-12 opacity-80" style={{ color: "rgba(255,255,255,0.3)" }} />
            </div>

            <h3 className="text-xl font-medium mb-3 tracking-tight" style={{ color: "rgba(255,255,255,0.85)" }}>
              {t("ready")}
            </h3>
            <p className="text-center max-w-sm leading-relaxed text-sm" style={{ color: "rgba(255,255,255,0.45)" }}>
              {t("selectProject")}
            </p>
          </div>
        )}
      </div>

      {/* 全屏退出按钮 */}
      {isFullscreenPanel && (
        <div
          className="fixed top-4 right-4 z-[10000] flex items-center gap-2 px-4 py-2 rounded-lg cursor-pointer transition-all hover:text-[var(--app-text-primary)]"
          style={{
            background: "var(--app-overlay)",
            border: "1px solid var(--app-border)",
            color: "var(--app-text-secondary)",
            backdropFilter: "blur(20px)",
            WebkitBackdropFilter: "blur(20px)",
          }}
          onClick={() => exitFullscreen()}
        >
          <X size={20} />
          <span className="text-xs opacity-70">ESC</span>
        </div>
      )}

      {/* Dirty tab 单个关闭确认 */}
      <Dialog open={dirtyConfirmTabId !== null} onOpenChange={() => setDirtyConfirmTabId(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("unsavedChanges")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">{t("unsavedChangesDesc")}</p>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDirtyConfirmTabId(null)}>
              {t("cancel", { ns: "common" })}
            </Button>
            <Button variant="destructive" onClick={handleConfirmCloseDirty}>
              {t("discardAndClose")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Dirty tab 批量关闭确认 */}
      <Dialog open={dirtyConfirmBatch !== null} onOpenChange={() => setDirtyConfirmBatch(null)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("unsavedChanges")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground py-2">
            {t("unsavedTabsCount", { count: dirtyConfirmBatch?.tabIds.length ?? 0 })}
          </p>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDirtyConfirmBatch(null)}>
              {t("cancel", { ns: "common" })}
            </Button>
            <Button variant="destructive" onClick={handleConfirmBatchClose}>
              {t("discardAndClose")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
});
