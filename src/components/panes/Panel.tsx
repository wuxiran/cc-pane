import { useState, useMemo, useEffect, useCallback, useRef, memo } from "react";
import { X, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Panel as PanelType, Tab } from "@/types";
import { usePanesStore, useFullscreenStore, useFileTreeStore } from "@/stores";
import { terminalService } from "@/services";
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
  const reorderTabs = usePanesStore((s) => s.reorderTabs);
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
        terminalService.killSession(tab.sessionId).catch(console.error);
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
              if (t.sessionId) terminalService.killSession(t.sessionId).catch(console.error);
            });
            action();
          },
        });
        return;
      }
      tabsToClose.filter((t) => !t.pinned).forEach((t) => {
        if (t.sessionId) terminalService.killSession(t.sessionId).catch(console.error);
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

  const handleReorder = useCallback(
    (fromIndex: number, toIndex: number) => reorderTabs(pane.id, fromIndex, toIndex),
    [pane.id, reorderTabs]
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

  // 保存 terminal ref
  const setTerminalRef = useCallback((tabId: string, ref: TerminalViewHandle | null) => {
    if (ref) {
      terminalRefs.current.set(tabId, ref);
    } else {
      terminalRefs.current.delete(tabId);
    }
  }, []);

  return (
    <div
      className={`flex flex-col h-full overflow-hidden transition-shadow duration-300 ${
        isFullscreenPanel ? "fixed inset-0 z-[9999] rounded-none" : "rounded-xl"
      }`}
      style={{
        background: "var(--app-panel-bg)",
        backdropFilter: `blur(var(--app-glass-blur))`,
        WebkitBackdropFilter: `blur(var(--app-glass-blur))`,
        boxShadow: `0 0 0 1px var(--app-border), var(--app-glass-shadow)`,
      }}
      onClick={handlePanelClick}
    >
      {/* 标签栏 */}
      <TabBar
        tabs={pane.tabs}
        activeId={pane.activeTabId}
        onSelect={handleSelectTab}
        onClose={handleCloseTab}
        onTogglePin={handleTogglePin}
        onReorder={handleReorder}
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
      />

      {/* 内容区 */}
      <div
        className="flex-1 relative overflow-hidden"
        style={{
          background: "var(--app-panel-bg)",
          borderRadius: isFullscreenPanel ? "0" : "0 0 12px 12px",
        }}
      >
        {pane.tabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{ display: tab.id === pane.activeTabId ? "block" : "none" }}
          >
            <TabContentRenderer
              tab={tab}
              isActive={tab.id === pane.activeTabId && isActivePane}
              paneId={pane.id}
              onSessionCreated={(sid) => handleSessionCreated(tab.id, sid)}
              onTerminalRef={(ref) => setTerminalRef(tab.id, ref)}
            />
          </div>
        ))}

        {/* 空状态 */}
        {(!activeTab || !activeTab.projectPath) && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center select-none overflow-hidden"
            style={{ background: "var(--app-panel-bg)" }}
          >
            {/* 点阵背景 */}
            <div
              className="absolute inset-0 opacity-[0.03]"
              style={{
                backgroundImage: 'radial-gradient(var(--app-text-primary) 1px, transparent 1px)',
                backgroundSize: '24px 24px',
              }}
            />

            {/* 图标容器 */}
            <div
              className="relative w-28 h-28 rounded-3xl flex items-center justify-center mb-8 transition-transform duration-700"
              style={{
                background: "var(--app-hover)",
                border: "1px solid var(--app-border)",
              }}
            >
              <Terminal className="w-12 h-12 opacity-80" style={{ color: "var(--app-text-tertiary)" }} />
            </div>

            <h3 className="text-xl font-medium mb-3 tracking-tight" style={{ color: "var(--app-text-primary)" }}>
              {t("ready")}
            </h3>
            <p className="text-center max-w-sm leading-relaxed text-sm" style={{ color: "var(--app-text-secondary)" }}>
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
