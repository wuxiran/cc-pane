import { useState, useMemo, useEffect, useCallback, useRef, memo, useContext } from "react";
import { X, Terminal } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { handleErrorSilent } from "@/utils";
import type { Panel as PanelType, Tab } from "@/types";
import { useShallow } from "zustand/react/shallow";
import { useDialogStore, usePanesStore, useFullscreenStore, useFileTreeStore, useWorkspacesStore } from "@/stores";
import { terminalService, popOutTab } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import type { PopupTabData } from "@/services/popupWindowService";
import { computeGlobalTabNumbers } from "@/lib/tabNumbering";
import { LayoutVisibilityContext } from "@/contexts/LayoutVisibilityContext";
import { collectTerminalLeaves, collectTerminalSessionIds } from "@/lib/paneSessions";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { collectPanels } from "@/stores/paneTreeHelpers";
import TabBar from "./TabBar";
import PanelEmptyActions from "./PanelEmptyActions";
import TabContentRenderer from "./TabContentRenderer";
import type { TerminalViewHandle } from "./TerminalView";

interface PanelProps {
  pane: PanelType;
}

function findActiveTerminalSessionId(tab: Tab): string | null {
  if (tab.contentType !== "terminal" || !tab.terminalRootPane || !tab.activeTerminalPaneId) {
    return tab.sessionId ?? null;
  }
  const activeLeaf = collectTerminalLeaves(tab.terminalRootPane)
    .find((leaf) => leaf.id === tab.activeTerminalPaneId);
  return activeLeaf?.sessionId ?? null;
}

export default memo(function Panel({ pane }: PanelProps) {
  const { t } = useTranslation("panes");
  const layoutVisible = useContext(LayoutVisibilityContext);

  // Data 选择器：值变化时触发重渲染
  const activePaneId = usePanesStore((s) => s.activePaneId);
  const rootPane = usePanesStore((s) => s.rootPane);
  const allPanels = usePanesStore((s) => s.allPanels);
  const layouts = usePanesStore((s) => s.layouts);
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);
  const workspaces = useWorkspacesStore((s) => s.workspaces);
  const openWorkspaceEnvironment = useDialogStore((s) => s.openWorkspaceEnvironment);

  // Action 选择器合并 + useShallow：浅比较避免对象引用变化导致的重渲染
  const {
    selectTab, closeTab, togglePinTab, toggleStarTab, renameTab, addTab,
    splitRight, splitDown, splitAndMoveTab, splitTerminalPane, closeTerminalPane,
    moveTab, moveTabToLayoutPane,
    closeTabsToLeft, closeTabsToRight, closeOtherTabs,
    setActivePane, updateTabSession, reconnectTab,
    setTabDisconnected, markTabPoppedOut, isTabPoppedOut,
  } = usePanesStore(useShallow((s) => ({
    selectTab: s.selectTab,
    closeTab: s.closeTab,
    togglePinTab: s.togglePinTab,
    toggleStarTab: s.toggleStarTab,
    renameTab: s.renameTab,
    addTab: s.addTab,
    splitRight: s.splitRight,
    splitDown: s.splitDown,
    splitAndMoveTab: s.splitAndMoveTab,
    splitTerminalPane: s.splitTerminalPane,
    closeTerminalPane: s.closeTerminalPane,
    moveTab: s.moveTab,
    moveTabToLayoutPane: s.moveTabToLayoutPane,
    closeTabsToLeft: s.closeTabsToLeft,
    closeTabsToRight: s.closeTabsToRight,
    closeOtherTabs: s.closeOtherTabs,
    setActivePane: s.setActivePane,
    updateTabSession: s.updateTabSession,
    reconnectTab: s.reconnectTab,
    setTabDisconnected: s.setTabDisconnected,
    markTabPoppedOut: s.markTabPoppedOut,
    isTabPoppedOut: s.isTabPoppedOut,
  })));

  // Fullscreen store: action 同样合并
  const isFullscreen = useFullscreenStore((s) => s.isFullscreen);
  const fullscreenPaneId = useFullscreenStore((s) => s.fullscreenPaneId);
  const { enterFullscreen, exitFullscreen } = useFullscreenStore(useShallow((s) => ({
    enterFullscreen: s.enterFullscreen,
    exitFullscreen: s.exitFullscreen,
  })));

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
  const tabNumbers = useMemo(() => computeGlobalTabNumbers(rootPane), [rootPane]);
  const moveTargets = useMemo(() => {
    const panels = allPanels();
    return panels
      .map((p, i) => ({ panel: p, index: i }))
      .filter(({ panel }) => panel.id !== pane.id)
      .map(({ panel, index }) => {
        const activeTitle = panel.tabs.find((tb) => tb.id === panel.activeTabId)?.title ?? "";
        return { id: panel.id, label: `${t("pane")} ${index + 1}${activeTitle ? ` · ${activeTitle}` : ""}` };
      });
  }, [allPanels, rootPane, pane.id, t]);
  const layoutMoveTargets = useMemo(() => {
    return layouts
      .filter((layout) => layout.id !== currentLayoutId && layout.kind !== "starred")
      .map((layout, layoutIndex) => ({
        id: layout.id,
        label: layout.name || `${t("layout")} ${layoutIndex + 1}`,
        panes: collectPanels(layout.rootPane).map((panel, panelIndex) => {
          const activeTitle = panel.tabs.find((tab) => tab.id === panel.activeTabId)?.title ?? "";
          return {
            id: panel.id,
            label: `${t("pane")} ${panelIndex + 1}${activeTitle ? ` · ${activeTitle}` : ""}`,
          };
        }),
      }))
      .filter((layout) => layout.panes.length > 0);
  }, [currentLayoutId, layouts, t]);

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
      if (tab?.contentType === "terminal" && tab.terminalRootPane) {
        const sessionIds = collectTerminalSessionIds(tab);
        sessionIds.forEach((sessionId) => {
          terminalService.killSession(sessionId).catch((e) => handleErrorSilent(e, "kill session"));
        });
      } else if (tab?.sessionId) {
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
              const sessionIds = collectTerminalSessionIds(t);
              sessionIds.forEach((sessionId) => {
                terminalService.killSession(sessionId).catch((e) => handleErrorSilent(e, "kill session"));
              });
            });
            action();
          },
        });
        return;
      }
      tabsToClose.filter((t) => !t.pinned).forEach((t) => {
        const sessionIds = collectTerminalSessionIds(t);
        sessionIds.forEach((sessionId) => {
          terminalService.killSession(sessionId).catch((e) => handleErrorSilent(e, "kill session"));
        });
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

  const handleToggleStar = useCallback(
    (tabId: string) => toggleStarTab(tabId),
    [toggleStarTab]
  );

  const handleRename = useCallback(
    (tabId: string, newTitle: string) => renameTab(pane.id, tabId, newTitle),
    [pane.id, renameTab]
  );

  const handleAddTab = useCallback(
    () => addTab(pane.id, {
      projectId: "",
      projectPath: "",
      workspaceName: activeTab?.workspaceName,
      providerId: activeTab?.providerId,
      providerSelection: activeTab?.providerSelection,
      launchProfileId: activeTab?.launchProfileId,
      workspacePath: activeTab?.workspacePath,
    }),
    [pane.id, addTab, activeTab?.workspaceName, activeTab?.providerId, activeTab?.providerSelection, activeTab?.launchProfileId, activeTab?.workspacePath]
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

  const handleMoveTabToPane = useCallback(
    (tabId: string, targetPaneId: string) => moveTab(pane.id, targetPaneId, tabId),
    [pane.id, moveTab]
  );

  const handleMoveTabToLayoutPane = useCallback(
    (tabId: string, targetLayoutId: string, targetPaneId: string) =>
      moveTabToLayoutPane(pane.id, targetLayoutId, tabId, targetPaneId),
    [pane.id, moveTabToLayoutPane]
  );

  const handleSplitTerminalRight = useCallback((tabId: string) => {
    const tab = pane.tabs.find((item) => item.id === tabId);
    if (tab?.contentType !== "terminal" || !tab.activeTerminalPaneId) return;
    splitTerminalPane(tabId, tab.activeTerminalPaneId, "right");
  }, [pane.tabs, splitTerminalPane]);

  const handleSplitTerminalDown = useCallback((tabId: string) => {
    const tab = pane.tabs.find((item) => item.id === tabId);
    if (tab?.contentType !== "terminal" || !tab.activeTerminalPaneId) return;
    splitTerminalPane(tabId, tab.activeTerminalPaneId, "down");
  }, [pane.tabs, splitTerminalPane]);

  const handleCloseTerminalPane = useCallback((tabId: string) => {
    const tab = pane.tabs.find((item) => item.id === tabId);
    if (tab?.contentType !== "terminal" || !tab.activeTerminalPaneId) return;
    const activeLeaf = tab.terminalRootPane
      ? findActiveTerminalSessionId(tab)
      : null;
    if (activeLeaf) {
      terminalService.killSession(activeLeaf).catch((e) => handleErrorSilent(e, "kill session"));
    }
    closeTerminalPane(tabId, tab.activeTerminalPaneId);
  }, [closeTerminalPane, pane.tabs]);

  const handleFullscreen = useCallback(
    (tabId: string) => enterFullscreen(pane.id, tabId),
    [pane.id, enterFullscreen]
  );

  const handleToggleFullscreen = useCallback(
    (tabId: string) => {
      if (isFullscreenPanel) {
        exitFullscreen();
      } else {
        enterFullscreen(pane.id, tabId);
      }
    },
    [isFullscreenPanel, exitFullscreen, enterFullscreen, pane.id]
  );

  // 克隆终端：同目录/同 CLI 配置在本窗格再开一个标签（全新会话，不共享 PTY）。
  const handleCloneTab = useCallback(
    (tab: Tab) => {
      if (tab.contentType !== "terminal" || !tab.projectPath) return;
      addTab(pane.id, {
        projectId: tab.projectId,
        projectPath: tab.projectPath,
        workspaceName: tab.workspaceName,
        providerId: tab.providerId,
        providerSelection: tab.providerSelection,
        launchProfileId: tab.launchProfileId,
        workspacePath: tab.workspacePath,
        workspaceSnapshotId: tab.workspaceSnapshotId,
        cliTool: tab.cliTool ?? (tab.launchClaude ? "claude" : undefined),
        ssh: tab.ssh,
        wsl: tab.wsl,
        machineName: tab.machineName,
      });
    },
    [pane.id, addTab]
  );

  const handleSessionCreated = useCallback(
    (tabId: string, sessionId: string, terminalPaneId?: string) =>
      updateTabSession(pane.id, tabId, sessionId, terminalPaneId),
    [pane.id, updateTabSession]
  );

  /** SSH 终端退出时标记 Tab 为断连状态 */
  const handleSessionExited = useCallback(
    (tabId: string, _exitCode: number, terminalPaneId?: string) => {
      const tab = pane.tabs.find((t) => t.id === tabId);
      if (tab?.ssh) {
        setTabDisconnected(pane.id, tabId, true, terminalPaneId);
      }
    },
    [pane.id, pane.tabs, setTabDisconnected]
  );

  /** SSH 断线重连：从 Tab 数据重建 session */
  const handleReconnect = useCallback(
    (tabId: string, terminalPaneId?: string) => reconnectTab(pane.id, tabId, terminalPaneId),
    [pane.id, reconnectTab]
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

  const getWorkspaceForTab = useCallback((tab: Tab) => {
    if (tab.workspaceName) {
      return workspaces.find((workspace) => workspace.name === tab.workspaceName);
    }

    if (!tab.projectPath) return undefined;
    const normalizedTabPath = tab.projectPath.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    return workspaces.find((workspace) =>
      workspace.path?.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === normalizedTabPath
      || workspace.projects.some((project) =>
        project.path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase() === normalizedTabPath
      )
    );
  }, [workspaces]);

  const canEditWorkspaceEnvironment = useCallback(
    (tab: Tab) => Boolean(getWorkspaceForTab(tab)),
    [getWorkspaceForTab],
  );

  const handleEditWorkspaceEnvironment = useCallback((tab: Tab) => {
    const workspace = getWorkspaceForTab(tab);
    if (!workspace) return;
    openWorkspaceEnvironment(workspace.id);
  }, [getWorkspaceForTab, openWorkspaceEnvironment]);

  // 弹出标签为独立窗口
  const handlePopOutTab = useCallback(
    async (tabId: string) => {
      const tab = pane.tabs.find((t) => t.id === tabId);
      const sessionId = tab ? findActiveTerminalSessionId(tab) : null;
      if (!tab || tab.contentType !== "terminal" || !sessionId) return;
      if (isTabPoppedOut(tabId)) return;
      const data: PopupTabData = {
        tabId,
        paneId: pane.id,
        sessionId,
        projectPath: tab.projectPath,
        title: tab.title,
        workspaceName: tab.workspaceName,
        providerId: tab.providerId,
        providerSelection: tab.providerSelection,
        launchProfileId: tab.launchProfileId,
        workspacePath: tab.workspacePath,
      };
      try {
        // 先创建弹出窗口，成功后再断开主窗口 + 标记弹出
        await popOutTab(data);
        terminalService.detachOutput(sessionId);
        terminalService.detachExit(sessionId);
        markTabPoppedOut(tabId);
      } catch (err) {
        console.error("Failed to pop out tab:", err);
        toast.error(`弹出窗口失败: ${String(err)}`);
      }
    },
    [pane.id, pane.tabs, markTabPoppedOut]
  );

  // 保存 terminal ref
  const setTerminalRef = useCallback((tabKey: string, ref: TerminalViewHandle | null) => {
    if (ref) {
      terminalRefs.current.set(tabKey, ref);
    } else {
      terminalRefs.current.delete(tabKey);
    }
  }, []);

  // Notch 浮动布局：标签栏高度计算
  const TAB_BAR_HEIGHT = { normal: 38, compact: 30, dense: 26 } as const;
  const density = pane.tabs.length <= 3 ? 'normal' : pane.tabs.length <= 6 ? 'compact' : 'dense';
  const tabBarHeight = TAB_BAR_HEIGHT[density];

  return (
    <div
      data-pane-id={pane.id}
      className={`flex w-full min-w-0 min-h-0 flex-col h-full overflow-hidden transition-shadow duration-[var(--dur)] ${
        isFullscreenPanel ? "fixed inset-0 z-[9999]" : ""
      }`}
      style={{
        background: "var(--app-panel-bg)",
        backdropFilter: `blur(var(--app-glass-blur))`,
        WebkitBackdropFilter: `blur(var(--app-glass-blur))`,
        // 激活 pane:subtle accent 内环,一眼分清焦点
        boxShadow: isActivePane
          ? "inset 0 0 0 1px color-mix(in srgb, var(--app-accent) 20%, transparent)"
          : "inset 0 0 0 1px transparent",
      }}
      onClick={handlePanelClick}
    >
      {/* 内容区 + 浮动标签栏 (Notch 布局) */}
      <div
        className="relative min-h-0 min-w-0 flex-1 overflow-hidden"
        style={{ '--notch-bar-height': `${tabBarHeight}px` } as React.CSSProperties}
      >
        {/* 浮动标签栏 */}
        <div className="absolute top-0 left-0 right-0 z-10">
          <TabBar
            paneId={pane.id}
            tabs={pane.tabs}
            activeId={pane.activeTabId}
            tabNumbers={tabNumbers}
            onSelect={handleSelectTab}
            onClose={handleCloseTab}
            onTogglePin={handleTogglePin}
            onToggleStar={handleToggleStar}
            onRename={handleRename}
            onAdd={handleAddTab}
            onSplitRight={handleSplitRight}
            onSplitDown={handleSplitDown}
            onFullscreen={handleFullscreen}
            onSplitAndMoveRight={handleSplitAndMoveRight}
            onSplitAndMoveDown={handleSplitAndMoveDown}
            moveTargets={moveTargets}
            onMoveTabToPane={handleMoveTabToPane}
            layoutMoveTargets={layoutMoveTargets}
            onMoveTabToLayoutPane={handleMoveTabToLayoutPane}
            onSplitTerminalRight={handleSplitTerminalRight}
            onSplitTerminalDown={handleSplitTerminalDown}
            onCloseTerminalPane={handleCloseTerminalPane}
            onCloseTabsToLeft={handleCloseTabsToLeft}
            onCloseTabsToRight={handleCloseTabsToRight}
            onCloseOtherTabs={handleCloseOtherTabs}
            onRevealInExplorer={handleRevealInExplorer}
            onPopOutTab={isTauriRuntime() ? handlePopOutTab : undefined}
            canEditWorkspaceEnvironment={canEditWorkspaceEnvironment}
            onEditWorkspaceEnvironment={handleEditWorkspaceEnvironment}
            onCloneTab={handleCloneTab}
            onToggleFullscreen={handleToggleFullscreen}
            isPaneFullscreen={isFullscreenPanel}
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
              isVisible={layoutVisible && tab.id === pane.activeTabId}
              isActive={layoutVisible && tab.id === pane.activeTabId && isActivePane}
              layoutActive={layoutVisible}
              paneId={pane.id}
              isPoppedOut={isTabPoppedOut(tab.id)}
              onSessionCreated={(sid, terminalPaneId) => handleSessionCreated(tab.id, sid, terminalPaneId)}
              onSessionExited={(code, terminalPaneId) => handleSessionExited(tab.id, code, terminalPaneId)}
              onTerminalRef={(terminalPaneId, ref) => setTerminalRef(`${tab.id}:${terminalPaneId}`, ref)}
              onReconnect={tab.ssh ? (terminalPaneId) => handleReconnect(tab.id, terminalPaneId) : undefined}
            />
          </div>
        ))}

        {/* 空状态 — 深色背景与终端一致，确保毛玻璃标签可见 */}
        {(!activeTab || !activeTab.projectPath) && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center select-none overflow-hidden"
            style={{ background: "var(--app-panel-bg)", paddingTop: tabBarHeight }}
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
              className="relative w-20 h-20 rounded-2xl flex items-center justify-center mb-6 transition-transform duration-700"
              style={{
                background: "color-mix(in srgb, var(--app-accent) 8%, var(--app-hover))",
                border: "1px solid var(--app-border)",
                boxShadow: "var(--sh-md), var(--hi)",
              }}
            >
              <Terminal className="w-9 h-9" style={{ color: "var(--app-accent)", opacity: 0.85 }} />
            </div>

            <h3 className="text-lg font-semibold mb-2 tracking-tight" style={{ color: "var(--app-text-primary)" }}>
              {t("ready")}
            </h3>
            <p className="text-center max-w-sm leading-relaxed text-[13px]" style={{ color: "var(--app-text-tertiary)" }}>
              {t("selectProject")}
            </p>
            <PanelEmptyActions />
          </div>
        )}
      </div>

      {/* 全屏退出按钮 */}
      {isFullscreenPanel && (
        <div
          className="fixed top-4 right-4 z-[10000] flex items-center gap-2 px-4 py-2 rounded-lg cursor-pointer transition-colors duration-[var(--dur-fast)] hover:text-[var(--app-text-primary)]"
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
