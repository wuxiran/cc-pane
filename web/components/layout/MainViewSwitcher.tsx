// 主内容区视图切换：收拢 useActivityBarStore 的全部 appViewMode 分支。
// keep-alive 语义：每个视图首次访问时挂载，之后用 display:none 隐藏——切换是纯
// display 翻转，不重建视图树（尤其终端 xterm），与布局切换器对非当前布局的处理同模式。
// 终端在隐藏期间保持挂载；重新显示时 TerminalView 的 ResizeObserver 负责 refit。
import { useEffect, useState } from "react";
import Sidebar from "@/components/Sidebar";
import SidebarTransition from "@/components/layout/SidebarTransition";
import { PaneContainer } from "@/components/panes";
import StarredPanel from "@/components/panes/StarredPanel";
import DndPaneProvider from "@/components/panes/DndPaneProvider";
import { FileEditorPanel } from "@/components/editor";
import TodoManager from "@/components/todo/TodoManager";
import { SelfChatManager } from "@/components/selfchat";
import { HomeDashboard } from "@/components/home";
import { ProvidersPanel } from "@/components/providers";
import ResourceHub from "@/components/resources/ResourceHub";
import OrchestrationOverlay from "@/components/orchestration/OrchestrationOverlay";
import { LayoutVisibilityContext } from "@/contexts/LayoutVisibilityContext";
import { usePanesStore, useActivityBarStore, type AppViewMode } from "@/stores";
import type { OpenTerminalOptions } from "@/types";

interface MainViewSwitcherProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

export default function MainViewSwitcher({ onOpenTerminal }: MainViewSwitcherProps) {
  const rootPane = usePanesStore((s) => s.rootPane);
  const layouts = usePanesStore((s) => s.layouts);
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);

  const sidebarVisible = useActivityBarStore((s) => s.sidebarVisible);
  const activeView = useActivityBarStore((s) => s.activeView);
  const appViewMode = useActivityBarStore((s) => s.appViewMode);
  const orchestrationOverlayOpen = useActivityBarStore((s) => s.orchestrationOverlayOpen);
  const closeOrchestrationOverlay = useActivityBarStore((s) => s.closeOrchestrationOverlay);

  const showOrchestrationOverlay =
    orchestrationOverlayOpen ||
    appViewMode === "orchestration" ||
    (activeView === "orchestration" && sidebarVisible);
  // orchestration 是"panes + overlay"的兼容态，不是独立全屏视图
  const effectiveAppViewMode = appViewMode === "orchestration" ? "panes" : appViewMode;
  // Sidebar 只属于 panes / files 两种模式
  const shouldShowSidebar =
    sidebarVisible &&
    activeView !== "orchestration" &&
    (effectiveAppViewMode === "panes" || effectiveAppViewMode === "files");

  // keep-alive：记录访问过的模式；未访问过的不挂载（保持启动开销不变）
  const [visited, setVisited] = useState<ReadonlySet<AppViewMode>>(
    () => new Set([effectiveAppViewMode]),
  );
  useEffect(() => {
    setVisited((prev) => {
      if (prev.has(effectiveAppViewMode)) return prev;
      const next = new Set(prev);
      next.add(effectiveAppViewMode);
      return next;
    });
  }, [effectiveAppViewMode]);

  const isActive = (mode: AppViewMode) => effectiveAppViewMode === mode;
  // 首次切入时 visited 尚未含当前模式（effect 晚一拍），用 isActive 兜底立即挂载
  const isMounted = (mode: AppViewMode) => visited.has(mode) || isActive(mode);
  const viewStyle = (mode: AppViewMode): React.CSSProperties | undefined =>
    isActive(mode) ? undefined : { display: "none" };

  return (
    <>
      {/* 侧边栏（panes/files 共用同一实例，activeView 驱动内容；过渡结束后卸载） */}
      <SidebarTransition visible={shouldShowSidebar}>
        <Sidebar
          activeView={activeView}
          onOpenTerminal={onOpenTerminal}
        />
      </SidebarTransition>

      {/* 首页仪表盘 */}
      {isMounted("home") && (
        <div className="flex-1 overflow-hidden" style={viewStyle("home")}>
          <HomeDashboard onOpenTerminal={onOpenTerminal} />
        </div>
      )}
      {/* Todo 全屏模式 */}
      {isMounted("todo") && (
        <div className="flex-1 overflow-hidden" style={viewStyle("todo")}>
          <TodoManager scope="" scopeRef="" />
        </div>
      )}
      {/* Self-Chat 全屏模式 */}
      {isMounted("selfchat") && (
        <div className="flex-1 overflow-hidden" style={viewStyle("selfchat")}>
          <SelfChatManager />
        </div>
      )}
      {/* Providers 全屏模式（旧入口，保留兼容） */}
      {isMounted("providers") && (
        <div className="flex-1 overflow-hidden" style={viewStyle("providers")}>
          <ProvidersPanel />
        </div>
      )}
      {/* 资源中心：Provider / Skills / MCP 三合一大页面 */}
      {isMounted("resources") && (
        <div className="flex-1 overflow-hidden" style={viewStyle("resources")}>
          <ResourceHub />
        </div>
      )}
      {/* Files 模式：文件编辑面板（侧边栏文件浏览器在上方共用 Sidebar） */}
      {isMounted("files") && (
        <div
          className="flex-1 overflow-hidden"
          style={{ background: "var(--app-panel-bg)", ...viewStyle("files") }}
        >
          <FileEditorPanel />
        </div>
      )}
      {/* 面板区域（终端）：keep-alive 关键区——隐藏不卸载，切回即恢复 */}
      {isMounted("panes") && (
        <div
          className="flex-1 overflow-hidden"
          style={{ background: "var(--app-panel-bg)", ...viewStyle("panes") }}
        >
          <DndPaneProvider>
            {layouts.map((layout) => {
              const isCurrent = layout.id === currentLayoutId;
              return (
                <LayoutVisibilityContext.Provider key={layout.id} value={isCurrent && isActive("panes")}>
                  <div
                    className="h-full w-full"
                    style={{ display: isCurrent ? "block" : "none" }}
                  >
                    {layout.kind === "starred" ? (
                      <StarredPanel />
                    ) : (
                      <PaneContainer pane={isCurrent ? rootPane : layout.rootPane} />
                    )}
                  </div>
                </LayoutVisibilityContext.Provider>
              );
            })}
          </DndPaneProvider>
        </div>
      )}
      {showOrchestrationOverlay && (
        <OrchestrationOverlay onClose={closeOrchestrationOverlay} />
      )}
    </>
  );
}
