// 主内容区视图切换：收拢 useActivityBarStore 的全部 appViewMode 分支。
// keep-alive 语义：每个视图首次访问时挂载，之后固定在同一舞台上，仅切换 opacity。
// 视图树（尤其终端 xterm）不会重建；重新显示时 TerminalView 的 ResizeObserver 负责 refit。
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { useCanvasDisplayStore, usePanesStore, useActivityBarStore, useLayoutUiStore, useWallpaperStore, useThemeStore, type AppViewMode } from "@/stores";
import type { OpenTerminalOptions } from "@/types";
import type { MediaStudioKind } from "@/stores/useMediaStudioStore";

// Keep the media workspace out of the initial terminal module graph. Besides
// reducing startup work, this lets the existing terminal-only test doubles and
// lightweight web deployments omit media-specific dependencies until opened.
const MediaStudio = lazy(() => import("@/components/media/MediaStudio"));

interface MainViewSwitcherProps {
  onOpenTerminal: (opts: OpenTerminalOptions) => void;
}

// 壁纸激活时的面板底：不透明面板色保留 62%，只留 38% 透出壁纸。全透明会让亮色
// 壁纸直接垫在终端文字下（对比度崩塌）；62% 既能恢复一层「面板深度」垫住文字，
// 又不至于把壁纸遮得几乎看不见。同思路先例：空态磨砂垫底（emptyStateShared）。
const WALLPAPER_PANEL_BG_EFFECTIVE_DARK =
  "color-mix(in srgb, var(--app-panel-bg) 62%, transparent)";
// 浅色主题面板底是近白，同一浓度会把高对比壁纸洗成一层米色残影（实机走查结论），
// 提浓到 80% 让壁纸退成隐约纹理、维持浅色应有的干净表面。
const WALLPAPER_PANEL_BG_EFFECTIVE_LIGHT =
  "color-mix(in srgb, var(--app-panel-bg) 80%, transparent)";

export default function MainViewSwitcher({ onOpenTerminal }: MainViewSwitcherProps) {
  const { t: mediaT } = useTranslation("media");
  const rootPane = usePanesStore((s) => s.rootPane);
  const layouts = usePanesStore((s) => s.layouts);
  const currentLayoutId = usePanesStore((s) => s.currentLayoutId);

  const layoutSwitcherMode = useLayoutUiStore((s) => s.switcherMode);
  const canvasDisplayMode = useCanvasDisplayStore((s) => s.mode);
  const sidebarVisible = useActivityBarStore((s) => s.sidebarVisible);
  const isDark = useThemeStore((s) => s.isDark);
  const activeView = useActivityBarStore((s) => s.activeView);
  const appViewMode = useActivityBarStore((s) => s.appViewMode);
  const setAppViewMode = useActivityBarStore((s) => s.setAppViewMode);
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
  const mediaActive = effectiveAppViewMode === "imageGen" || effectiveAppViewMode === "videoGen";
  const mediaKind: MediaStudioKind = effectiveAppViewMode === "videoGen" ? "video" : "image";
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
  // All visited views share one fixed stage. Inactive views stay mounted and
  // are absolutely positioned, so switching modules only animates opacity and
  // never changes the flex dimensions observed by xterm.
  const viewStyle = (mode: AppViewMode): React.CSSProperties => {
    const active = isActive(mode);
    return {
      opacity: active ? 1 : 0,
      pointerEvents: active ? "auto" : "none",
      zIndex: active ? 1 : 0,
    };
  };
  const mediaMounted = isMounted("imageGen") || isMounted("videoGen");
  const mediaStyle = (): React.CSSProperties => ({
    opacity: mediaActive ? 1 : 0,
    pointerEvents: mediaActive ? "auto" : "none",
    zIndex: mediaActive ? 1 : 0,
  });

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

      <main className="relative min-h-0 min-w-0 flex-1 overflow-hidden" data-main-view-stage>
      {/* 首页仪表盘 */}
      {isMounted("home") && (
        <div
          className="main-view-layer absolute inset-0 overflow-hidden"
          data-main-view="home"
          aria-hidden={!isActive("home")}
          style={viewStyle("home")}
        >
          <HomeDashboard onOpenTerminal={onOpenTerminal} />
        </div>
      )}
      {/* Todo 主内容；任务列表由上方共享侧栏承载。 */}
      {isMounted("todo") && (
        <div
          className="main-view-layer absolute inset-0 overflow-hidden"
          data-main-view="todo"
          aria-hidden={!isActive("todo")}
          style={{ background: "var(--app-panel-bg)", ...viewStyle("todo") }}
        >
          {todoContent}
        </div>
      )}
      {/* Self-Chat 全屏模式 */}
      {isMounted("selfchat") && (
        <div
          className="main-view-layer absolute inset-0 overflow-hidden"
          data-main-view="selfchat"
          aria-hidden={!isActive("selfchat")}
          style={viewStyle("selfchat")}
        >
          <SelfChatManager />
        </div>
      )}
      {/* Providers 全屏模式（旧入口，保留兼容） */}
      {isMounted("providers") && (
        <div
          className="main-view-layer absolute inset-0 overflow-hidden"
          data-main-view="providers"
          aria-hidden={!isActive("providers")}
          style={viewStyle("providers")}
        >
          <ProvidersPanel />
        </div>
      )}
      {/* 生图与生视频共用一个媒体工作区；类型切换只替换工作区内部的表单。 */}
      {mediaMounted && (
        <div
          className="main-view-layer absolute inset-0 flex min-w-0 overflow-hidden"
          data-main-view="media"
          data-testid="media-workspace-shell"
          aria-hidden={!mediaActive}
          style={mediaStyle()}
        >
          <Suspense fallback={<div className="flex h-full w-full items-center justify-center text-xs" style={{ color: "var(--app-text-tertiary)" }}>{mediaT("loadingMediaWorkspace")}</div>}>
            <MediaStudio
              kind={mediaKind}
              onKindChange={(nextKind) => setAppViewMode(nextKind === "image" ? "imageGen" : "videoGen")}
            />
          </Suspense>
        </div>
      )}
      {/* Files 模式：文件编辑面板（侧边栏文件浏览器在上方共用 Sidebar） */}
      {isMounted("files") && (
        <div
          className="main-view-layer absolute inset-0 overflow-hidden"
          data-main-view="files"
          aria-hidden={!isActive("files")}
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
          className="main-view-layer absolute inset-0 flex flex-col overflow-hidden"
          data-main-view="panes"
          aria-hidden={!isActive("panes")}
          style={{
            background: "var(--app-panel-bg)",
            ...(wallpaperActive
              ? ({
                  // 半透明垫层而非全透明：见 WALLPAPER_PANEL_BG_EFFECTIVE_* 注释。
                  "--app-panel-bg-effective": isDark
                    ? WALLPAPER_PANEL_BG_EFFECTIVE_DARK
                    : WALLPAPER_PANEL_BG_EFFECTIVE_LIGHT,
                  // 面板底一透，面板自己的 backdrop-filter 就直接糊在壁纸上——
                  // 壁纸的 blur 滑杆管不到这层，暗色主题默认 12px 会把视频糊没。
                  // 壁纸激活时由壁纸设置接管该 token（默认 8 = 轻磨砂垫层）。
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
      </main>
      {showOrchestrationOverlay && (
        <OrchestrationOverlay onClose={closeOrchestrationOverlay} />
      )}
        </>
      )}
    </TodoManager>
  );
}
