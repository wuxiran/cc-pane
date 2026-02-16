import { useMemo, useEffect, useCallback, useRef } from "react";
import { X, Terminal, Command } from "lucide-react";
import type { Panel as PanelType } from "@/types";
import { usePanesStore, useFullscreenStore, useThemeStore } from "@/stores";
import TabBar from "./TabBar";
import TerminalView from "./TerminalView";
import type { TerminalViewHandle } from "./TerminalView";

interface PanelProps {
  pane: PanelType;
}

export default function Panel({ pane }: PanelProps) {
  const activePaneId = usePanesStore((s) => s.activePaneId);
  const selectTab = usePanesStore((s) => s.selectTab);
  const closeTab = usePanesStore((s) => s.closeTab);
  const togglePinTab = usePanesStore((s) => s.togglePinTab);
  const reorderTabs = usePanesStore((s) => s.reorderTabs);
  const renameTab = usePanesStore((s) => s.renameTab);
  const addTab = usePanesStore((s) => s.addTab);
  const splitRight = usePanesStore((s) => s.splitRight);
  const splitDown = usePanesStore((s) => s.splitDown);
  const setActivePane = usePanesStore((s) => s.setActivePane);
  const updateTabSession = usePanesStore((s) => s.updateTabSession);

  const isDark = useThemeStore((s) => s.isDark);
  const isFullscreen = useFullscreenStore((s) => s.isFullscreen);
  const fullscreenPaneId = useFullscreenStore((s) => s.fullscreenPaneId);
  const enterFullscreen = useFullscreenStore((s) => s.enterFullscreen);
  const exitFullscreen = useFullscreenStore((s) => s.exitFullscreen);

  const terminalRefs = useRef<Map<string, TerminalViewHandle>>(new Map());

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

  const handleCloseTab = useCallback(
    (tabId: string) => closeTab(pane.id, tabId),
    [pane.id, closeTab]
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
      className={`flex flex-col h-full overflow-hidden transition-all duration-300 backdrop-blur-2xl ${
        isFullscreenPanel ? "fixed inset-0 z-[9999] rounded-none" : "rounded-xl"
      } ${
        isDark
          ? 'bg-[#0F1117]/80 ring-1 ring-white/10 shadow-2xl'
          : 'bg-white/60 ring-1 ring-white/60 shadow-[0_8px_32px_rgba(31,38,135,0.1)]'
      }`}
      style={{
        boxShadow: isActivePane
          ? isDark
            ? "0 0 0 1px rgba(59,130,246,0.4), 0 0 20px rgba(59,130,246,0.1)"
            : "0 0 0 1px rgba(59,130,246,0.3), 0 8px 32px rgba(31,38,135,0.1)"
          : isDark
            ? "0 8px 32px rgba(0,0,0,0.25)"
            : "0 8px 32px rgba(31,38,135,0.1)",
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
      />

      {/* 内容区 */}
      <div
        className="flex-1 relative overflow-hidden"
        style={{
          background: isDark ? "#1a1a1a" : "#ffffff",
          borderRadius: isFullscreenPanel ? "0" : "0 0 12px 12px",
        }}
      >
        {pane.tabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{ display: tab.id === pane.activeTabId ? "block" : "none" }}
          >
            {tab.contentType === "terminal" && tab.projectPath && (
              <TerminalView
                ref={(ref) => setTerminalRef(tab.id, ref)}
                sessionId={tab.sessionId}
                projectPath={tab.projectPath}
                isActive={tab.id === pane.activeTabId && isActivePane}
                resumeId={tab.resumeId}
                workspaceName={tab.workspaceName}
                providerId={tab.providerId}
                onSessionCreated={(sid) => handleSessionCreated(tab.id, sid)}
              />
            )}
          </div>
        ))}

        {/* 空状态 */}
        {activeTab && !activeTab.projectPath && (
          <div className={`absolute inset-0 flex flex-col items-center justify-center select-none relative overflow-hidden ${
            isDark ? 'bg-[#0F1117]' : 'bg-white/80'
          }`}>
            {/* 点阵背景 */}
            <div
              className="absolute inset-0 opacity-[0.03]"
              style={{
                backgroundImage: isDark
                  ? 'radial-gradient(#ffffff 1px, transparent 1px)'
                  : 'radial-gradient(#000000 1px, transparent 1px)',
                backgroundSize: '24px 24px',
              }}
            />

            {/* 图标容器 */}
            <div className={`relative w-28 h-28 rounded-3xl flex items-center justify-center mb-8 transition-transform duration-700 backdrop-blur-sm ${
              isDark
                ? 'bg-slate-800/30 border border-white/5 shadow-inner'
                : 'bg-white/40 border border-white/50 shadow-lg'
            }`}>
              <Terminal className="w-12 h-12 text-slate-500 opacity-80" />
              <div className="absolute inset-0 bg-blue-500/10 blur-xl rounded-full pointer-events-none" />
            </div>

            <h3 className={`text-xl font-medium mb-3 tracking-tight ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
              准备就绪
            </h3>
            <p className="text-slate-500 text-center max-w-sm leading-relaxed text-sm">
              从左侧选择一个项目以启动终端
            </p>
            <div className="mt-4">
              <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-slate-400 border transition-colors cursor-pointer ${
                isDark ? 'bg-white/5 border-white/5' : 'bg-white/50 border-white/40 shadow-sm'
              }`}>
                <Command className="w-3 h-3" />
                <span>K</span>
              </span>
              <span className="mx-2 text-slate-500 text-sm">to search</span>
            </div>
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
    </div>
  );
}
