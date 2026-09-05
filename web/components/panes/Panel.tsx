import { useMemo, useEffect, useCallback, useRef, memo, useContext } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { Panel as PanelType, Tab } from "@/types";
import { useShallow } from "zustand/react/shallow";
import {
  useActivityBarStore,
  useDialogStore,
  useFileTreeStore,
  useFullscreenStore,
  useModulePrefsStore,
  usePanesStore,
  useRightDockStore,
  useSshMachineDialogStore,
  useWorkspacesStore,
} from "@/stores";
import { terminalService, popOutTab } from "@/services";
import { isTauriRuntime } from "@/services/runtime";
import type { PopupTabData } from "@/services/popupWindowService";
import { computeGlobalTabNumbers } from "@/lib/tabNumbering";
import { LayoutVisibilityContext } from "@/contexts/LayoutVisibilityContext";
import { collectTerminalLeaves } from "@/lib/paneSessions";
import { collectPanels } from "@/lib/paneTree";
import TabBar from "./TabBar";
import PanelEmptyState from "./PanelEmptyState";
import PaneEdgeDropZones from "./PaneEdgeDropZones";
import TabContentRenderer from "./TabContentRenderer";
import { useTabClosing } from "./useTabClosing";
import { useReportPaneVisibility } from "./useReportPaneVisibility";
import { TabCloseConfirmDialog } from "./TabCloseConfirmDialog";
import { useNewTabActions } from "./useNewTabActions";
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
    selectTab, togglePinTab, toggleStarTab, renameTab, addTab,
    splitAndMoveTab, splitTerminalPane, removeTerminalLeafInternal,
    moveTab, moveTabToLayoutPane,
    setActivePane, updateTabSession, reconnectTab,
    setTabDisconnected, markTabPoppedOut, isTabPoppedOut,
  } = usePanesStore(useShallow((s) => ({
    selectTab: s.selectTab,
    togglePinTab: s.togglePinTab,
    toggleStarTab: s.toggleStarTab,
    renameTab: s.renameTab,
    addTab: s.addTab,
    splitAndMoveTab: s.splitAndMoveTab,
    splitTerminalPane: s.splitTerminalPane,
    removeTerminalLeafInternal: s.removeTerminalLeafInternal,
    moveTab: s.moveTab,
    moveTabToLayoutPane: s.moveTabToLayoutPane,
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

  // 关闭标签（含 pinned 保护、dirty 确认、会话回收）；close-tab 快捷键也走这里
  const {
    handleCloseTab, handleCloseTabsToLeft, handleCloseTabsToRight, handleCloseOtherTabs,
    pendingGuards, cancelPendingClose, confirmPendingClose,
  } = useTabClosing(pane.id, pane.tabs, pane.activeTabId);

  const isActivePane = activePaneId === pane.id;
  const isFullscreenPanel = isFullscreen && fullscreenPaneId === pane.id;
  const showTerminalStatusBar = true;

  // 焦点环只在多窗格布局出现：单窗格/全屏只有一格可见，无歧义不加噪。
  const paneCount = useMemo(() => collectPanels(rootPane).length, [rootPane]);
  const showFocusRing = isActivePane && paneCount > 1 && !isFullscreenPanel;

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
      modelId: activeTab?.modelId,
      providerSelection: activeTab?.providerSelection,
      launchProfileId: activeTab?.launchProfileId,
      workspacePath: activeTab?.workspacePath,
    }),
    [pane.id, addTab, activeTab?.workspaceName, activeTab?.providerId, activeTab?.modelId, activeTab?.providerSelection, activeTab?.launchProfileId, activeTab?.workspacePath]
  );

  const { handleAddBrowser, handleAddDsh, handleAddAgentChat, handleAddFile, handleAddFileExplorer } =
    useNewTabActions(pane.id, activeTab);

  const handleAddSsh = useCallback(() => {
    useSshMachineDialogStore.getState().openAddDialog();
    const sshPreference = useModulePrefsStore.getState().preferences.ssh;
    if (sshPreference.position === "rightDock" && sshPreference.enabled) {
      useRightDockStore.setState({ visible: true, activeView: "ssh" });
      return;
    }
    useActivityBarStore.setState({
      activeView: "ssh",
      sidebarVisible: true,
      appViewMode: "panes",
      orchestrationOverlayOpen: false,
    });
  }, []);

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

  // 可见性双写：props 照旧传，同时写进单源 store。
  useReportPaneVisibility(pane, layoutVisible, isActivePane);

  // 关一格：回收与树操作统一交给 removeTerminalLeafInternal——它按当前树
  // 重新定位该 leaf 并只杀这一格的会话（含 savedSessionId，改道前会漏）。
  const handleCloseTerminalPane = useCallback((tabId: string) => {
    const tab = pane.tabs.find((item) => item.id === tabId);
    if (tab?.contentType !== "terminal" || !tab.activeTerminalPaneId) return;
    removeTerminalLeafInternal(tabId, tab.activeTerminalPaneId, "user-close");
  }, [removeTerminalLeafInternal, pane.tabs]);

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
        modelId: tab.modelId,
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
        modelId: tab.modelId,
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
        toast.error(t("popOutFailed", { error: String(err) }));
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
      className={`relative flex w-full min-w-0 min-h-0 flex-col h-full overflow-hidden ${
        isFullscreenPanel ? "fixed inset-0 z-[9999]" : ""
      }`}
      style={{
        background: "var(--app-panel-bg-effective)",
        backdropFilter: `blur(var(--app-glass-blur))`,
        WebkitBackdropFilter: `blur(var(--app-glass-blur))`,
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
            newTab={{
              onAdd: handleAddTab,
              onAddBrowser: handleAddBrowser,
              onAddDsh: handleAddDsh,
              onAddAgentChat: handleAddAgentChat,
              onAddFile: handleAddFile,
              onAddFileExplorer: handleAddFileExplorer,
              onAddSsh: handleAddSsh,
            }}
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
              layoutActive={layoutVisible}
              showTerminalStatusBar={showTerminalStatusBar}
              paneId={pane.id}
              isPoppedOut={isTabPoppedOut(tab.id)}
              onSessionCreated={(sid, terminalPaneId) => handleSessionCreated(tab.id, sid, terminalPaneId)}
              onSessionExited={(code, terminalPaneId) => handleSessionExited(tab.id, code, terminalPaneId)}
              onTerminalRef={(terminalPaneId, ref) => setTerminalRef(`${tab.id}:${terminalPaneId}`, ref)}
              onReconnect={tab.ssh ? (terminalPaneId) => handleReconnect(tab.id, terminalPaneId) : undefined}
            />
          </div>
        ))}

        {/* 空状态 — 内容与密度分档见 PanelEmptyState.tsx */}
        {(!activeTab || (activeTab.contentType === "terminal" && !activeTab.projectPath)) && (
          <PanelEmptyState pane={pane} tabBarHeight={tabBarHeight} />
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

      {/* 焦点窗格指示：多窗格时给当前 pane 一圈 2px accent 内描边。
          用 overlay 而非容器 boxShadow——不圆角化 pane 背景本身，非焦点窗格
          像素不变；实色 accent + shape 圆角 token 在壁纸半透明底与各主题下
          都清晰，过渡只动 opacity（--dur-fast + --ease-out）。 */}
      <div
        aria-hidden="true"
        data-pane-focus-ring
        className="pointer-events-none absolute inset-0"
        style={{
          borderRadius: "var(--shape-radius-lg, var(--radius))",
          border: "2px solid var(--app-accent)",
          opacity: showFocusRing ? 1 : 0,
          transition: `opacity var(--dur-fast) var(--ease-out)`,
        }}
      />

      {/* 关闭确认：agent 忙碌 / 编辑器未保存，条目由 planTabDestroy 聚合 */}
      <TabCloseConfirmDialog
        guards={pendingGuards}
        onCancel={cancelPendingClose}
        onConfirm={confirmPendingClose}
      />

      {/* 拖拽落边分屏的落点条 + 半格预览（仅拖拽 tab 期间渲染） */}
      <PaneEdgeDropZones paneId={pane.id} />
    </div>
  );
});
