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
import OrchestrationOverlay from "@/components/orchestration/OrchestrationOverlay";
import PaneFlowOverlay from "@/components/canvas/PaneFlowOverlay";
import { LayoutVisibilityContext } from "@/contexts/LayoutVisibilityContext";
import LayoutTopBar from "@/components/layoutbar/LayoutTopBar";
import MainWallpaperLayer from "@/components/layout/MainWallpaperLayer";
import { useCanvasDisplayStore, usePanesStore, useActivityBarStore, useLayoutUiStore, useWallpaperStore, type AppViewMode } from "@/stores";
import type { OpenTerminalOptions } from "@/types";

interface MainViewSwitcherProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

export default function MainViewSwitcher({ onOpenTerminal }: MainViewSwitcherProps) {
  const rootPane = usePanesStore((s) => s.rootPane);
  const layouts = usePanesStore((s) => s.layouts);
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);

  const layoutSwitcherMode = useLayoutUiStore((s) => s.switcherMode);
  const canvasDisplayMode = useCanvasDisplayStore((s) => s.mode);
  const sidebarVisible = useActivityBarStore((s) => s.sidebarVisible);
  const activeView = useActivityBarStore((s) => s.activeView);
  const appViewMode = useActivityBarStore((s) => s.appViewMode);
  const orchestrationOverlayOpen = useActivityBarStore((s) => s.orchestrationOverlayOpen);
  const closeOrchestrationOverlay = useActivityBarStore((s) => s.closeOrchestrationOverlay);
  // 原子字段 selector（布尔），不在 selector 里做对象解析
  const wallpaperActive = useWallpaperStore((s) => s.resolved !== null && s.assetUrl !== null);
  const wallpaperGlassBlur = useWallpaperStore((s) => s.resolved?.glassBlur ?? 0);

  const showOrchestrationOverlay =
    orchestrationOverlayOpen ||
    appViewMode === "orchestration" ||
    (activeView === "orchestration" && sidebarVisible);
  // orchestration 是"panes + overlay"的兼容态，不是独立全屏视图
  const effectiveAppViewMode = appViewMode === "orchestration" ? "panes" : appViewMode;
  // Todo 与 panes/files 共用同一个侧栏过渡容器，切换模块时宽度保持稳定。
  const shouldShowSidebar =
    sidebarVisible &&
    activeView !== "orchestration" &&
    (effectiveAppViewMode === "panes"
      || effectiveAppViewMode === "files"
      || effectiveAppViewMode === "todo");

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
    <TodoManager scope="" scopeRef="" enabled={isMounted("todo")}>
      {({ sidebar: todoSidebar, content: todoContent }) => (
        <>
      {/* panes/files/todo 共用同一侧栏实例，模块切换不会触发不同的进出场动画。 */}
      <SidebarTransition visible={shouldShowSidebar}>
        {isActive("todo") ? todoSidebar : (
          <Sidebar
            activeView={activeView}
            onOpenTerminal={onOpenTerminal}
          />
        )}
      </SidebarTransition>

      {/* 首页仪表盘 */}
      {isMounted("home") && (
        <div className="flex-1 overflow-hidden" style={viewStyle("home")}>
          <HomeDashboard onOpenTerminal={onOpenTerminal} />
        </div>
      )}
      {/* Todo 主内容；任务列表由上方共享侧栏承载。 */}
      {isMounted("todo") && (
        <div
          className="flex-1 overflow-hidden"
          style={{ background: "var(--app-panel-bg)", ...viewStyle("todo") }}
        >
          {todoContent}
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
      {/* Files 模式：文件编辑面板（侧边栏文件浏览器在上方共用 Sidebar） */}
      {isMounted("files") && (
        <div
          className="flex-1 overflow-hidden"
          style={{ background: "var(--app-panel-bg)", ...viewStyle("files") }}
        >
          <FileEditorPanel />
        </div>
      )}
      {/* 面板区域（终端）：keep-alive 关键区——隐藏不卸载，切回即恢复。
          壁纸激活时仅在此根节点覆盖 effective token（不动 :root，不污染 files 等视图），
          子树内画底的位置读 --app-panel-bg-effective 即透出壁纸层。 */}
      {isMounted("panes") && (
        <div
          className="relative flex flex-1 flex-col overflow-hidden"
          style={{
            background: "var(--app-panel-bg)",
            ...(wallpaperActive
              ? ({
                  "--app-panel-bg-effective": "transparent",
                  // 面板背景一透明，它自己的 backdrop-filter 就直接糊在壁纸上——
                  // 壁纸的 blur 滑杆管不到这层，默认 12px 会把视频糊没。
                  // 壁纸激活时由壁纸设置接管该 token（默认 0 = 不叠）。
                  "--app-glass-blur": `${wallpaperGlassBlur}px`,
                } as React.CSSProperties)
              : null),
            ...viewStyle("panes"),
          }}
        >
          <MainWallpaperLayer />
          {/* DndPaneProvider 必须同时包住布局条与面板区：dnd-kit 的碰撞检测只在
              同一个 DndContext 的 droppable registry 内做，布局条若在 context 外
              就永远接不到从面板区拖来的 tab。DndContext 不渲染 DOM 节点，flex
              布局不受影响。 */}
          <DndPaneProvider>
            {/* 布局条模式：标签上方多一层布局层（corner 模式下仍走左下角 LayoutBar）。
                抬到 z-[1]：壁纸层是 positioned z-0，静态流内容会被它盖住 */}
            {layoutSwitcherMode === "topbar" && (
              <div className="relative z-[1] shrink-0">
                <LayoutTopBar />
              </div>
            )}
            <div className="relative z-[1] min-h-0 flex-1 overflow-hidden">
              <div
                className="h-full w-full"
                style={{ display: canvasDisplayMode === "panel" ? "block" : "none" }}
                data-terminal-layout-view
              >
                {layouts.map((layout) => {
                  const isCurrent = layout.id === currentLayoutId;
                  return (
                    <LayoutVisibilityContext.Provider key={layout.id} value={isCurrent && isActive("panes") && canvasDisplayMode === "panel"}>
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
              </div>
              <div
                className="h-full w-full"
                style={{ display: canvasDisplayMode === "canvas" ? "block" : "none" }}
                data-terminal-canvas-view
              >
                <PaneFlowOverlay />
              </div>
            </div>
          </DndPaneProvider>
        </div>
      )}
      {showOrchestrationOverlay && (
        <OrchestrationOverlay onClose={closeOrchestrationOverlay} />
      )}
        </>
      )}
    </TodoManager>
  );
}
