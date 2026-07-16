// 主内容区视图切换：收拢 useActivityBarStore 的全部 appViewMode 分支。
// 切换语义为"卸载重建"（切走即卸载 panes），终端保活属独立生命周期变更，勿在此改动。
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
import { usePanesStore, useActivityBarStore } from "@/stores";
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
  const shouldShowSidebar = sidebarVisible && activeView !== "orchestration";

  return (
    <>
      {effectiveAppViewMode === "home" ? (
        /* 首页仪表盘：占满 ActivityBar 右侧所有空间 */
        <div className="flex-1 overflow-hidden">
          <HomeDashboard onOpenTerminal={onOpenTerminal} />
        </div>
      ) : effectiveAppViewMode === "todo" ? (
        /* Todo 全屏模式：占满 ActivityBar 右侧所有空间 */
        <div className="flex-1 overflow-hidden">
          <TodoManager scope="" scopeRef="" />
        </div>
      ) : effectiveAppViewMode === "selfchat" ? (
        /* Self-Chat 全屏模式 */
        <div className="flex-1 overflow-hidden">
          <SelfChatManager />
        </div>
      ) : effectiveAppViewMode === "providers" ? (
        /* Providers 全屏模式（旧入口，保留兼容） */
        <div className="flex-1 overflow-hidden">
          <ProvidersPanel />
        </div>
      ) : effectiveAppViewMode === "resources" ? (
        /* 资源中心：Provider / Skills / MCP 三合一大页面 */
        <div className="flex-1 overflow-hidden">
          <ResourceHub />
        </div>
      ) : effectiveAppViewMode === "files" ? (
        /* Files 模式：侧边栏（文件浏览器）+ 文件编辑面板 */
        <>
          <SidebarTransition visible={shouldShowSidebar}>
            <Sidebar
              activeView={activeView}
              onOpenTerminal={onOpenTerminal}
            />
          </SidebarTransition>
          <div className="flex-1 overflow-hidden" style={{ background: "var(--app-panel-bg)" }}>
            <FileEditorPanel />
          </div>
        </>
      ) : (
        <>
          {/* 侧边栏（过渡结束后卸载） */}
          <SidebarTransition visible={shouldShowSidebar}>
            <Sidebar
              activeView={activeView}
              onOpenTerminal={onOpenTerminal}
            />
          </SidebarTransition>
          {/* 面板区域 */}
          <div className="flex-1 overflow-hidden" style={{ background: "var(--app-panel-bg)" }}>
            <DndPaneProvider>
              {layouts.map((layout) => {
                const isCurrent = layout.id === currentLayoutId;
                return (
                  <LayoutVisibilityContext.Provider key={layout.id} value={isCurrent}>
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
        </>
      )}
      {showOrchestrationOverlay && (
        <OrchestrationOverlay onClose={closeOrchestrationOverlay} />
      )}
    </>
  );
}
